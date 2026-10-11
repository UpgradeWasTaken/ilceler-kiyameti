// Builds data/map.json: Turkish districts (ilçeler) with shared-border topology,
// projected to Web Mercator, simplified and quantized for fast canvas rendering.
//
//   cd tools && npm install && NODE_USE_ENV_PROXY=1 node build-map.mjs
//
// Sources (downloaded into tools/.cache on first run):
//   - Districts & provinces: geoBoundaries gbOpen TUR ADM2/ADM1
//     (derived from OpenStreetMap, ODbL 1.0 — © OpenStreetMap contributors)
//   - Lakes and neighbouring countries: Natural Earth 1:10m (public domain)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mapshaper from 'mapshaper';
import polylabel from 'polylabel';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, '.cache');
const OUT = path.join(HERE, '..', 'data', 'map.json');

const GB = 'https://media.githubusercontent.com/media/wmgeolab/geoBoundaries/main/releaseData/gbOpen/TUR';
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const SOURCES = {
  adm2: `${GB}/ADM2/geoBoundaries-TUR-ADM2.geojson`,
  adm1: `${GB}/ADM1/geoBoundaries-TUR-ADM1.geojson`,
  lakes: `${NE}/ne_10m_lakes.geojson`,
  lakesEu: `${NE}/ne_10m_lakes_europe.geojson`,
  countries: `${NE}/ne_10m_admin_0_countries.geojson`,
};

// Area shown around Turkey (lon/lat). Neighbouring land is clipped to this box.
const VIEW_BBOX = [18.0, 30.5, 52.0, 47.5];
// Simplification tolerance in projected metres and the quantization grid.
const SIMPLIFY_INTERVAL = 80;
const QUANTUM = 30;
// Neighbouring countries are background only: simplify their coasts harder (metres).
const LAND_TOLERANCE = 300;

// Plate code -> official province name.
const PROVINCES = {
  1: 'Adana', 2: 'Adıyaman', 3: 'Afyonkarahisar', 4: 'Ağrı', 5: 'Amasya', 6: 'Ankara', 7: 'Antalya',
  8: 'Artvin', 9: 'Aydın', 10: 'Balıkesir', 11: 'Bilecik', 12: 'Bingöl', 13: 'Bitlis', 14: 'Bolu',
  15: 'Burdur', 16: 'Bursa', 17: 'Çanakkale', 18: 'Çankırı', 19: 'Çorum', 20: 'Denizli',
  21: 'Diyarbakır', 22: 'Edirne', 23: 'Elazığ', 24: 'Erzincan', 25: 'Erzurum', 26: 'Eskişehir',
  27: 'Gaziantep', 28: 'Giresun', 29: 'Gümüşhane', 30: 'Hakkari', 31: 'Hatay', 32: 'Isparta',
  33: 'Mersin', 34: 'İstanbul', 35: 'İzmir', 36: 'Kars', 37: 'Kastamonu', 38: 'Kayseri',
  39: 'Kırklareli', 40: 'Kırşehir', 41: 'Kocaeli', 42: 'Konya', 43: 'Kütahya', 44: 'Malatya',
  45: 'Manisa', 46: 'Kahramanmaraş', 47: 'Mardin', 48: 'Muğla', 49: 'Muş', 50: 'Nevşehir',
  51: 'Niğde', 52: 'Ordu', 53: 'Rize', 54: 'Sakarya', 55: 'Samsun', 56: 'Siirt', 57: 'Sinop',
  58: 'Sivas', 59: 'Tekirdağ', 60: 'Tokat', 61: 'Trabzon', 62: 'Tunceli', 63: 'Şanlıurfa',
  64: 'Uşak', 65: 'Van', 66: 'Yozgat', 67: 'Zonguldak', 68: 'Aksaray', 69: 'Bayburt', 70: 'Karaman',
  71: 'Kırıkkale', 72: 'Batman', 73: 'Şırnak', 74: 'Bartın', 75: 'Ardahan', 76: 'Iğdır',
  77: 'Yalova', 78: 'Karabük', 79: 'Kilis', 80: 'Osmaniye', 81: 'Düzce',
};
const PROVINCE_ALIASES = { 'Hakkâri': 'Hakkari' };

// Source names that are wrong, English or not in official form.
const NAME_FIXES = {
  'Imbros': 'Gökçeada',
  'Prince Islands': 'Adalar',
  'Ayvacik': 'Ayvacık',
  'Ulukisla': 'Ulukışla',
  'Şarkîkaraağaç': 'Şarkikaraağaç',
  'Gediz Merkez': 'Gediz',
  'Giresun District': 'Giresun Merkez',
};

