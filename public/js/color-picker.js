import { clamp, hexToRgb, rgbToHex, rgbToHsv, hsvToRgb, storage } from './util.js';

const PRESETS = [
  '#000000', '#7f7f7f', '#c3c3c3', '#ffffff', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#22b14c', '#00a2e8',
  '#3f48cc', '#a349a4', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7',
];
const RECENT_KEY = 'paint.recentColors';
const CHANNELS = ['r', 'g', 'b'];

// 色盤：飽和度/明度方塊 + 色相條 + RGB 滑桿與數字 + HEX + 常用色 + 最近使用
export class ColorPicker {
  constructor(root, { color = '#000000', onChange } = {}) {
    this.root = root;
    this.onChange = onChange;
    this.recent = storage.get(RECENT_KEY, []).filter((c) => hexToRgb(c));

    root.classList.add('cp');
    root.innerHTML = `
      <div class="cp-sv"><div class="cp-sv-thumb"></div></div>
      <div class="cp-hue"><div class="cp-hue-thumb"></div></div>
      <div class="cp-current">
        <div class="cp-preview" title="目前顏色"></div>
        <label class="cp-hex"><span>HEX</span><input maxlength="7" spellcheck="false" autocomplete="off"></label>
      </div>
      <div class="cp-rgb">
        ${CHANNELS.map(
          (ch) => `
          <label class="cp-row" data-ch="${ch}">
            <span class="cp-ch">${ch.toUpperCase()}</span>
            <input type="range" min="0" max="255" step="1">
            <input type="number" min="0" max="255" step="1" inputmode="numeric">
          </label>`
        ).join('')}
      </div>
      <div class="cp-sub">常用色</div>
      <div class="cp-swatches cp-presets"></div>
      <div class="cp-sub cp-recent-title">最近使用</div>
      <div class="cp-swatches cp-recent"></div>`;

    this.svEl = root.querySelector('.cp-sv');
    this.svThumb = root.querySelector('.cp-sv-thumb');
    this.hueEl = root.querySelector('.cp-hue');
    this.hueThumb = root.querySelector('.cp-hue-thumb');
    this.preview = root.querySelector('.cp-preview');
    this.hexInput = root.querySelector('.cp-hex input');
    this.rows = Object.fromEntries(
      CHANNELS.map((ch) => {
        const row = root.querySelector(`.cp-row[data-ch="${ch}"]`);
        return [ch, { range: row.querySelector('input[type=range]'), num: row.querySelector('input[type=number]') }];
      })
    );

    this.renderSwatches(root.querySelector('.cp-presets'), PRESETS);
    this.renderRecent();
    this.bind();
    this.setColor(color, { silent: true });
  }

  get hex() {
    return rgbToHex(this.rgb);
  }

  setColor(hex, { silent = false } = {}) {
    const rgb = hexToRgb(hex);
    if (rgb) this.setRgb(rgb, { silent });
  }

  setRgb(rgb, { silent = false, skip = null } = {}) {
    this.rgb = { ...rgb };
    const hsv = rgbToHsv(rgb);
    // 灰階時色相沒有意義，保留原本的色相，方塊才不會跳回紅色
    if (this.hsv && hsv.s === 0) hsv.h = this.hsv.h;
    if (this.hsv && hsv.v === 0) {
      hsv.h = this.hsv.h;
      hsv.s = this.hsv.s;
    }
    this.hsv = hsv;
    this.render(skip);
    if (!silent) this.onChange?.(this.hex);
  }

  setHsv(hsv) {
    this.hsv = hsv;
    this.rgb = hsvToRgb(hsv);
    this.render();
    this.onChange?.(this.hex);
  }

  addRecent(hex) {
    hex = hex.toLowerCase();
    if (this.recent[0] === hex) return;
    this.recent = [hex, ...this.recent.filter((c) => c !== hex)].slice(0, 10);
    storage.set(RECENT_KEY, this.recent);
    this.renderRecent();
  }

  // ---------- 內部 ----------
  bind() {
    this.dragArea(this.svEl, (fx, fy) => this.setHsv({ ...this.hsv, s: fx, v: 1 - fy }));
    this.dragArea(this.hueEl, (fx) => this.setHsv({ ...this.hsv, h: Math.min(fx * 360, 359.9) }));

    for (const ch of CHANNELS) {
      const { range, num } = this.rows[ch];
      range.addEventListener('input', () => this.setRgb({ ...this.rgb, [ch]: Number(range.value) }));
      num.addEventListener('input', () => {
        if (num.value === '') return;
        const v = Number(num.value);
        if (Number.isFinite(v)) this.setRgb({ ...this.rgb, [ch]: clamp(Math.round(v), 0, 255) }, { skip: num });
      });
      num.addEventListener('change', () => this.render());
    }

    this.hexInput.addEventListener('input', () => {
      const rgb = /^#?[0-9a-f]{6}$/i.test(this.hexInput.value.trim()) && hexToRgb(this.hexInput.value);
      if (rgb) this.setRgb(rgb, { skip: this.hexInput });
    });
    this.hexInput.addEventListener('change', () => {
      const rgb = hexToRgb(this.hexInput.value);
      if (rgb) this.setRgb(rgb);
      else this.render();
    });

    this.root.addEventListener('click', (e) => {
      const sw = e.target.closest('.cp-swatch');
      if (sw) this.setColor(sw.dataset.color);
    });
  }

  dragArea(el, onMove) {
    const update = (e) => {
      const r = el.getBoundingClientRect();
      onMove(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      update(e);
    });
    el.addEventListener('pointermove', (e) => {
      if (el.hasPointerCapture(e.pointerId)) update(e);
    });
  }

  render(skip = null) {
    const { h, s, v } = this.hsv;
    const { r, g, b } = this.rgb;
    const hex = this.hex;

    this.svEl.style.setProperty('--hue', `hsl(${h} 100% 50%)`);
    this.svThumb.style.left = `${s * 100}%`;
    this.svThumb.style.top = `${(1 - v) * 100}%`;
    this.svThumb.style.background = hex;
    this.hueThumb.style.left = `${(h / 360) * 100}%`;
    this.hueThumb.style.background = `hsl(${h} 100% 50%)`;
    this.preview.style.background = hex;
    if (skip !== this.hexInput) this.hexInput.value = hex.toUpperCase();

    const tracks = {
      r: [`rgb(0 ${g} ${b})`, `rgb(255 ${g} ${b})`],
      g: [`rgb(${r} 0 ${b})`, `rgb(${r} 255 ${b})`],
      b: [`rgb(${r} ${g} 0)`, `rgb(${r} ${g} 255)`],
    };
    for (const ch of CHANNELS) {
      const { range, num } = this.rows[ch];
      range.value = this.rgb[ch];
      range.style.setProperty('--track', `linear-gradient(to right, ${tracks[ch][0]}, ${tracks[ch][1]})`);
      if (skip !== num) num.value = this.rgb[ch];
    }

    for (const sw of this.root.querySelectorAll('.cp-swatch')) {
      sw.classList.toggle('active', sw.dataset.color === hex);
    }
  }

  renderSwatches(container, colors) {
    container.innerHTML = '';
    for (const c of colors) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cp-swatch';
      btn.dataset.color = c;
      btn.title = c.toUpperCase();
      btn.style.background = c;
      container.append(btn);
    }
  }

  renderRecent() {
    const box = this.root.querySelector('.cp-recent');
    this.root.querySelector('.cp-recent-title').hidden = box.hidden = !this.recent.length;
    this.renderSwatches(box, this.recent);
    if (this.rgb) this.render();
  }
}
