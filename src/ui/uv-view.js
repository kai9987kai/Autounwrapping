/* UV editor view: 2D canvas with zoom/pan, chart hover/selection, display modes. */
(function (root) {
  'use strict';
  const UVApp = root.UVApp = root.UVApp || {};
  const BINS = 24;

  class UVView {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.listeners = {};
      this.data = null;
      this.style = { mode: 'chart', background: 'grid', texels: false };
      this.bgImage = null;
      this.selected = -1; this.hovered = -1;
      this.view = { s: 1, ox: 0, oy: 0 };
      this.groups = null;
      this.bindEvents();
      this.ro = new ResizeObserver(() => { const had = this.w; this.resize(); if (!had) this.resetView(); else this.draw(); });
      this.ro.observe(canvas.parentElement);
      this.resize();
      this.resetView();
    }

    on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    emit(ev, p) { for (const fn of this.listeners[ev] || []) fn(p); }

    resize() {
      const oldW = this.w, oldH = this.h;
      const dpr = Math.min(root.devicePixelRatio || 1, 2);
      const r = this.canvas.parentElement.getBoundingClientRect();
      this.dpr = dpr; this.w = Math.max(1, r.width); this.h = Math.max(1, r.height);
      this.canvas.width = Math.round(this.w * dpr); this.canvas.height = Math.round(this.h * dpr);
      if (oldW > 0 && oldH > 0 && this.view) {
        const k = Math.min(this.w, this.h) / Math.min(oldW, oldH);
        this.view.s *= k;
        this.view.ox = this.w / 2 + (this.view.ox - oldW / 2) * k;
        this.view.oy = this.h / 2 + (this.view.oy - oldH / 2) * k;
      }
    }

    resetView() {
      const s = 0.9 * Math.min(this.w, this.h);
      this.view = { s, ox: (this.w - s) / 2, oy: (this.h + s) / 2 };
      this.draw();
    }

    zoomTo(rect) {
      if (!rect) return;
      const pad = 1.3, size = Math.max(rect.w, rect.h, 1e-4) * pad;
      const s = Math.min(this.w, this.h) / size;
      const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
      this.view = { s, ox: this.w / 2 - cx * s, oy: this.h / 2 + cy * s };
      this.draw();
    }

    setData(data) {
      this.data = data;
      this.selected = -1; this.hovered = -1;
      this.buildGrid();
      this.buildGroups();
      this.draw();
    }

    setStyle(style) { Object.assign(this.style, style); this.buildGroups(); this.draw(); }
    setBackgroundImage(img) { this.bgImage = img; this.draw(); }
    select(id) { this.selected = id; this.draw(); }
    getSelected() { return this.selected; }

    /* ---------- geometry caches ---------- */
    buildGroups() {
      const d = this.data;
      this.groups = null;
      if (!d || !d.uv) return;
      const { uv } = d, F = uv.length / 6, mode = this.style.mode, m = d.metrics;
      const key = new Int32Array(F);
      const colors = [];
      if (mode === 'chart') {
        const n = d.chartCount || 1;
        for (let f = 0; f < F; f++) key[f] = d.faceChart ? d.faceChart[f] : 0;
        for (let c = 0; c < n; c++) colors.push('hsla(' + ((c * 137.508) % 360).toFixed(1) + ',65%,58%,0.55)');
      } else if (mode === 'wire') {
        key.fill(-1);
      } else {
        const tmp = new Float32Array(3);
        for (let b = 0; b < BINS; b++) { UVApp.colors.heatColor(b / (BINS - 1), tmp, 0); colors.push('rgba(' + (tmp[0] * 255 | 0) + ',' + (tmp[1] * 255 | 0) + ',' + (tmp[2] * 255 | 0) + ',0.8)'); }
        colors.push('rgba(255,60,60,0.95)'); // flipped / invalid
        const bad = BINS;
        for (let f = 0; f < F; f++) {
          let t = 0;
          const flag = m && m.faceFlag ? m.faceFlag[f] : 0;
          if (mode === 'flips') { key[f] = flag === 1 ? bad : 0; continue; }
          if (flag === 1) { key[f] = bad; continue; }
          if (mode === 'heat-sd' && m) t = Math.log2(Math.max(1, m.faceSD[f])) / 1.0;
          else if (mode === 'blender-area' && m) t = m.faceAreaLog2[f] / 1.5;
          else if (mode === 'blender-angle' && m) t = Math.max(m.cornerAngleErr[3 * f], m.cornerAngleErr[3 * f + 1], m.cornerAngleErr[3 * f + 2]) / 0.6;
          if (!isFinite(t)) { key[f] = bad; continue; }
          key[f] = Math.min(BINS - 1, Math.max(0, Math.round(t * (BINS - 1))));
        }
        if (mode === 'flips') colors[0] = 'rgba(140,150,165,0.35)';
      }
      const fills = new Map(), strokes = new Path2D(), charts = new Map();
      for (let f = 0; f < F; f++) {
        const i = 6 * f;
        const tri = (p) => { p.moveTo(uv[i], uv[i + 1]); p.lineTo(uv[i + 2], uv[i + 3]); p.lineTo(uv[i + 4], uv[i + 5]); p.closePath(); };
        if (key[f] >= 0) { let p = fills.get(key[f]); if (!p) { p = new Path2D(); fills.set(key[f], p); } tri(p); }
        tri(strokes);
      }
      this.groups = { fills, colors, strokes, F };
    }

    chartPath(id) {
      const d = this.data;
      if (!d || id < 0) return null;
      if (!this._chartPaths) this._chartPaths = new Map();
      if (this._chartPaths.has(id)) return this._chartPaths.get(id);
      const p = new Path2D(), uv = d.uv;
      for (let f = 0; f < uv.length / 6; f++) {
        if (d.faceChart[f] !== id) continue;
        const i = 6 * f;
        p.moveTo(uv[i], uv[i + 1]); p.lineTo(uv[i + 2], uv[i + 3]); p.lineTo(uv[i + 4], uv[i + 5]); p.closePath();
      }
      this._chartPaths.set(id, p);
      return p;
    }

    buildGrid() {
      this._chartPaths = null;
      const d = this.data;
      this.hit = null;
      if (!d || !d.uv) return;
      const G = 96, cells = Array.from({ length: G * G }, () => []), uv = d.uv;
      for (let f = 0; f < uv.length / 6; f++) {
        const i = 6 * f;
        const x0 = Math.floor(Math.min(uv[i], uv[i + 2], uv[i + 4]) * G), x1 = Math.floor(Math.max(uv[i], uv[i + 2], uv[i + 4]) * G);
        const y0 = Math.floor(Math.min(uv[i + 1], uv[i + 3], uv[i + 5]) * G), y1 = Math.floor(Math.max(uv[i + 1], uv[i + 3], uv[i + 5]) * G);
        for (let y = Math.max(0, y0); y <= Math.min(G - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(G - 1, x1); x++) cells[y * G + x].push(f);
      }
      this.hit = { G, cells };
    }

    faceAt(u, v) {
      if (!this.hit) return -1;
      const { G, cells } = this.hit, x = Math.floor(u * G), y = Math.floor(v * G);
      if (x < 0 || y < 0 || x >= G || y >= G) return -1;
      const uv = this.data.uv;
      for (const f of cells[y * G + x]) {
        const i = 6 * f;
        const d1 = (uv[i + 2] - uv[i]) * (v - uv[i + 1]) - (uv[i + 3] - uv[i + 1]) * (u - uv[i]);
        const d2 = (uv[i + 4] - uv[i + 2]) * (v - uv[i + 3]) - (uv[i + 5] - uv[i + 3]) * (u - uv[i + 2]);
        const d3 = (uv[i] - uv[i + 4]) * (v - uv[i + 5]) - (uv[i + 1] - uv[i + 5]) * (u - uv[i + 4]);
        if ((d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0)) return f;
      }
      return -1;
    }

    toUV(x, y) { return [(x - this.view.ox) / this.view.s, (this.view.oy - y) / this.view.s]; }

    /* ---------- drawing ---------- */
    draw() {
      const g = this.ctx, { s, ox, oy } = this.view, dpr = this.dpr;
      const css = getComputedStyle(document.documentElement);
      const bg = css.getPropertyValue('--bg-2').trim() || '#121820', line = css.getPropertyValue('--line').trim() || '#263243';
      const accent = css.getPropertyValue('--accent').trim() || '#5aa2ff';
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = bg;
      g.fillRect(0, 0, this.canvas.width, this.canvas.height);
      // UV space transform: u right, v up
      g.setTransform(s * dpr, 0, 0, -s * dpr, ox * dpr, oy * dpr);
      const px = 1 / s; // one CSS pixel in UV units
      if (this.style.background === 'checker') {
        const n = 16;
        for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { g.fillStyle = (x + y) % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.12)'; g.fillRect(x / n, y / n, 1 / n, 1 / n); }
      } else if (this.style.background === 'image' && this.bgImage) {
        g.save(); g.transform(1, 0, 0, -1, 0, 1); g.globalAlpha = 0.9; g.drawImage(this.bgImage, 0, 0, 1, 1); g.restore();
      }
      if (this.style.background !== 'none') {
        g.strokeStyle = line; g.lineWidth = px;
        g.beginPath();
        for (let i = 0; i <= 8; i++) { g.moveTo(i / 8, 0); g.lineTo(i / 8, 1); g.moveTo(0, i / 8); g.lineTo(1, i / 8); }
        g.stroke();
      }
      g.strokeStyle = accent; g.lineWidth = 1.5 * px; g.strokeRect(0, 0, 1, 1);
      const res = this.data && this.data.resolution;
      if (this.style.texels && res && s / res > 5) {
        const [u0, v1] = this.toUV(0, 0), [u1, v0] = this.toUV(this.w, this.h);
        g.strokeStyle = 'rgba(128,140,160,0.25)'; g.lineWidth = px;
        g.beginPath();
        for (let i = Math.max(0, Math.floor(u0 * res)); i <= Math.min(res, Math.ceil(u1 * res)); i++) { g.moveTo(i / res, Math.max(0, v0)); g.lineTo(i / res, Math.min(1, v1)); }
        for (let j = Math.max(0, Math.floor(v0 * res)); j <= Math.min(res, Math.ceil(v1 * res)); j++) { g.moveTo(Math.max(0, u0), j / res); g.lineTo(Math.min(1, u1), j / res); }
        g.stroke();
      }
      if (this.groups) {
        for (const [k, p] of this.groups.fills) { g.fillStyle = this.groups.colors[k] || 'rgba(128,128,128,0.5)'; g.fill(p); }
        const dense = this.groups.F * (s / 1000) ** -2 > 2e6; // skip triangle edges when they would be sub-pixel mush
        if (!dense || this.style.mode === 'wire') {
          g.strokeStyle = this.style.mode === 'wire' ? 'rgba(160,200,255,0.75)' : 'rgba(0,0,0,0.28)';
          g.lineWidth = px * 0.75;
          g.stroke(this.groups.strokes);
        }
      }
      for (const [id, color, width] of [[this.hovered, 'rgba(255,255,255,0.8)', 1.5], [this.selected, accent, 2.5]]) {
        const p = this.chartPath(id);
        if (p) { g.strokeStyle = color; g.lineWidth = width * px; g.stroke(p); if (id === this.selected) { g.fillStyle = 'rgba(90,162,255,0.18)'; g.fill(p); } }
      }
    }

    bindEvents() {
      const c = this.canvas;
      let drag = null, raf = 0;
      const redraw = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.draw(); }); };
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
        const k = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0015));
        const s = Math.min(1e6, Math.max(20, this.view.s * k)), f = s / this.view.s;
        this.view.ox = x - (x - this.view.ox) * f; this.view.oy = y - (y - this.view.oy) * f; this.view.s = s;
        redraw();
      }, { passive: false });
      c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: this.view.ox, oy: this.view.oy, moved: false }; c.setPointerCapture(e.pointerId); });
      c.addEventListener('pointermove', (e) => {
        const r = c.getBoundingClientRect();
        if (drag) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; c.classList.add('panning'); }
          if (drag.moved) { this.view.ox = drag.ox + dx; this.view.oy = drag.oy + dy; redraw(); }
          return;
        }
        const [u, v] = this.toUV(e.clientX - r.left, e.clientY - r.top);
        const f = this.faceAt(u, v);
        const id = f >= 0 && this.data.faceChart ? this.data.faceChart[f] : -1;
        if (id !== this.hovered) { this.hovered = id; redraw(); }
        this.emit('hover', { chartId: id, face: f, u, v });
      });
      c.addEventListener('pointerup', (e) => {
        const d = drag; drag = null; c.classList.remove('panning');
        if (!d || d.moved) return;
        const r = c.getBoundingClientRect(), [u, v] = this.toUV(e.clientX - r.left, e.clientY - r.top);
        const f = this.faceAt(u, v);
        const id = f >= 0 && this.data.faceChart ? this.data.faceChart[f] : -1;
        this.selected = id; this.draw();
        this.emit('select', { chartId: id, face: f, u, v });
      });
      c.addEventListener('pointerleave', () => { if (this.hovered !== -1) { this.hovered = -1; redraw(); } this.emit('hover', null); });
      c.addEventListener('dblclick', () => this.resetView());
    }
  }

  UVApp.UVView = UVView;
})(typeof window !== 'undefined' ? window : globalThis);