// Fill colours by index; chosen to resemble classic Turkish school atlases.
const PALETTE_SIZE = 8;

// [name, lon, lat] and [name, lon, lat, size, rotation°]
const COUNTRY_LABELS = [
  ['YUNANİSTAN', 22.6, 40.2], ['BULGARİSTAN', 26.4, 42.62], ['GÜRCİSTAN', 43.15, 41.95],
  ['ERMENİSTAN', 44.45, 40.55], ['AZERBAYCAN', 45.45, 39.32], ['İRAN', 45.6, 37.4],
  ['IRAK', 43.4, 36.35], ['SURİYE', 38.6, 35.75], ['KIBRIS', 33.2, 35.0],
];
const SEA_LABELS = [
  ['K A R A D E N İ Z', 34.4, 42.75, 1.6, 0], ['A K D E N İ Z', 31.2, 35.25, 1.6, 0],
  ['E G E  D E N İ Z İ', 25.42, 38.3, 1.1, -90], ['MARMARA DENİZİ', 28.05, 40.78, 0.8, 0],
];

const trCollator = new Intl.Collator('tr');

async function download(key) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `${key}.geojson`);
  if (!fs.existsSync(file)) {
    console.log(`downloading ${SOURCES[key]}`);
    const res = await fetch(SOURCES[key]);
    if (!res.ok) throw new Error(`${res.status} ${SOURCES[key]}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return fs.readFileSync(file, 'utf8');
}

async function ms(commands, inputs) {
  const out = await mapshaper.applyCommands(commands, inputs);
  for (const k of Object.keys(out)) if (typeof out[k] !== 'string') out[k] = Buffer.from(out[k]).toString('utf8');
  return out;
}

function cleanName(raw, provinceName) {
  let name = NAME_FIXES[raw] || raw.trim();
  if (name === 'Merkez' || name === provinceName) return `${provinceName} Merkez`;
  const m = name.match(/^(.*?)\s*\(?\s*merkez(i| ilçe)?\s*\)?$/i);
  if (m && m[1]) return `${provinceName} Merkez`;
  return name;
}

// Ellipsoidal Web Mercator, matching "+proj=merc +lon_0=35 +datum=WGS84".
const A = 6378137, E = 0.0818191908426215, LON0 = 35;
function mercator(lon, lat) {
  const phi = (lat * Math.PI) / 180;
  const es = E * Math.sin(phi);
  const y = A * Math.log(Math.tan(Math.PI / 4 + phi / 2) * Math.pow((1 - es) / (1 + es), E / 2));
  return [A * ((lon - LON0) * Math.PI) / 180, y];
}

async function main() {
  const [adm2, adm1, lakes, lakesEu, countries] = await Promise.all(
    ['adm2', 'adm1', 'lakes', 'lakesEu', 'countries'].map(download));

  // 1. Assign every district to a province with a point-in-polygon join.
  const joined = JSON.parse((await ms(
    '-i adm2.json -each "fid=this.id" -points inner -join adm1.json fields=shapeName prefix=prov_ -o format=json pts.json',
    { 'adm2.json': adm2, 'adm1.json': adm1 }))['pts.json']);
  const plateByName = Object.fromEntries(Object.entries(PROVINCES).map(([k, v]) => [v, +k]));

  const adm2Json = JSON.parse(adm2);
  const districts = adm2Json.features.map((f, fid) => {
    const provName = PROVINCE_ALIASES[joined[fid].prov_shapeName] || joined[fid].prov_shapeName;
    const plate = plateByName[provName];
    if (!plate) throw new Error(`no province for ${f.properties.shapeName}`);
    return { geometry: f.geometry, plate, name: cleanName(f.properties.shapeName, provName) };
  });
  districts.sort((a, b) => a.plate - b.plate || trCollator.compare(a.name, b.name));
  const perProvince = {};
  for (const d of districts) perProvince[d.plate] = (perProvince[d.plate] || 0) + 1;
  console.log(`${districts.length} districts in ${Object.keys(perProvince).length} provinces`);

  // 2. Lakes worth showing (> 40 km²) inside Turkey.
  const lakesSel = (await ms(
    `-i lakes.json lakesEu.json combine-files -merge-layers force -clip bbox=25.6,35.8,44.9,42.2 -filter "this.area > 40e6" -filter-fields name -o format=geojson out.json`,
    { 'lakes.json': lakes, 'lakesEu.json': lakesEu }))['out.json'];
  const lakeFeatures = JSON.parse(lakesSel).features;
  console.log(`lakes: ${lakeFeatures.map((f) => f.properties.name || '?').join(', ')}`);

  // 3. Neighbouring countries inside the view box.
  const ne = JSON.parse((await ms(
    `-i countries.json -clip bbox=${VIEW_BBOX.join(',')} -filter-fields ADM0_A3 -o format=geojson out.json`,
    { 'countries.json': countries }))['out.json']).features;

  // Everything goes into one layer so mapshaper builds a single shared topology:
  // the neighbour land is cut exactly along Turkey's border and shares its arcs.
  const combined = { type: 'FeatureCollection', features: [] };
  districts.forEach((d, i) => combined.features.push({ type: 'Feature', properties: { k: 'd', i }, geometry: d.geometry }));
  for (const f of ne) {
    combined.features.push({ type: 'Feature', properties: { k: 'ne' }, geometry: f.geometry });
    if (f.properties.ADM0_A3 === 'TUR') combined.features.push({ type: 'Feature', properties: { k: 'netur' }, geometry: f.geometry });
  }
  for (const f of lakeFeatures) combined.features.push({ type: 'Feature', properties: { k: 'lake' }, geometry: f.geometry });

  const topoOut = await ms([
    '-i all.json name=all',
    '-filter target=all "k==\'d\'" + name=d',
    '-filter target=all "k==\'ne\'" + name=ne',
    '-filter target=all "k==\'netur\'" + name=netur',
    '-filter target=all "k==\'lake\'" + name=lake',
    '-dissolve target=d + name=outline',
    '-dissolve target=ne + name=land',
    '-erase target=land source=outline',
    '-explode target=land',
    '-each target=land "pid=this.id"',
    '-points target=land inner + name=lp',
    '-join target=lp source=netur fields=k',
    '-join target=land source=lp keys=pid,pid fields=k',
    // Slivers between the Natural Earth and OSM coastlines lie inside NE's Turkey: drop them.
    '-filter target=land "k!==\'netur\'"',
    '-dissolve target=land',
    '-erase target=d source=lake',
    '-proj target=d,land +proj=merc +lon_0=35 +datum=WGS84',
    `-simplify interval=${SIMPLIFY_INTERVAL} keep-shapes`,
    '-filter-islands target=d min-area=0.15km2',
    '-filter-islands target=land min-area=4km2',
    '-filter-slivers target=d min-area=0.05km2',
    '-o target=d,land format=topojson no-quantization out.json',
  ].join(' '), { 'all.json': JSON.stringify(combined) });
  const topo = JSON.parse(topoOut['out.json']);

  // 4. Quantize to a 30 m grid in screen orientation (y down) and re-encode arcs.
  const dGeoms = topo.objects.d.geometries;
  const landGeoms = topo.objects.land.geometries;
  let minX = Infinity, maxY = -Infinity;
  const usedArcs = new Set();
  const markArcs = (a) => (Array.isArray(a) ? a.forEach(markArcs) : usedArcs.add(a < 0 ? ~a : a));
  for (const g of dGeoms) markArcs(g.arcs);
  for (const g of landGeoms) markArcs(g.arcs || []);
  for (const g of dGeoms) for (const p of flatPoints(topo, g)) { if (p[0] < minX) minX = p[0]; if (p[1] > maxY) maxY = p[1]; }
  const toWorld = ([x, y]) => [Math.round((x - minX) / QUANTUM), Math.round((maxY - y) / QUANTUM)];

  const districtArcs = new Set();
  const markDistrict = (a) => (Array.isArray(a) ? a.forEach(markDistrict) : districtArcs.add(a < 0 ? ~a : a));
  for (const g of dGeoms) markDistrict(g.arcs);

  const arcRemap = new Map();
  const arcsOut = [];
  for (const i of [...usedArcs].sort((a, b) => a - b)) {
    const pts = [];
    const src = districtArcs.has(i) ? topo.arcs[i] : douglasPeucker(topo.arcs[i], LAND_TOLERANCE);
    for (const p of src) {
      const q = toWorld(p);
      const last = pts[pts.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
    }
    if (pts.length === 1) pts.push(pts[0]);
    const flat = [pts[0][0], pts[0][1]];
    for (let j = 1; j < pts.length; j++) flat.push(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]);
    arcRemap.set(i, arcsOut.length);
    arcsOut.push(flat);
  }
  const remap = (a) => (Array.isArray(a) ? a.map(remap) : a < 0 ? ~arcRemap.get(~a) : arcRemap.get(a));
  const asMulti = (g) => (g.type === 'Polygon' ? [g.arcs] : g.type === 'MultiPolygon' ? g.arcs : []);

  const decodedArcs = arcsOut.map((flat) => {
    const pts = [];
    let x = 0, y = 0;
    for (let j = 0; j < flat.length; j += 2) { x += flat[j]; y += flat[j + 1]; pts.push([x, y]); }
    return pts;
  });
  const ringPoints = (ring) => {
    const pts = [];
    for (const a of ring) {
      const arc = a < 0 ? decodedArcs[~a].slice().reverse() : decodedArcs[a];
      for (let j = pts.length ? 1 : 0; j < arc.length; j++) pts.push(arc[j]);
    }
    return pts;
  };
  const ringArea = (pts) => {
    let s = 0;
    for (let j = 0, n = pts.length, k = n - 1; j < n; k = j++) s += pts[k][0] * pts[j][1] - pts[j][0] * pts[k][1];
    return s / 2;
  };

  // 5. Per-district geometry, area and label anchor (pole of inaccessibility).
  const byIndex = new Array(districts.length);
  for (const g of dGeoms) byIndex[g.properties.i] = g;
  const missing = byIndex.map((g, i) => (g ? null : districts[i].name)).filter(Boolean);
  if (missing.length) throw new Error(`districts lost during processing: ${missing.join(', ')}`);

  const out = { names: [], prov: [], geom: [], area: [], label: [] };
  districts.forEach((d, i) => {
    const polys = remap(asMulti(byIndex[i]));
    let total = 0, best = null, bestArea = -1;
    for (const poly of polys) {
      const rings = poly.map(ringPoints);
      const a = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
      total += a;
      if (a > bestArea) { bestArea = a; best = rings; }
    }
    const lp = polylabel(best, 1);
    out.names.push(d.name);
    out.prov.push(d.plate);
    out.geom.push(polys);
    out.area.push(Math.round(total));
    out.label.push([Math.round(lp[0]), Math.round(lp[1])]);
  });

  // 6. Province adjacency -> map colouring (DSatur, balanced over the palette).
  const arcOwners = arcsOut.map(() => []);
  out.geom.forEach((polys, i) => {
    for (const poly of polys) for (const ring of poly) for (const a of ring) arcOwners[a < 0 ? ~a : a].push(i);
  });
  const adj = new Map(Object.keys(PROVINCES).map((p) => [+p, new Set()]));
  for (const owners of arcOwners) {
    if (owners.length !== 2) continue;
    const [pa, pb] = owners.map((i) => out.prov[i]);
    if (pa !== pb) { adj.get(pa).add(pb); adj.get(pb).add(pa); }
  }
  const colors = new Map();
  const usage = new Array(PALETTE_SIZE).fill(0);
  while (colors.size < adj.size) {
    let pick = null, bestSat = -1, bestDeg = -1;
    for (const [p, ns] of adj) {
      if (colors.has(p)) continue;
      const sat = new Set([...ns].filter((n) => colors.has(n)).map((n) => colors.get(n))).size;
      if (sat > bestSat || (sat === bestSat && ns.size > bestDeg)) { pick = p; bestSat = sat; bestDeg = ns.size; }
    }
    const taken = new Set([...adj.get(pick)].filter((n) => colors.has(n)).map((n) => colors.get(n)));
    let c = -1;
    for (let k = 0; k < PALETTE_SIZE; k++) if (!taken.has(k) && (c < 0 || usage[k] < usage[c])) c = k;
    colors.set(pick, c);
    usage[c]++;
  }

  const landPolys = remap(landGeoms.flatMap(asMulti));
  const project = ([name, lon, lat, ...rest]) => [name, ...toWorld(mercator(lon, lat)), ...rest];

  const result = {
    v: 1,
    quantum: QUANTUM,
    arcs: arcsOut,
    d: out,
    land: landPolys,
    provinces: Object.fromEntries(Object.entries(PROVINCES).map(([k, n]) => [k, [n, colors.get(+k)]])),
    countryLabels: COUNTRY_LABELS.map(project),
    seaLabels: SEA_LABELS.map(project),
    attribution: 'İlçe sınırları: © OpenStreetMap katkıcıları (ODbL) via geoBoundaries · Göller ve komşu ülkeler: Natural Earth',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result));
  const pts = arcsOut.reduce((s, a) => s + a.length / 2, 0);
  const shared = arcOwners.filter((o) => o.length === 2).length;
  console.log(`arcs: ${arcsOut.length} (${shared} shared), points: ${pts}, colour usage: ${usage.join(',')}`);
  console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}

function douglasPeucker(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let px = pts[i][0] - ax, py = pts[i][1] - ay;
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        px -= t * dx; py -= t * dy;
      }
      const d = px * px + py * py;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function* flatPoints(topo, g) {
  const walk = function* (a) {
    if (Array.isArray(a)) for (const x of a) yield* walk(x);
    else yield* topo.arcs[a < 0 ? ~a : a];
  };
  yield* walk(g.arcs);
}

main().catch((e) => { console.error(e); process.exit(1); });
