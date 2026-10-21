import { clamp, rgbToHex, uid } from './util.js';

const MAX_STROKE_NUMBERS = 19000; // 略低於伺服器上限，超過就自動接成下一筆
const MAX_NUMBERS_PER_MESSAGE = 4000;
const MAX_ZOOM = 12; // 最多放大到「符合畫面」的 12 倍
const round1 = (n) => Math.round(n * 10) / 10;

export function drawStroke(ctx, op) {
  const p = op.pts;
  if (!p || p.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = op.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.globalAlpha = op.tool === 'eraser' ? 1 : op.opacity;
  ctx.strokeStyle = ctx.fillStyle = op.color;
  ctx.lineWidth = op.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  if (p.length === 2) {
    ctx.arc(p[0], p[1], op.size / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // 用中點二次曲線讓線條平滑
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) {
      ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    }
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
    ctx.stroke();
  }
  ctx.restore();
}

// 畫布（由下到上）：
//  bg   圖層 = 背景圖（最後一個 background 操作），橡皮擦擦不到
//  main 圖層 = 已完成的筆畫與圖片（依序重播 ops），橡皮擦擦掉的地方會露出 bg
//  live 圖層 = 還在畫的筆畫（自己的和別人的），放開後才「定稿」到 main
export class Board {
  constructor(stage, { width, height, onStrokeStart, onStrokeMove, onStrokeEnd, onStrokeCancel, onPick, onZoom }) {
    this.stage = stage;
    this.width = width;
    this.height = height;
    this.cb = { onStrokeStart, onStrokeMove, onStrokeEnd, onStrokeCancel, onPick, onZoom };

    this.el = document.createElement('div');
    this.el.className = 'board';
    this.bg = this.makeCanvas('bg');
    this.main = this.makeCanvas('main');
    this.live = this.makeCanvas('live');
    this.cursor = document.createElement('div');
    this.cursor.className = 'brush-cursor';
    this.el.append(this.bg, this.main, this.live, this.cursor);
    stage.append(this.el);
    this.bgCtx = this.bg.getContext('2d');
    this.mainCtx = this.main.getContext('2d');
    this.liveCtx = this.live.getContext('2d');

    this.ops = [];
    this.liveStrokes = new Map(); // id -> op
    this.images = new Map(); // op.id -> HTMLImageElement
    this.drawing = null; // 自己正在畫的筆畫
    this.placing = null; // 正在擺放的圖片
    this.enabled = true;
    this.tool = 'pen';
    this.color = '#000000';
    this.size = 6;
    this.opacity = 1;
    this.needFull = false;
    this.raf = 0;

    // 檢視：scale = 每個畫布像素在螢幕上幾個 CSS 像素 = fitScale × zoom
    // (ox, oy) = 畫布左上角在 stage 裡的位置
    this.fitScale = 0;
    this.zoom = 1;
    this.scale = 1;
    this.ox = 0;
    this.oy = 0;
    this.pan = null; // 拖曳移動畫面中
    this.panKey = false; // 按住空白鍵
    this.touches = new Map(); // pointerId -> {x, y}，用來做兩指縮放
    this.pinch = null;

    this.live.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.live.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.live.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.live.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.live.addEventListener('pointerleave', () => this.cursor.classList.remove('visible'));
    this.bindView();
    new ResizeObserver(() => this.fit()).observe(stage);
    this.fit();
  }

  makeCanvas(name) {
    const c = document.createElement('canvas');
    c.className = `layer ${name}`;
    c.width = this.width;
    c.height = this.height;
    return c;
  }

  // ---------- 縮放與移動畫面 ----------
  pad() {
    return window.innerWidth < 820 ? 8 : 24;
  }

  // 畫面大小改變時重算「符合畫面」的比例，並保持畫面中央看的位置不變
  fit() {
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    if (sw <= 0 || sh <= 0) return;
    const pad = this.pad();
    const lx = this.fitScale ? (this.stageW / 2 - this.ox) / this.scale : this.width / 2;
    const ly = this.fitScale ? (this.stageH / 2 - this.oy) / this.scale : this.height / 2;
    this.fitScale = Math.max(0.01, Math.min((sw - pad * 2) / this.width, (sh - pad * 2) / this.height));
    this.scale = this.fitScale * this.zoom;
    this.stageW = sw;
    this.stageH = sh;
    this.ox = sw / 2 - lx * this.scale;
    this.oy = sh / 2 - ly * this.scale;
    this.layout();
  }

  // 以 stage 裡的 (cx, cy) 為中心縮放（預設是畫面正中央）
  zoomTo(zoom, cx = this.stageW / 2, cy = this.stageH / 2) {
    zoom = clamp(zoom, 1, MAX_ZOOM);
    const lx = (cx - this.ox) / this.scale;
    const ly = (cy - this.oy) / this.scale;
    this.zoom = zoom;
    this.scale = this.fitScale * zoom;
    this.ox = cx - lx * this.scale;
    this.oy = cy - ly * this.scale;
    this.layout();
  }

  resetView() {
    this.zoom = 1;
    this.scale = this.fitScale;
    this.layout(true);
  }

  // 套用大小與位置；畫布比畫面小時置中，比畫面大時不能拖到完全看不見
  layout(center = false) {
    const pad = this.pad();
    const bw = this.width * this.scale;
    const bh = this.height * this.scale;
    const place = (o, size, view) => (center || size + pad * 2 <= view ? (view - size) / 2 : clamp(o, view - size - pad, pad));
    this.ox = place(this.ox, bw, this.stageW);
    this.oy = place(this.oy, bh, this.stageH);
    this.el.style.width = `${bw}px`;
    this.el.style.height = `${bh}px`;
    this.el.style.transform = `translate(${this.ox}px, ${this.oy}px)`;
    this.updateCursor();
    this.cb.onZoom?.(this.zoom);
  }

  setPanKey(down) {
    this.panKey = down;
    this.stage.classList.toggle('pan-ready', down);
    if (down) this.cursor.classList.remove('visible');
  }

  stagePoint(e) {
    const r = this.stage.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  bindView() {
    const stage = this.stage;

    // 滾輪縮放（觸控板兩指捏合在瀏覽器裡也是 ctrl + 滾輪，一樣適用）
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const step = e.deltaMode === 1 ? 0.05 : 0.0015; // deltaMode 1 = 以「行」為單位（Firefox）
        this.zoomTo(this.zoom * Math.exp(-e.deltaY * step), ...this.stagePoint(e));
      },
      { passive: false }
    );
    // 中鍵按下時不要出現瀏覽器的自動捲動
    stage.addEventListener('mousedown', (e) => e.button === 1 && e.preventDefault());

    // 用 capture 先攔下：中鍵、空白鍵＋左鍵、在畫布外的灰色區域拖曳 → 移動畫面；兩指 → 縮放
    stage.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target.closest('.place-bar, .zoom-bar, .stage-overlay')) return;
        if (e.pointerType === 'touch') {
          this.touches.set(e.pointerId, this.stagePoint(e));
          if (this.touches.size === 2) {
            e.stopPropagation();
            this.startPinch();
            return;
          }
          if (this.pinch) return e.stopPropagation(); // 兩指縮放後剩下的手指不要畫
        }
        const wantPan = e.button === 1 || (e.button === 0 && (this.panKey || !this.el.contains(e.target)));
        if (!wantPan) return;
        e.preventDefault();
        e.stopPropagation();
        stage.setPointerCapture(e.pointerId);
        this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy };
        stage.classList.add('panning');
      },
      true
    );

    stage.addEventListener(
      'pointermove',
      (e) => {
        if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, this.stagePoint(e));
        if (this.pinch) {
          this.movePinch();
        } else if (this.pan?.id === e.pointerId) {
          this.ox = this.pan.ox + e.clientX - this.pan.x;
          this.oy = this.pan.oy + e.clientY - this.pan.y;
          this.layout();
        }
      },
      true
    );

    const end = (e) => {
      this.touches.delete(e.pointerId);
      if (this.pinch && this.touches.size === 0) this.pinch = null;
      if (this.pan?.id === e.pointerId) {
        this.pan = null;
        stage.classList.remove('panning');
      }
    };
    stage.addEventListener('pointerup', end, true);
    stage.addEventListener('pointercancel', end, true);
  }

  startPinch() {
    this.cancelStroke(); // 第一隻手指剛剛開始的筆畫不算
    this.pan = null;
    this.stage.classList.remove('panning');
    const [a, b] = [...this.touches.values()];
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    this.pinch = {
      dist: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1,
      zoom: this.zoom,
      lx: (mid[0] - this.ox) / this.scale, // 兩指中點下方的畫布座標，縮放時讓它跟著手指走
      ly: (mid[1] - this.oy) / this.scale,
    };
  }

  movePinch() {
    if (this.touches.size < 2) return;
    const [a, b] = [...this.touches.values()];
    const p = this.pinch;
    this.zoom = clamp((p.zoom * Math.hypot(a[0] - b[0], a[1] - b[1])) / p.dist, 1, MAX_ZOOM);
    this.scale = this.fitScale * this.zoom;
    this.ox = (a[0] + b[0]) / 2 - p.lx * this.scale;
    this.oy = (a[1] + b[1]) / 2 - p.ly * this.scale;
    this.layout();
  }

  // ---------- 對外 API ----------
  setTool(tool) {
    if (this.drawing) return;
    this.tool = tool;
    this.el.dataset.tool = tool;
    this.updateCursor();
  }

  setBrush({ color, size, opacity }) {
    if (color !== undefined) this.color = color;
    if (size !== undefined) this.size = size;
    if (opacity !== undefined) this.opacity = opacity;
    this.updateCursor();
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled && this.drawing) {
      const { op } = this.drawing;
      this.drawing = null;
      this.commitLive(op.id);
    }
  }

  load(ops, pending = []) {
    this.drawing = null;
    this.ops = ops;
    this.images.clear();
    this.liveStrokes.clear();
    for (const op of pending) this.liveStrokes.set(op.id, op);
    this.needFull = true;
    this.schedule();
  }

  addOp(op) {
    this.ops.push(op);
    if (op.type === 'background') this.needFull = true;
    else this.drawOp(this.mainCtx, op);
    this.schedule();
  }

  // 下一步：依序號放回原本的圖層位置（還沒拿到序號的筆畫是最新的，排在最後）
  insertOp(op) {
    let i = this.ops.length;
    while (i > 0 && (this.ops[i - 1].seq ?? Infinity) > op.seq) i--;
    this.ops.splice(i, 0, op);
    this.needFull = true;
    this.schedule();
  }

  removeOp(id) {
    const i = this.ops.findIndex((op) => op.id === id);
    if (i === -1) return;
    this.ops.splice(i, 1);
    this.images.delete(id);
    this.needFull = true;
    this.schedule();
  }

  clear() {
    this.ops = [];
    this.images.clear();
    this.needFull = true;
    this.schedule();
  }

  remoteBegin(op) {
    this.liveStrokes.set(op.id, op);
    this.schedule();
  }

  remoteMove(id, pts) {
    const op = this.liveStrokes.get(id);
    if (!op) return;
    op.pts.push(...pts);
    this.schedule();
  }

  remoteEnd(id, seq) {
    const live = this.liveStrokes.get(id);
    if (live) {
      live.seq = seq;
      this.commitLive(id);
      return;
    }
    // 自己畫的筆畫放開時就已經定稿了，這裡只補上伺服器給的序號
    const own = this.ops.findLast((op) => op.id === id);
    if (own) own.seq = seq;
  }

  // 匯出：白底 + 背景 + 畫布內容
  exportBlob() {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(this.bg, 0, 0);
    ctx.drawImage(this.main, 0, 0);
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  // ---------- 繪製 ----------
  schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.frame());
  }

  frame() {
    this.raf = 0;
    if (this.drawing?.outbox.length) this.flushOutbox();
    if (this.needFull) {
      this.needFull = false;
      this.bgCtx.clearRect(0, 0, this.width, this.height);
      const bg = this.ops.findLast((op) => op.type === 'background');
      if (bg) this.drawImageOp(this.bgCtx, bg);
      this.mainCtx.clearRect(0, 0, this.width, this.height);
      for (const op of this.ops) this.drawOp(this.mainCtx, op);
    }
    this.liveCtx.clearRect(0, 0, this.width, this.height);
    for (const op of this.liveStrokes.values()) {
      // 橡皮擦要直接作用在 main 圖層才看得到效果（重複擦同一條路徑結果不變）
      drawStroke(op.tool === 'eraser' ? this.mainCtx : this.liveCtx, op);
    }
  }

  // 背景（background）不畫在 main，而是在重繪時畫到 bg 圖層
  drawOp(ctx, op) {
    if (op.type === 'stroke') drawStroke(ctx, op);
    else if (op.type === 'image') this.drawImageOp(ctx, op);
  }

  drawImageOp(ctx, op) {
    const img = this.getImage(op);
    if (img.complete && img.naturalWidth) ctx.drawImage(img, op.x, op.y, op.w, op.h);
  }

  getImage(op) {
    let img = this.images.get(op.id);
    if (!img) {
      img = new Image();
      img.onload = () => {
        this.needFull = true;
        this.schedule();
      };
      img.src = op.src;
      this.images.set(op.id, img);
    }
    return img;
  }

  commitLive(id) {
    const op = this.liveStrokes.get(id);
    if (!op) return;
    this.liveStrokes.delete(id);
    this.ops.push(op);
    drawStroke(this.mainCtx, op);
    this.schedule();
  }

  // ---------- 滑鼠 / 觸控 / 繪圖板 ----------
  toLogical(e) {
    const r = this.live.getBoundingClientRect();
    return [((e.clientX - r.left) * this.width) / r.width, ((e.clientY - r.top) * this.height) / r.height];
  }

  onPointerDown(e) {
    if (!this.enabled || this.placing || this.drawing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const [x, y] = this.toLogical(e);

    if (this.tool === 'picker') {
      this.cb.onPick?.(this.pickColor(x, y));
      return;
    }
    this.live.setPointerCapture(e.pointerId);
    this.beginStroke(x, y, e.pointerId);
  }

  beginStroke(x, y, pointerId) {
    const eraser = this.tool === 'eraser';
    const op = {
      id: uid(),
      type: 'stroke',
      tool: eraser ? 'eraser' : 'pen',
      color: eraser ? '#000000' : this.color,
      size: this.size,
      opacity: eraser ? 1 : this.opacity,
      pts: [round1(x), round1(y)],
    };
    this.drawing = { op, pointerId, outbox: [] };
    this.liveStrokes.set(op.id, op);
    this.cb.onStrokeStart?.({ ...op, pts: op.pts.slice() });
    this.schedule();
  }

  onPointerMove(e) {
    this.moveCursor(e);
    const d = this.drawing;
    if (!d || e.pointerId !== d.pointerId) return;
    const events = e.getCoalescedEvents?.() || [];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = this.toLogical(ev);
      const p = this.drawing.op.pts;
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < 1) continue;
      p.push(round1(x), round1(y));
      this.drawing.outbox.push(round1(x), round1(y));
      if (p.length >= MAX_STROKE_NUMBERS) {
        // 筆畫太長：結束這一筆並從同一點接續新的一筆
        const pointerId = this.drawing.pointerId;
        this.endStroke();
        this.beginStroke(x, y, pointerId);
      }
    }
    this.schedule();
  }

  onPointerUp(e) {
    if (!this.drawing || e.pointerId !== this.drawing.pointerId) return;
    this.endStroke();
  }

  endStroke() {
    const { op } = this.drawing;
    this.flushOutbox();
    this.drawing = null;
    this.commitLive(op.id);
    this.cb.onStrokeEnd?.(op);
  }

  // 丟掉正在畫的筆畫（例如手機上第二隻手指放下來要縮放）
  cancelStroke() {
    if (!this.drawing) return;
    const { op } = this.drawing;
    this.drawing = null;
    this.dropLive(op.id);
    this.cb.onStrokeCancel?.(op);
  }

  remoteCancel(id) {
    this.dropLive(id);
  }

  dropLive(id) {
    const op = this.liveStrokes.get(id);
    if (!op) return;
    this.liveStrokes.delete(id);
    if (op.tool === 'eraser') this.needFull = true; // 橡皮擦是直接擦在 main 上的，要重畫復原
    this.schedule();
  }

  flushOutbox() {
    const d = this.drawing;
    while (d.outbox.length) {
      this.cb.onStrokeMove?.(d.op.id, d.outbox.splice(0, MAX_NUMBERS_PER_MESSAGE));
    }
  }

  pickColor(x, y) {
    const px = clamp(Math.floor(x), 0, this.width - 1);
    const py = clamp(Math.floor(y), 0, this.height - 1);
    // 取「白底 → 背景 → 畫布」疊起來後看到的顏色
    let color = [255, 255, 255];
    for (const ctx of [this.bgCtx, this.mainCtx]) {
      const [r, g, b, a] = ctx.getImageData(px, py, 1, 1).data;
      const alpha = a / 255;
      color = [r, g, b].map((c, i) => c * alpha + color[i] * (1 - alpha));
    }
    return rgbToHex({ r: color[0], g: color[1], b: color[2] });
  }

  // 圓形筆刷游標（滑鼠才顯示，觸控不需要）
  moveCursor(e) {
    if (e.pointerType === 'touch' || this.tool === 'picker' || !this.enabled || this.panKey || this.pan) {
      this.cursor.classList.remove('visible');
      return;
    }
    const r = this.el.getBoundingClientRect();
    this.cursor.style.transform = `translate(${e.clientX - r.left}px, ${e.clientY - r.top}px)`;
    this.cursor.classList.add('visible');
  }

  updateCursor() {
    const d = Math.max(4, this.size * this.scale);
    this.cursor.style.width = this.cursor.style.height = `${d}px`;
    this.cursor.style.marginLeft = this.cursor.style.marginTop = `${-d / 2}px`;
  }

  // ---------- 擺放上傳的圖片 ----------
  // 回傳 Promise：放上畫布 → {type: 'image', x, y, w, h}（畫布座標）
  //              設為背景 → {type: 'background', ...}（自動符合畫布大小）；取消 → null
  placeImage(img) {
    this.finishPlacing(false);
    const aspect = img.naturalWidth / img.naturalHeight;
    let w = Math.min(img.naturalWidth, this.width * 0.8);
    let h = w / aspect;
    if (h > this.height * 0.8) {
      h = this.height * 0.8;
      w = h * aspect;
    }
    const st = { x: (this.width - w) / 2, y: (this.height - h) / 2, w, h };

    const box = document.createElement('div');
    box.className = 'placer';
    const pic = img.cloneNode();
    pic.draggable = false;
    const handle = document.createElement('div');
    handle.className = 'placer-handle';
    box.append(pic, handle);
    this.el.append(box);

    const apply = () => {
      box.style.left = `${(st.x / this.width) * 100}%`;
      box.style.top = `${(st.y / this.height) * 100}%`;
      box.style.width = `${(st.w / this.width) * 100}%`;
      box.style.height = `${(st.h / this.height) * 100}%`;
    };
    apply();

    let drag = null;
    box.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      const [x, y] = this.toLogical(e);
      drag = { mode: e.target === handle ? 'resize' : 'move', x, y, start: { ...st } };
    });
    box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const [x, y] = this.toLogical(e);
      const dx = x - drag.x;
      const dy = y - drag.y;
      if (drag.mode === 'move') {
        st.x = drag.start.x + dx;
        st.y = drag.start.y + dy;
      } else {
        const grow = Math.abs(dx) > Math.abs(dy * aspect) ? dx : dy * aspect;
        st.w = Math.max(20, drag.start.w + grow);
        st.h = st.w / aspect;
      }
      apply();
    });
    const stop = () => (drag = null);
    box.addEventListener('pointerup', stop);
    box.addEventListener('pointercancel', stop);

    return new Promise((resolve) => {
      this.placing = {
        fit: () => {
          const k = Math.min(this.width / img.naturalWidth, this.height / img.naturalHeight);
          st.w = img.naturalWidth * k;
          st.h = img.naturalHeight * k;
          st.x = (this.width - st.w) / 2;
          st.y = (this.height - st.h) / 2;
          apply();
        },
        done: (mode) => {
          if (mode === 'background') this.placing.fit();
          box.remove();
          this.placing = null;
          resolve(mode ? { type: mode, x: round1(st.x), y: round1(st.y), w: round1(st.w), h: round1(st.h) } : null);
        },
      };
    });
  }

  fitPlacing() {
    this.placing?.fit();
  }

  // mode：'image' 放上畫布、'background' 設為背景、false 取消
  finishPlacing(mode) {
    this.placing?.done(mode);
  }
}
