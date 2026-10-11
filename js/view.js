// Canvas map renderer: level-of-detail geometry, tiled Path2D batches per colour,
// border classification, labels, highlights and pan / zoom / pinch input.

import { ARC_DIST, ARC_PROV, ARC_COUNTRY, ARC_COAST } from './state.js';

export const PALETTE = ['#f4b8c6', '#93dd8f', '#f9e46f', '#f6a944', '#f28482', '#b5d466', '#cdbfa7', '#bde9d6'];
const SEA = '#bfe6f0';
const SEA_RGBA0 = 'rgba(191,230,240,0)';
const LAND = '#f7f0c9';
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", Arial, sans-serif';
// [colour, width at country zoom, width when zoomed in] in CSS pixels.
const BORDERS = [
  [ARC_DIST, '#8d8d8d', 0.45, 1.1],
  [ARC_PROV, '#3a3a3a', 1.0, 2.2],
  [ARC_COUNTRY, '#b3362f', 1.3, 2.4],
  [ARC_COAST, '#4a87ab', 0.8, 1.5],
];
const MIN_ZOOM = 0.75, MAX_ZOOM = 90;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class MapView {
  constructor(canvas, geo, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.geo = geo;
    this.state = state;
    this.cam = { x: 0, y: 0, s: 0.01 };
    this.W = 1; this.H = 1; this.dpr = 1;
    this.insets = { t: 0, r: 0, b: 0, l: 0 };
    this.baseScale = 0.01;
    this.layers = [];
    this.cache = new Map();
    this.cacheVersion = -1;
    this.textWidths = new Map();
    this.hitCtx = document.createElement('canvas').getContext('2d');
    this.hover = -1;
    this.selected = -1;
    this.pickHover = -1;
    this.picking = false;
    this.flashes = [];
    this.anim = null;
    this.raf = 0;
    this.lastMove = 0;
    this.base = null;
    this.baseCam = null;
    this.onClick = null;
    this.onHover = null;
    this.onMove = null;
    this.resize();
    this.fitAll(false);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindInput();
  }

  // ---- camera -------------------------------------------------------------

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const W = Math.max(1, r.width), H = Math.max(1, r.height);
    if (W === this.W && H === this.H && dpr === this.dpr) return;
    // keep the same world point in the centre
    const cx = (this.W / 2 - this.cam.x) / this.cam.s, cy = (this.H / 2 - this.cam.y) / this.cam.s;
    this.W = W; this.H = H; this.dpr = dpr;
    this.canvas.width = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);
    this.baseCam = null;
    const prevBase = this.baseScale;
    this.baseScale = this.fitScale(this.geo.bounds);
    this.cam.s *= this.baseScale / prevBase;
    this.cam.x = W / 2 - cx * this.cam.s;
    this.cam.y = H / 2 - cy * this.cam.s;
    this.clampCam();
    this.requestRender();
  }

  setInsets(ins) {
    this.insets = { ...this.insets, ...ins };
    this.baseScale = this.fitScale(this.geo.bounds);
  }

  fitScale([x0, y0, x1, y1], pad = 12) {
    const { t, r, b, l } = this.insets;
    const vw = Math.max(50, this.W - l - r - pad * 2), vh = Math.max(50, this.H - t - b - pad * 2);
    return Math.min(vw / (x1 - x0), vh / (y1 - y0));
  }

  camFor(box, maxZoom = MAX_ZOOM, fill = 1) {
    const [x0, y0, x1, y1] = box;
    const { t, r, b, l } = this.insets;
    const s = clamp(this.fitScale(box, 24) * fill, this.baseScale * MIN_ZOOM, this.baseScale * maxZoom);
    const vw = this.W - l - r, vh = this.H - t - b;
    return { x: l + vw / 2 - ((x0 + x1) / 2) * s, y: t + vh / 2 - ((y0 + y1) / 2) * s, s };
  }

  fitAll(animate = true) {
    const c = this.camFor(this.geo.bounds, MAX_ZOOM);
    if (animate) this.animateTo(c); else { this.cam = c; this.requestRender(); }
  }

  flyToBox(box, maxZoom = 14) {
    this.animateTo(this.camFor(box, maxZoom, 0.8));
  }

  get zoom() { return this.cam.s / this.baseScale; }

  // Pans (without zooming) so that the box centre is in the uncovered part of the view.
  ensureVisible([x0, y0, x1, y1]) {
    const { t, r, b, l } = this.insets;
    const { x, y, s } = this.cam;
    const cx = ((x0 + x1) / 2) * s + x, cy = ((y0 + y1) / 2) * s + y;
    const m = 40;
    if (cx > l + m && cx < this.W - r - m && cy > t + m && cy < this.H - b - m) return;
    const vw = this.W - l - r, vh = this.H - t - b;
    this.animateTo({ s, x: x + (l + vw / 2 - cx), y: y + (t + vh / 2 - cy) }, 400);
  }

  clampCam() {
    const { s } = this.cam;
    const [x0, y0, x1, y1] = this.geo.bounds;
    const { t, r, b, l } = this.insets;
    // the visible centre must stay over (or near) Turkey
    const cx = (l + (this.W - l - r) / 2 - this.cam.x) / s, cy = (t + (this.H - t - b) / 2 - this.cam.y) / s;
    const mx = (x1 - x0) * 0.15, my = (y1 - y0) * 0.25;
    const ncx = clamp(cx, x0 - mx, x1 + mx), ncy = clamp(cy, y0 - my, y1 + my);
    this.cam.x -= (ncx - cx) * s;
    this.cam.y -= (ncy - cy) * s;
  }

  moved() {
    this.lastMove = performance.now();
    this.onMove?.();
  }

  zoomAt(px, py, factor) {
    const s0 = this.cam.s;
    const s = clamp(s0 * factor, this.baseScale * MIN_ZOOM, this.baseScale * MAX_ZOOM);
    this.cam.x = px - ((px - this.cam.x) * s) / s0;
    this.cam.y = py - ((py - this.cam.y) * s) / s0;
    this.cam.s = s;
    this.clampCam();
    this.requestRender();
    this.moved();
  }

  zoomBy(factor) {
    const { t, r, b, l } = this.insets;
    const px = l + (this.W - l - r) / 2, py = t + (this.H - t - b) / 2;
    const s = clamp(this.cam.s * factor, this.baseScale * MIN_ZOOM, this.baseScale * MAX_ZOOM);
    const f = s / this.cam.s;
    this.animateTo({ x: px - (px - this.cam.x) * f, y: py - (py - this.cam.y) * f, s }, 260);
  }

  animateTo(to, dur = 650) {
    const from = { ...this.cam };
    // interpolate the viewport centre in world space and the scale logarithmically
    const cw = this.W / 2, ch = this.H / 2;
    const fx = (cw - from.x) / from.s, fy = (ch - from.y) / from.s;
    const tx = (cw - to.x) / to.s, ty = (ch - to.y) / to.s;
    const ls0 = Math.log(from.s), ls1 = Math.log(to.s);
    const t0 = performance.now();
    this.anim = (now) => {
      const k = ease(clamp((now - t0) / dur, 0, 1));
      const s = Math.exp(ls0 + (ls1 - ls0) * k);
      const wx = fx + (tx - fx) * k, wy = fy + (ty - fy) * k;
      this.cam = { s, x: cw - wx * s, y: ch - wy * s };
      if (k >= 1) { this.anim = null; this.clampCam(); }
      this.onMove?.();
      return k < 1;
    };
    this.requestRender();
  }

  // ---- input --------------------------------------------------------------

  bindInput() {
    const c = this.canvas;
    const pts = new Map();
    let g = null;
    const pos = (e) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    c.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button > 0) return;
      c.setPointerCapture(e.pointerId);
      const p = pos(e);
      pts.set(e.pointerId, p);
      this.anim = null;
      if (pts.size === 1) g = { type: 'pan', sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, t: performance.now() };
      else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        g = { type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      }
    });

    c.addEventListener('pointermove', (e) => {
      const p = pos(e);
      if (!pts.has(e.pointerId)) {
        if (e.pointerType === 'mouse') this.hoverAt(p.x, p.y, e);
        return;
      }
      pts.set(e.pointerId, p);
      if (!g) return;
      if (g.type === 'pan' && pts.size === 1) {
        if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) > 6) { g.moved = true; this.onHover?.(-1, null); }
        if (g.moved) {
          this.cam.x += p.x - g.lx;
          this.cam.y += p.y - g.ly;
          this.clampCam();
          this.requestRender();
          this.moved();
        }
        g.lx = p.x; g.ly = p.y;
      } else if (g.type === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this.cam.x += mx - g.mx;
        this.cam.y += my - g.my;
        this.zoomAt(mx, my, d / g.d);
        g.d = d; g.mx = mx; g.my = my;
      }
    });

    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = pos(e);
      pts.delete(e.pointerId);
      if (g && g.type === 'pan' && !g.moved && e.type === 'pointerup' && performance.now() - g.t < 700) {
        this.onClick?.(this.pickAt(p.x, p.y), e);
      }
      if (pts.size === 1) {
        const [q] = [...pts.values()];
        g = { type: 'pan', sx: q.x, sy: q.y, lx: q.x, ly: q.y, moved: true, t: 0 };
      } else if (pts.size === 0) g = null;
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.hoverAt(-1, -1, null); });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = pos(e);
      let dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.H : 1);
      if (e.ctrlKey) dy *= 2.5; // trackpad pinch
      this.anim = null;
      this.zoomAt(p.x, p.y, Math.exp(clamp(-dy, -300, 300) * 0.0018));
    }, { passive: false });

    c.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const p = pos(e);
      const s = clamp(this.cam.s * 2.2, this.baseScale * MIN_ZOOM, this.baseScale * MAX_ZOOM);
      const f = s / this.cam.s;
      this.animateTo({ x: p.x - (p.x - this.cam.x) * f, y: p.y - (p.y - this.cam.y) * f, s }, 300);
    });
  }

  hoverAt(x, y, e) {
    const i = x < 0 ? -1 : this.pickAt(x, y);
    if (this.picking) {
      if (i !== this.pickHover) { this.pickHover = i; this.requestRender(); }
    } else if (i !== this.hover) { this.hover = i; this.requestRender(); }
    this.canvas.style.cursor = i >= 0 ? 'pointer' : '';
    this.onHover?.(i, e);
  }

  pickAt(px, py) {
    const { x, y, s } = this.cam;
    const wx = (px - x) / s, wy = (py - y) / s;
    const { box } = this.geo, alive = this.state.alive;
    const L = this.geo.levelFor(s);
    for (let i = 0; i < this.geo.count; i++) {
      const b = i * 4;
      if (!alive[i] || wx < box[b] || wx > box[b + 2] || wy < box[b + 1] || wy > box[b + 3]) continue;
      if (this.hitCtx.isPointInPath(this.geo.districtPath(i, L), wx, wy)) return i;
    }
    return -1;
  }

  // ---- highlights ----------------------------------------------------------

  flash(members, color = '#ff5a1f', dur = 2600) {
    if (!members.length) return;
    this.flashes.push({ members, color, t0: performance.now(), dur, key: `f${Math.random()}` });
    this.requestRender();
  }

  // ---- rendering ----------------------------------------------------------

  requestRender() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => { this.raf = 0; this.render(t); });
  }

  layer(L) {
    if (this.layers[L]) return this.layers[L];
    const [x0, y0, x1, y1] = this.geo.fullBounds;
    const nx = L < 4 ? 1 : Math.min(32, 2 ** (L - 3));
    const ny = Math.max(1, Math.round((nx * (y1 - y0)) / (x1 - x0)));
    const tw = (x1 - x0) / nx, th = (y1 - y0) / ny;
    const tiles = [];
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      tiles.push({ x0: x0 + i * tw, y0: y0 + j * th, x1: x0 + (i + 1) * tw, y1: y0 + (j + 1) * th, ds: [], as: [], fv: -1, fills: null, lv: -1, lines: null });
    }
    const assign = (boxes, n, key) => {
      for (let k = 0; k < n; k++) {
        const b = k * 4;
        const i0 = clamp(Math.floor((boxes[b] - x0) / tw), 0, nx - 1), i1 = clamp(Math.floor((boxes[b + 2] - x0) / tw), 0, nx - 1);
        const j0 = clamp(Math.floor((boxes[b + 1] - y0) / th), 0, ny - 1), j1 = clamp(Math.floor((boxes[b + 3] - y0) / th), 0, ny - 1);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) tiles[j * nx + i][key].push(k);
      }
    };
    assign(this.geo.box, this.geo.count, 'ds');
    assign(this.geo.arcBox, this.geo.arcCount, 'as');
    return (this.layers[L] = { tiles, nx, ny, tw, th, x0, y0 });
  }

  tileFills(t, L) {
    const v = this.state.version;
    if (t.fv === v) return t.fills;
    const fills = new Array(PALETTE.length).fill(null);
    const { alive, color } = this.state;
    for (const d of t.ds) {
      if (!alive[d]) continue;
      const c = color[d];
      (fills[c] || (fills[c] = new Path2D())).addPath(this.geo.districtPath(d, L));
    }
    t.fv = v;
    return (t.fills = fills);
  }

  tileLines(t, L) {
    const v = this.state.version;
    if (t.lv === v) return t.lines;
    const lines = [null, null, null, null, null];
    const arcs = this.geo.arcsAt(L), type = this.state.arcType, isLand = this.geo.isLand;
    const [X0, Y0, X1, Y1] = this.geo.fullBounds;
    for (const a of t.as) {
      const ty = type[a];
      if (!ty) continue;
      const p = lines[ty] || (lines[ty] = new Path2D());
      const pts = arcs[a];
      p.moveTo(pts[0], pts[1]);
      if (!isLand[a]) {
        for (let j = 2; j < pts.length; j += 2) p.lineTo(pts[j], pts[j + 1]);
        continue;
      }
      // neighbour land is clipped to a box: don't draw a coast along the cut
      for (let j = 2; j < pts.length; j += 2) {
        const x0 = pts[j - 2], y0 = pts[j - 1], x1 = pts[j], y1 = pts[j + 1];
        const frame = (x0 === x1 && (x0 === X0 || x0 === X1)) || (y0 === y1 && (y0 === Y0 || y0 === Y1));
        if (frame) p.moveTo(x1, y1); else p.lineTo(x1, y1);
      }
    }
    t.lv = v;
    return (t.lines = lines);
  }

  cached(key, build) {
    if (this.cacheVersion !== this.state.version) { this.cache.clear(); this.cacheVersion = this.state.version; }
    let v = this.cache.get(key);
    if (!v) { v = build(); this.cache.set(key, v); }
    return v;
  }

  groupFill(members, key, L) {
    return this.cached(`gf${key}:${L}`, () => {
      const p = new Path2D();
      for (const i of members) p.addPath(this.geo.districtPath(i, L));
      return p;
    });
  }

  groupOutline(members, key, L) {
    return this.cached(`go${key}:${L}`, () => this.geo.arcsPath(this.geo.outlineArcs(members), L));
  }

  // The expensive part (sea, land, fills, borders) is drawn into an offscreen "base"
  // canvas with some padding. While the user drags, pinches or flies, frames just
  // blit that bitmap with a transform; it is redrawn sharp when the motion stops,
  // when it no longer covers the view, or when the game state changes.
  render(now = performance.now()) {
    if (this.anim && this.anim(now)) this.requestRender();
    const { ctx, dpr, W, H } = this;
    const { x, y, s } = this.cam;
    const bc = this.baseCam;
    const moving = !!this.anim || now - this.lastMove < 160;

    let k = 1, ox = 0, oy = 0, full = !bc || this.baseVersion !== this.state.version || this.baseDpr !== dpr;
    if (!full) {
      k = s / bc.s;
      ox = x - (bc.x + bc.padX) * k;
      oy = y - (bc.y + bc.padY) * k;
      const covers = ox <= 0.5 && oy <= 0.5 && ox + bc.w * k >= W - 0.5 && oy + bc.h * k >= H - 0.5;
      const same = Math.abs(k - 1) < 1e-9 && Math.abs(ox + bc.padX) < 1e-6 && Math.abs(oy + bc.padY) < 1e-6;
      if (!covers || k > 2.2 || k < 0.7 || (!moving && !same)) full = true;
      else if (moving && !same) {
        clearTimeout(this.settle);
        this.settle = setTimeout(() => this.requestRender(), 170);
      }
    }
    if (full) {
      this.renderBase();
      k = 1; ox = -this.baseCam.padX; oy = -this.baseCam.padY;
    }

    // the base always covers the view here, so no clearing is needed
    ctx.imageSmoothingEnabled = k !== 1;
    ctx.setTransform(k, 0, 0, k, dpr * ox, dpr * oy);
    ctx.drawImage(this.base, 0, 0);

    const L = this.geo.levelFor(s);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    this.drawHighlights(L, 1 / s, now);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawLabels();
  }

  renderBase() {
    const { dpr, W, H, geo } = this;
    const padX = Math.round(W * 0.15), padY = Math.round(H * 0.15);
    const w = W + 2 * padX, h = H + 2 * padY;
    if (!this.base) {
      this.base = document.createElement('canvas');
      this.bctx = this.base.getContext('2d', { alpha: false });
    }
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (this.base.width !== bw || this.base.height !== bh) { this.base.width = bw; this.base.height = bh; }
    const ctx = this.bctx;
    const s = this.cam.s, x = this.cam.x + padX, y = this.cam.y + padY;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SEA;
    ctx.fillRect(0, 0, bw, bh);
    const L = geo.levelFor(s);
    const px = 1 / s;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * x, dpr * y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.fillStyle = LAND;
    ctx.fill(geo.landPath(L));
    this.fadeLandEdges(ctx);

    const vx0 = -x / s, vy0 = -y / s, vx1 = (w - x) / s, vy1 = (h - y) / s;
    const tiles = this.layer(L).tiles.filter((t) => t.x1 >= vx0 && t.x0 <= vx1 && t.y1 >= vy0 && t.y0 <= vy1);
    for (const t of tiles) {
      const f = this.tileFills(t, L);
      for (let c = 0; c < f.length; c++) if (f[c]) { ctx.fillStyle = PALETTE[c]; ctx.fill(f[c]); }
    }
    const zf = clamp(Math.log2(Math.max(1, this.zoom)) / 5, 0, 1);
    for (const [ty, col, w0, w1] of BORDERS) {
      ctx.strokeStyle = col;
      ctx.lineWidth = (w0 + (w1 - w0) * zf) * px;
      for (const t of tiles) { const l = this.tileLines(t, L)[ty]; if (l) ctx.stroke(l); }
    }
    this.baseCam = { ...this.cam, padX, padY, w, h };
    this.baseVersion = this.state.version;
    this.baseDpr = dpr;
  }

  // Neighbouring land is clipped to a box; fade its straight cut edges into the sea.
  fadeLandEdges(ctx) {
    const [x0, y0, x1, y1] = this.geo.fullBounds;
    const f = (x1 - x0) * 0.06;
    const edge = (gx0, gy0, gx1, gy1, rx, ry, rw, rh) => {
      const g = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      g.addColorStop(0, SEA_RGBA0);
      g.addColorStop(1, SEA);
      ctx.fillStyle = g;
      ctx.fillRect(rx, ry, rw, rh);
    };
    const big = (x1 - x0) * 4;
    edge(x0 + f, 0, x0, 0, x0 - big, y0 - big, f + big, y1 - y0 + 2 * big);
    edge(x1 - f, 0, x1, 0, x1 - f, y0 - big, f + big, y1 - y0 + 2 * big);
    edge(0, y0 + f, 0, y0, x0 - big, y0 - big, x1 - x0 + 2 * big, f + big);
    edge(0, y1 - f, 0, y1, x0 - big, y1 - f, x1 - x0 + 2 * big, f + big);
  }

  drawHighlights(L, px, now) {
    const { ctx, state } = this;
    const group = (i) => (i >= 0 && state.alive[i] ? state.root[i] : -1);
    const outline = (r, fill, inner, outer, wIn, wOut) => {
      const members = state.groups.get(r);
      if (!members) return;
      if (fill) { ctx.fillStyle = fill; ctx.fill(this.groupFill(members, r, L)); }
      const o = this.groupOutline(members, r, L);
      if (outer) { ctx.strokeStyle = outer; ctx.lineWidth = wOut * px; ctx.stroke(o); }
      ctx.strokeStyle = inner; ctx.lineWidth = wIn * px; ctx.stroke(o);
    };

    const sel = group(this.selected);
    const hov = group(this.picking ? this.pickHover : this.hover);
    if (hov >= 0 && hov !== sel) {
      if (this.picking) outline(hov, 'rgba(10,99,206,0.22)', '#0a63ce', 'rgba(255,255,255,0.9)', 2.2, 4.5);
      else outline(hov, 'rgba(255,255,255,0.28)', '#1b1b1b', null, 1.3, 0);
    }
    if (sel >= 0) outline(sel, 'rgba(255,255,255,0.32)', '#111', 'rgba(255,255,255,0.95)', 2.2, 5);

    if (this.flashes.length) {
      this.flashes = this.flashes.filter((f) => now - f.t0 < f.dur);
      for (const f of this.flashes) {
        const k = (now - f.t0) / f.dur;
        const pulse = 0.5 + 0.5 * Math.sin(k * Math.PI * 6);
        const o = this.cached(`fl${f.key}:${L}`, () => this.geo.arcsPath(this.geo.outlineArcs(f.members), L));
        ctx.globalAlpha = (1 - k) * (0.55 + 0.45 * pulse);
        ctx.strokeStyle = f.color;
        ctx.lineWidth = (3 + 3 * pulse) * px;
        ctx.stroke(o);
      }
      ctx.globalAlpha = 1;
      if (this.flashes.length) this.requestRender();
    }
  }

  measure(text, font) {
    const key = font + '|' + text;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this.textWidths.size > 5000) this.textWidths.clear();
      this.textWidths.set(key, w);
    }
    return w;
  }

  drawLabels() {
    const { ctx, state, geo, W, H } = this;
    const { x, y, s } = this.cam;
    const z = this.zoom;
    const placed = [];
    const free = (x0, y0, x1, y1) => {
      for (const r of placed) if (x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]) return false;
      placed.push([x0, y0, x1, y1]);
      return true;
    };
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 3;

    // province names fade out as district names take over
    const pa = z < 2.3 ? 1 : z < 3.8 ? (3.8 - z) / 1.5 : 0;
    if (pa > 0.03) {
      const font = `700 ${z < 1.25 ? 9.5 : z < 1.8 ? 10.5 : 12}px ${FONT}`;
      ctx.font = font;
      ctx.globalAlpha = pa;
      ctx.fillStyle = '#141414';
      for (const pk of state.provOrder) {
        const pt = state.provLabel.get(pk);
        const sx = pt[0] * s + x, sy = pt[1] * s + y;
        if (sx < -80 || sx > W + 80 || sy < -20 || sy > H + 20) continue;
        const text = state.provName(pk).toLocaleUpperCase('tr');
        const w = this.measure(text, font);
        if (!free(sx - w / 2 - 2, sy - 7, sx + w / 2 + 2, sy + 7)) continue;
        ctx.strokeText(text, sx, sy);
        ctx.fillText(text, sx, sy);
      }
      ctx.globalAlpha = 1;
    }

    if (z > 1.6) {
      const font = `500 ${z > 8 ? 12.5 : 11}px ${FONT}`;
      ctx.font = font;
      ctx.fillStyle = '#262626';
      for (const r of state.groupOrder) {
        const size = Math.sqrt(state.groupArea.get(r)) * s;
        if (size < 26) break; // sorted by area: everything after is smaller
        const pt = state.groupLabel.get(r);
        const sx = pt[0] * s + x, sy = pt[1] * s + y;
        if (sx < -60 || sx > W + 60 || sy < -16 || sy > H + 16) continue;
        const text = state.name[r];
        const w = this.measure(text, font);
        if (w > size * 1.3) continue;
        if (!free(sx - w / 2 - 2, sy - 7, sx + w / 2 + 2, sy + 7)) continue;
        ctx.strokeText(text, sx, sy);
        ctx.fillText(text, sx, sy);
      }
    }

    // seas and neighbouring countries: lowest priority, never drawn half off-screen
    const inView = (x0, y0, x1, y1) => x0 >= 2 && y0 >= 2 && x1 <= W - 2 && y1 <= H - 2;
    ctx.fillStyle = '#2f6f93';
    for (const [name, wx, wy, size, rot] of geo.seaLabels) {
      const fs = clamp(12 * size * Math.sqrt(z), 10, 26);
      const font = `italic 600 ${fs.toFixed(1)}px ${FONT}`;
      const w = this.measure(name, font), sx = wx * s + x, sy = wy * s + y;
      const [hw, hh] = rot ? [fs * 0.6, w / 2] : [w / 2, fs * 0.6];
      if (!inView(sx - hw, sy - hh, sx + hw, sy + hh) || !free(sx - hw, sy - hh, sx + hw, sy + hh)) continue;
      ctx.font = font;
      if (rot) {
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate((rot * Math.PI) / 180);
        ctx.fillText(name, 0, 0);
        ctx.restore();
      } else ctx.fillText(name, sx, sy);
    }
    const cfont = `italic 500 11px ${FONT}`;
    ctx.font = cfont;
    ctx.fillStyle = '#8b7d4c';
    for (const [name, wx, wy] of geo.countryLabels) {
      const w = this.measure(name, cfont), sx = wx * s + x, sy = wy * s + y;
      if (!inView(sx - w / 2, sy - 7, sx + w / 2, sy + 7) || !free(sx - w / 2, sy - 7, sx + w / 2, sy + 7)) continue;
      ctx.fillText(name, sx, sy);
    }
  }
}
