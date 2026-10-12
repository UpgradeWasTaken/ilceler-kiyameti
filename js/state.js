// Game state: the current name / province / sea / merge status of every district,
// plus everything derived from it (groups, colours, border types, labels, stats).

import { COUNTRIES } from './countries.js';

export const ARC_NONE = 0, ARC_DIST = 1, ARC_PROV = 2, ARC_COUNTRY = 3, ARC_COAST = 4;
export const COOLDOWN_MS = 10000;
// Province fill colours by index (the `c` every client understands); provinces may also
// carry a custom `rgb` colour, which newer clients prefer.
export const PALETTE = ['#f4b8c6', '#93dd8f', '#f9e46f', '#f6a944', '#f28482', '#b5d466', '#cdbfa7', '#bde9d6'];
export const PALETTE_SIZE = PALETTE.length;
export const HOME_COUNTRY = 'TR';

const hexRgb = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
// Palette index closest to a colour (for clients that only know the palette).
export function nearestPalette(hex) {
  const [r, g, b] = hexRgb(hex);
  let best = 0, bd = Infinity;
  PALETTE.forEach((p, i) => {
    const [pr, pg, pb] = hexRgb(p);
    const d = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export const districtKey = (i) => `d${i}`;
export function districtIndex(key) {
  return typeof key === 'string' && /^d\d{1,4}$/.test(key) ? +key.slice(1) : -1;
}

const TR_FOLD = { ç: 'c', ğ: 'g', ı: 'i', i̇: 'i', ö: 'o', ş: 's', ü: 'u', â: 'a', î: 'i', û: 'u' };
export function fold(s) {
  return s.toLocaleLowerCase('tr').replace(/[çğıöşüâîû]|i̇/g, (c) => TR_FOLD[c] || c);
}

export function cleanName(s) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
}

export class GameState {
  constructor(geo) {
    this.geo = geo;
    const n = geo.count;
    this.name = geo.names.slice();
    this.prov = Array.from(geo.plates, (p) => `p${p}`);
    this.del = new Uint8Array(n);
    this.merge = new Int32Array(n).fill(-1);
    this.provinces = new Map();
    for (const [k, [name, c, country]] of Object.entries(geo.provinces)) {
      this.provinces.set(`p${k}`, { n: name, c, x: false, rgb: null, k: country || null });
    }
    this.countries = new Map(); // custom countries founded by players: key -> name
    // which districts / provinces exist in the database (only those can be changed)
    this.inDb = new Uint8Array(n);
    this.provInDb = new Set();

    this.root = new Int32Array(n);
    this.alive = new Uint8Array(n);
    this.fill = new Array(n).fill(PALETTE[0]);
    this.arcType = new Uint8Array(geo.arcCount);
    this.version = 0;
    this.derive();
  }

  // Applies a district node from the database. Returns its index or -1.
  setDistrict(key, v) {
    const i = districtIndex(key);
    if (i < 0 || i >= this.geo.count || !v || typeof v !== 'object') return -1;
    if (typeof v.n === 'string') this.name[i] = v.n;
    if (typeof v.p === 'string') this.prov[i] = v.p;
    this.del[i] = v.x === true ? 1 : 0;
    const m = districtIndex(v.m);
    this.merge[i] = m >= 0 && m < this.geo.count && m !== i ? m : -1;
    this.inDb[i] = 1;
    return i;
  }

  setProvince(key, v) {
    if (!v || typeof v !== 'object' || typeof v.n !== 'string') return false;
    this.provinces.set(key, {
      n: v.n,
      c: Math.abs(v.c | 0) % PALETTE_SIZE,
      x: v.x === true,
      rgb: typeof v.rgb === 'string' && /^#[0-9a-f]{6}$/.test(v.rgb) ? v.rgb : null,
      k: typeof v.k === 'string' ? v.k : null,
    });
    this.provInDb.add(key);
    return true;
  }

  setCountry(key, v) {
    if (!v || typeof v.n !== 'string') return false;
    this.countries.set(key, v.n);
    return true;
  }

  districtNode(i) {
    const node = { n: this.name[i], p: this.prov[i] };
    if (this.del[i]) node.x = true;
    if (this.merge[i] >= 0) node.m = districtKey(this.merge[i]);
    return node;
  }

  derive() {
    const g = this.geo, n = g.count;
    const { root, alive, fill, merge } = this;

    for (let i = 0; i < n; i++) {
      let r = i;
      for (let steps = 0; merge[r] >= 0; steps++) {
        if (steps > n) { r = -1; break; } // cycle guard; the database rules prevent cycles
        r = merge[r];
      }
      root[i] = r;
    }

    const groups = new Map();
    let sea = 0, merged = 0;
    for (let i = 0; i < n; i++) {
      const r = root[i];
      let ok = false;
      if (r >= 0 && !this.del[r]) {
        const p = this.provinces.get(this.prov[r]);
        if (!p || !p.x) { ok = true; fill[i] = this.provFill(this.prov[r]); }
      }
      alive[i] = ok ? 1 : 0;
      if (!ok) { sea++; continue; }
      if (r !== i) merged++;
      let m = groups.get(r);
      if (!m) groups.set(r, (m = []));
      m.push(i);
    }
    this.groups = groups;

    this.groupArea = new Map();
    this.groupLabel = new Map();
    const provGroups = new Map();
    for (const [r, members] of groups) {
      let area = 0, best = members[0];
      for (const i of members) { area += g.area[i]; if (g.area[i] > g.area[best]) best = i; }
      this.groupArea.set(r, area);
      this.groupLabel.set(r, g.labelPt[best]);
      const pk = this.prov[r];
      let l = provGroups.get(pk);
      if (!l) provGroups.set(pk, (l = []));
      l.push(r);
    }
    this.provGroups = provGroups;

    // Province label: the member district nearest to the area-weighted centre.
    this.provLabel = new Map();
    this.provArea = new Map();
    for (const [pk, roots] of provGroups) {
      let sx = 0, sy = 0, sa = 0;
      for (const r of roots) for (const i of groups.get(r)) {
        const a = g.area[i], p = g.labelPt[i];
        sx += p[0] * a; sy += p[1] * a; sa += a;
      }
      const cx = sx / sa, cy = sy / sa;
      let best = null, bd = Infinity;
      for (const r of roots) for (const i of groups.get(r)) {
        const p = g.labelPt[i], d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2;
        if (d < bd) { bd = d; best = p; }
      }
      this.provLabel.set(pk, best);
      this.provArea.set(pk, sa);
    }
    this.groupOrder = [...groups.keys()].sort((a, b) => this.groupArea.get(b) - this.groupArea.get(a));
    this.provOrder = [...provGroups.keys()].sort((a, b) => this.provArea.get(b) - this.provArea.get(a));

    // Border type of every arc.
    const { sides, isLand } = g;
    for (let a = 0; a < g.arcCount; a++) {
      const s0 = sides[a * 2], s1 = sides[a * 2 + 1];
      const A = s0 >= 0 && alive[s0] === 1, B = s1 >= 0 && alive[s1] === 1;
      let t = ARC_NONE;
      if (A && B) {
        const ra = root[s0], rb = root[s1];
        const pa = this.prov[ra], pb = this.prov[rb];
        t = ra === rb ? ARC_NONE : pa === pb ? ARC_DIST : this.countryOf(pa) === this.countryOf(pb) ? ARC_PROV : ARC_COUNTRY;
      } else if (A || B) {
        t = (A ? s1 : s0) < 0 && isLand[a] ? ARC_COUNTRY : ARC_COAST;
      } else if (isLand[a]) {
        t = ARC_COAST; // a neighbour's coast, possibly facing a sunken district
      }
      this.arcType[a] = t;
    }

    const countries = new Set([...provGroups.keys()].map((pk) => this.countryOf(pk)));
    this.stats = { districts: groups.size, provinces: provGroups.size, countries: countries.size, sea, merged };
    this.version++;
  }

  provName(pk) {
    const p = this.provinces.get(pk);
    return p ? p.n : '?';
  }

  provColor(pk) {
    const p = this.provinces.get(pk);
    return p ? p.c : 0;
  }

  // The CSS colour a province is drawn with.
  provFill(pk) {
    const p = this.provinces.get(pk);
    return p ? p.rgb || PALETTE[p.c] : PALETTE[0];
  }

  countryOf(pk) {
    const p = this.provinces.get(pk);
    return (p && p.k) || HOME_COUNTRY;
  }

  countryName(code) {
    return COUNTRIES[code] || this.countries.get(code) || code;
  }

  // Players may only change what already exists in the database.
  provActionable(pk) {
    return this.provInDb.has(pk);
  }

  // Districts whose merge chain ends at r (alive or not).
  membersOf(r) {
    const out = [];
    for (let i = 0; i < this.geo.count; i++) if (this.root[i] === r) out.push(i);
    return out;
  }

  provinceMembers(pk) {
    const out = [];
    for (let i = 0; i < this.geo.count; i++) {
      const r = this.root[i];
      if (r >= 0 && this.prov[r] === pk) out.push(i);
    }
    return out;
  }

  // Districts whose merge chain passes through i (i included): they all come back with it.
  subtreeOf(i) {
    const out = [];
    for (let j = 0; j < this.geo.count; j++) {
      for (let k = j, steps = 0; k >= 0 && steps <= this.geo.count; k = this.merge[k], steps++) {
        if (k === i) { out.push(j); break; }
      }
    }
    return out;
  }

  provinceAlive(pk) {
    const p = this.provinces.get(pk);
    return !!p && !p.x;
  }

  // Province a sunk district returns to: the one its group was in when it sank,
  // otherwise its own earlier one; null when both are under water too.
  reviveProvince(i) {
    const r = this.root[i];
    for (const pk of [r >= 0 ? this.prov[r] : null, this.prov[i]]) if (pk && this.provinceAlive(pk)) return pk;
    return null;
  }

  // The sunk province that took district i down with it, if any.
  sunkProvinceOf(i) {
    const r = this.root[i];
    if (r < 0) return null;
    const p = this.provinces.get(this.prov[r]);
    return p && p.x ? this.prov[r] : null;
  }

  // Districts that come back if province pk is raised (those not sunk on their own).
  provinceReviveCount(pk) {
    let n = 0;
    for (let i = 0; i < this.geo.count; i++) {
      const r = this.root[i];
      if (r >= 0 && this.prov[r] === pk && !this.del[r]) n++;
    }
    return n;
  }

  boxOf(members) {
    const b = this.geo.box;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of members) {
      x0 = Math.min(x0, b[i * 4]); y0 = Math.min(y0, b[i * 4 + 1]);
      x1 = Math.max(x1, b[i * 4 + 2]); y1 = Math.max(y1, b[i * 4 + 3]);
    }
    return [x0, y0, x1, y1];
  }

  // Colour for a brand-new province: avoid the colours touching this group.
  pickColor(r) {
    const g = this.geo;
    const near = new Set();
    for (const i of this.groups.get(r) || [r]) {
      for (const a of g.distArcs[i]) {
        for (const s of [g.sides[a * 2], g.sides[a * 2 + 1]]) {
          if (s >= 0 && this.alive[s] && this.root[s] !== r) near.add(this.fill[s]);
        }
      }
    }
    const usage = new Array(PALETTE_SIZE).fill(0);
    for (const pk of this.provGroups.keys()) usage[this.provColor(pk)]++;
    let best = 0, bestScore = Infinity;
    for (let c = 0; c < PALETTE_SIZE; c++) {
      const score = (near.has(PALETTE[c]) ? 1000 : 0) + usage[c];
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }
}
