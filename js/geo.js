// Map geometry: decodes data/map.json (shared-arc topology in a 30 m grid),
// builds simplified levels of detail and caches Path2D objects per level.

export const MAX_LEVEL = 8;
// Simplification tolerance (world units) at level 0; halves at every level.
const T0 = 256;
// Allowed simplification error in CSS pixels.
const TOL_PX = 0.55;

export class Geo {
  constructor(m) {
    const d = m.d;
    this.count = d.names.length;
    this.names = d.names;
    this.plates = d.prov;
    this.area = d.area;
    this.labelPt = d.label;
    this.geom = d.geom;
    this.landGeom = m.land;
    this.provinces = m.provinces;
    // ids up to base were seeded by the first version of the site; newer ones are added on top
    this.base = m.base || { d: this.count, p: Object.keys(m.provinces).length };
    this.countryLabels = m.countryLabels;
    this.seaLabels = m.seaLabels;
    this.attribution = m.attribution;

    const nA = (this.arcCount = m.arcs.length);
    this.arcs = new Array(nA);
    this.arcBox = new Float32Array(nA * 4);
    for (let a = 0; a < nA; a++) {
      const flat = m.arcs[a];
      const pts = new Float32Array(flat.length);
      let x = 0, y = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let j = 0; j < flat.length; j += 2) {
        x += flat[j]; y += flat[j + 1];
        pts[j] = x; pts[j + 1] = y;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      this.arcs[a] = pts;
      this.arcBox.set([x0, y0, x1, y1], a * 4);
    }

    // Which districts lie on each side of every arc (-1 = sea / neighbour land).
    this.sides = new Int32Array(nA * 2).fill(-1);
    this.box = new Float32Array(this.count * 4);
    this.distArcs = new Array(this.count);
    for (let i = 0; i < this.count; i++) {
      const own = new Set();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const poly of this.geom[i]) for (const ring of poly) for (const r of ring) {
        const a = r < 0 ? ~r : r;
        own.add(a);
        const b = a * 4;
        if (this.arcBox[b] < x0) x0 = this.arcBox[b];
        if (this.arcBox[b + 1] < y0) y0 = this.arcBox[b + 1];
        if (this.arcBox[b + 2] > x1) x1 = this.arcBox[b + 2];
        if (this.arcBox[b + 3] > y1) y1 = this.arcBox[b + 3];
      }
      for (const a of own) {
        if (this.sides[a * 2] < 0) this.sides[a * 2] = i;
        else if (this.sides[a * 2] !== i) this.sides[a * 2 + 1] = i;
      }
      this.distArcs[i] = Int32Array.from(own);
      this.box.set([x0, y0, x1, y1], i * 4);
    }
    this.isLand = new Uint8Array(nA);
    for (const poly of this.landGeom) for (const ring of poly) for (const r of ring) this.isLand[r < 0 ? ~r : r] = 1;

    // Bounds of Turkey (for fitting) and of everything (for tiling).
    this.bounds = boxUnion(this.box, this.count);
    this.fullBounds = boxUnion(this.arcBox, nA);

    this.levelArcs = new Array(MAX_LEVEL + 1);
    this.levelPaths = new Array(MAX_LEVEL + 1);
    this.landPaths = new Array(MAX_LEVEL + 1);
  }

  levelFor(scale) {
    const L = Math.ceil(Math.log2((T0 * scale) / TOL_PX));
    return Math.max(0, Math.min(MAX_LEVEL, L));
  }

  arcsAt(L) {
    if (L >= MAX_LEVEL) return this.arcs;
    if (!this.levelArcs[L]) {
      const tol = T0 / 2 ** L;
      this.levelArcs[L] = this.arcs.map((pts) => simplify(pts, tol));
    }
    return this.levelArcs[L];
  }

  districtPath(i, L) {
    let cache = this.levelPaths[L];
    if (!cache) cache = this.levelPaths[L] = new Array(this.count);
    if (!cache[i]) {
      const p = new Path2D();
      ringsToPath(p, this.geom[i], this.arcsAt(L));
      cache[i] = p;
    }
    return cache[i];
  }

  landPath(L) {
    if (!this.landPaths[L]) {
      const p = new Path2D();
      ringsToPath(p, this.landGeom, this.arcsAt(L));
      this.landPaths[L] = p;
    }
    return this.landPaths[L];
  }

  // Path of the given arcs (indices) at level L, as open polylines.
  arcsPath(arcIdx, L, path = new Path2D()) {
    const arcs = this.arcsAt(L);
    for (const a of arcIdx) {
      const pts = arcs[a];
      path.moveTo(pts[0], pts[1]);
      for (let j = 2; j < pts.length; j += 2) path.lineTo(pts[j], pts[j + 1]);
    }
    return path;
  }

  // Outline of a set of districts: arcs with exactly one side inside the set.
  outlineArcs(members) {
    const set = members instanceof Set ? members : new Set(members);
    const out = [];
    for (const i of set) {
      for (const a of this.distArcs[i]) {
        const s0 = this.sides[a * 2], s1 = this.sides[a * 2 + 1];
        if (set.has(s0) !== set.has(s1)) out.push(a);
      }
    }
    return out;
  }
}

function boxUnion(boxes, n) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const b = i * 4;
    if (boxes[b] < x0) x0 = boxes[b];
    if (boxes[b + 1] < y0) y0 = boxes[b + 1];
    if (boxes[b + 2] > x1) x1 = boxes[b + 2];
    if (boxes[b + 3] > y1) y1 = boxes[b + 3];
  }
  return [x0, y0, x1, y1];
}

function ringsToPath(path, polys, arcs) {
  for (const poly of polys) {
    for (const ring of poly) {
      let first = true;
      for (const r of ring) {
        const pts = arcs[r < 0 ? ~r : r];
        const n = pts.length >> 1;
        if (r < 0) {
          for (let j = first ? n - 1 : n - 2; j >= 0; j--) {
            if (first) { path.moveTo(pts[j * 2], pts[j * 2 + 1]); first = false; } else path.lineTo(pts[j * 2], pts[j * 2 + 1]);
          }
        } else {
          for (let j = first ? 0 : 1; j < n; j++) {
            if (first) { path.moveTo(pts[j * 2], pts[j * 2 + 1]); first = false; } else path.lineTo(pts[j * 2], pts[j * 2 + 1]);
          }
        }
      }
      path.closePath();
    }
  }
}

// Douglas–Peucker on a flat [x0, y0, x1, y1, …] array; endpoints are always kept so
// neighbouring districts stay seamless at every level of detail.
function simplify(pts, tol) {
  const n = pts.length >> 1;
  if (n <= 2) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [0, n - 1];
  while (stack.length) {
    const last = stack.pop(), first = stack.pop();
    const ax = pts[first * 2], ay = pts[first * 2 + 1];
    const dx = pts[last * 2] - ax, dy = pts[last * 2 + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = first + 1; i < last; i++) {
      let px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      if (len2 > 0) {
        let t = (px * dx + py * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        px -= t * dx; py -= t * dy;
      }
      const d = px * px + py * py;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol2) { keep[idx] = 1; stack.push(first, idx, idx, last); }
  }
  let k = 0;
  for (let i = 0; i < n; i++) k += keep[i];
  const out = new Float32Array(k * 2);
  for (let i = 0, j = 0; i < n; i++) if (keep[i]) { out[j++] = pts[i * 2]; out[j++] = pts[i * 2 + 1]; }
  return out;
}
