import { clamp, rgbToHex, uid } from './util.js';

const MAX_STROKE_NUMBERS = 19000; // 略低於伺服器上限，超過就自動接成下一筆
const MAX_NUMBERS_PER_MESSAGE = 4000;
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
  constructor(stage, { width, height, onStrokeStart, onStrokeMove, onStrokeEnd, onPick }) {
    this.stage = stage;
    this.width = width;
    this.height = height;
    this.cb = { onStrokeStart, onStrokeMove, onStrokeEnd, onPick };

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
    this.scale = 1;
    this.needFull = false;
    this.raf = 0;

    this.live.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.live.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.live.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.live.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.live.addEventListener('pointerleave', () => this.cursor.classList.remove('visible'));
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

  fit() {
    const pad = window.innerWidth < 820 ? 8 : 24;
    const sw = this.stage.clientWidth - pad * 2;
    const sh = this.stage.clientHeight - pad * 2;
    if (sw <= 0 || sh <= 0) return;
    this.scale = Math.min(sw / this.width, sh / this.height);
    this.el.style.width = `${Math.floor(this.width * this.scale)}px`;
    this.el.style.height = `${Math.floor(this.height * this.scale)}px`;
    this.updateCursor();
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
    if (e.pointerType === 'touch' || this.tool === 'picker' || !this.enabled) {
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
