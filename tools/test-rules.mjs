// Tests database.rules.json against the Realtime Database emulator.
//   cd tools && npm install
//   npx firebase-tools emulators:exec --only database --project demo-ilceler "node tools/test-rules.mjs"
// (run from the repository root so firebase.json is picked up). If the rules are not
// loaded yet (e.g. a bare emulator JAR), this script uploads them itself.

import fs from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getDatabase, connectDatabaseEmulator, ref, update, get, serverTimestamp, push, set } from 'firebase/database';

const map = JSON.parse(fs.readFileSync(new URL('../data/map.json', import.meta.url)));
const PROJECT = 'demo-ilceler';
const TS = serverTimestamp();
let appCount = 0;
let failures = 0;

const HOST = '127.0.0.1', PORT = 9000;
await fetch(`http://${HOST}:${PORT}/.settings/rules.json?ns=${PROJECT}`, {
  method: 'PUT', headers: { Authorization: 'Bearer owner' },
  body: fs.readFileSync(new URL('../database.rules.json', import.meta.url)),
}).then((r) => { if (!r.ok) throw new Error(`could not load rules: ${r.status}`); });
await fetch(`http://${HOST}:${PORT}/.json?ns=${PROJECT}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } });

// Each "user" gets its own app instance signed in with an emulator mock token.
async function user() {
  const uid = `user${appCount}x${Math.random().toString(36).slice(2, 8)}`;
  const app = initializeApp({ projectId: PROJECT, databaseURL: `http://${HOST}:${PORT}?ns=${PROJECT}` }, `u${appCount++}`);
  const db = getDatabase(app);
  connectDatabaseEmulator(db, HOST, PORT, { mockUserToken: { sub: uid, user_id: uid, firebase: { sign_in_provider: 'anonymous' } } });
  return { db, uid };
}

// The original map (what the first site version seeded) ...
function seed() {
  const d = {}, p = {};
  map.d.names.forEach((n, i) => { if (i < map.base.d) d[`d${i}`] = { n, p: `p${map.d.prov[i]}` }; });
  for (const [k, [n, c]] of Object.entries(map.provinces)) if (+k <= map.base.p) p[`p${k}`] = { n, c };
  return { v: 1, d, p };
}

// ... and what newer versions add on top of it (Cyprus).
function topUp() {
  const u = {};
  for (const [k, [n, c, country]] of Object.entries(map.provinces)) if (+k > map.base.p) u[`state/p/p${k}`] = { n, c, k: country };
  map.d.names.forEach((n, i) => { if (i >= map.base.d) u[`state/d/d${i}`] = { n, p: `p${map.d.prov[i]}` }; });
  return u;
}
const idx = (name) => map.d.names.indexOf(name);

async function node(db, path) { return (await get(ref(db, path))).val(); }

// Builds the multi-path update the site sends for one action: only the changed
// fields of the target node are written, plus the cooldown and the log entry.
async function action(u, kind, id, fields, log, extra = {}) {
  const updates = {
    [`state/${kind}/${id}/t`]: TS,
    [`cool/${u.uid}`]: { t: TS, k: kind, i: id },
    [`log/${push(ref(u.db, 'log')).key}`]: { u: u.uid, t: TS, a: log, i: id, s: 'x' },
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) updates[`state/${kind}/${id}/${k}`] = v;
  return update(ref(u.db), updates);
}

async function expectOk(name, p) {
  try { await p; console.log(`  ok    ${name}`); } catch (e) { failures++; console.log(`  FAIL  ${name}: expected success, got ${e.message}`); }
}
async function expectDenied(name, p) {
  try { await p; failures++; console.log(`  FAIL  ${name}: expected PERMISSION_DENIED, but it was allowed`); } catch (e) {
    if (/permission/i.test(e.message)) console.log(`  ok    ${name} (denied)`);
    else { failures++; console.log(`  FAIL  ${name}: ${e.message}`); }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await user();
const b = await user();
const c = await user();
const fresh = async () => user();

console.log('seeding');
await expectDenied('top-up before the map is seeded', update(ref(a.db), topUp()));
await expectDenied('partial seed', set(ref(a.db, 'state'), { v: 1, d: { d0: { n: 'X', p: 'p1' } }, p: { p1: { n: 'Adana', c: 0 } } }));
await expectOk('full seed', set(ref(a.db, 'state'), seed()));
await expectDenied('second seed', set(ref(b.db, 'state'), seed()));
await expectOk('top-up adds the Cyprus provinces and districts', update(ref(a.db), topUp()));
await expectDenied('second top-up', update(ref(b.db), topUp()));
await expectDenied('top-up overwriting an original district', update(ref(b.db), { 'state/d/d5': { n: 'Ele geçirildi', p: 'p1' } }));
await expectDenied('top-up of a sunk district', update(ref(b.db), { 'state/d/d990': { n: 'Batık', p: 'p82', x: true } }));
await expectDenied('top-up of an original-range province', update(ref(b.db), { 'state/p/p50': { n: 'Sahte', c: 1 } }));

console.log('cooldown');
await expectOk('rename d5', action(a, 'd', 'd5', { n: 'Yeni Ad' }, 'ren'));
await expectDenied('second action within 10 s', action(a, 'd', 'd6', { n: 'Olmaz' }, 'ren'));
await expectDenied('cooldown reset by writing cool alone', update(ref(a.db), { [`cool/${a.uid}`]: { t: TS, k: 'd', i: 'd6' } }));

console.log('one target per action');
const u1 = await fresh();
await expectDenied('two districts in one update', action(u1, 'd', 'd7', { x: true }, 'del', {
  'state/d/d8/x': true, 'state/d/d8/t': TS,
}));
await expectDenied('removing a required field', action(u1, 'd', 'd7', { n: null }, 'ren'));
await expectDenied('unknown field', action(u1, 'd', 'd7', { z: 1 }, 'ren'));
await expectDenied('deleting a district node', update(ref(u1.db), { 'state/d/d7': null, [`cool/${u1.uid}`]: { t: TS, k: 'd', i: 'd7' } }));
await expectDenied('state change without cooldown entry', update(ref(u1.db), { 'state/d/d7': { n: 'Z', p: `p${map.d.prov[7]}`, t: TS } }));
await expectDenied('client-chosen timestamp', update(ref(u1.db), {
  'state/d/d7': { n: 'Z', p: `p${map.d.prov[7]}`, t: Date.now() },
  [`cool/${u1.uid}`]: { t: Date.now(), k: 'd', i: 'd7' },
}));
await expectDenied('log entry without a state change', update(ref(u1.db), { [`log/${push(ref(u1.db, 'log')).key}`]: { u: u1.uid, t: TS, a: 'del', i: 'd7' } }));
await expectDenied('writing another user\'s cooldown', update(ref(u1.db), {
  'state/d/d7': { n: 'Z', p: `p${map.d.prov[7]}`, t: TS },
  [`cool/${a.uid}`]: { t: TS, k: 'd', i: 'd7' },
}));

console.log('merge rules');
const u2 = await fresh(), u3 = await fresh(), u4 = await fresh(), u5 = await fresh();
await expectOk('merge d1 -> d2', action(u2, 'd', 'd1', { m: 'd2' }, 'mrg'));
await expectDenied('merge d2 -> d1 (target already merged)', action(u3, 'd', 'd2', { m: 'd1' }, 'mrg'));
await expectDenied('rename merged d1', action(u4, 'd', 'd1', { n: 'Hayalet' }, 'ren'));
await expectDenied('merge into itself', action(u5, 'd', 'd3', { m: 'd3' }, 'mrg'));
await expectDenied('merge into unknown district', action(u5, 'd', 'd3', { m: 'd9999' }, 'mrg'));
await expectOk('merge far-away d3 -> d900', action(u5, 'd', 'd3', { m: 'd900' }, 'mrg'));

console.log('delete rules');
const u6 = await fresh(), u7 = await fresh(), u8 = await fresh();
await expectOk('delete d10', action(u6, 'd', 'd10', { x: true }, 'del'));
await expectDenied('merge into deleted d10', action(u7, 'd', 'd11', { m: 'd10' }, 'mrg'));
await expectDenied('rename deleted d10', action(u8, 'd', 'd10', { n: 'Atlantis' }, 'ren'));

console.log('province rules');
const u9 = await fresh(), u10 = await fresh(), u11 = await fresh(), u12 = await fresh(), u13 = await fresh(), u14 = await fresh();
const inP5 = map.d.prov.indexOf(5), inP6 = map.d.prov.indexOf(6);
await expectOk('rename province p6', action(u9, 'p', 'p6', { n: 'Başkent' }, 'pren'));
await expectOk('delete province p5', action(u10, 'p', 'p5', { x: true }, 'pdel'));
await expectDenied('rename district in deleted province', action(u11, 'd', `d${inP5}`, { n: 'Hayat' }, 'ren'));
await expectDenied('move district into deleted province', action(u11, 'd', `d${inP6}`, { p: 'p5' }, 'prv'));
await expectDenied('merge into district of deleted province', action(u11, 'd', `d${inP6}`, { m: `d${inP5}` }, 'mrg'));
await expectDenied('rename deleted province', action(u12, 'p', 'p5', { n: 'Dirilis' }, 'pren'));
await expectOk('move district to p34', action(u11, 'd', `d${inP6}`, { p: 'p34' }, 'prv'));
const newKey = push(ref(u13.db, 'state/p')).key;
await expectOk('move district to a new province', action(u13, 'd', `d${inP6 + 1}`, { p: newKey }, 'prv', { [`state/p/${newKey}`]: { n: 'Yeni İl', c: 3 } }));
const concurrentA = await fresh(), concurrentB = await fresh();
const target = `d${inP6 + 3}`;
await Promise.all([
  expectOk('concurrent rename', action(concurrentA, 'd', target, { n: 'Eşzamanlı' }, 'ren')),
  expectOk('concurrent province change', action(concurrentB, 'd', target, { p: 'p34' }, 'prv')),
]);
const both = await node(a.db, `state/d/${target}`);
if (both.n !== 'Eşzamanlı' || both.p !== 'p34') { failures++; console.log('  FAIL  concurrent edits clobbered each other', both); } else console.log('  ok    concurrent edits both kept');
const strayKey = push(ref(u14.db, 'state/p')).key;
await expectDenied('create a province without moving a district into it', action(u14, 'd', `d${inP6 + 2}`, { n: 'Q' }, 'ren', { [`state/p/${strayKey}`]: { n: 'Boş İl', c: 1 } }));
await expectDenied('name too long', action(u14, 'd', `d${inP6 + 2}`, { n: 'x'.repeat(31) }, 'ren'));

console.log('reviving sunk districts and provinces');
const r = [];
for (let k = 0; k < 12; k++) r.push(await fresh());
const isAlive = async (i) => {
  const d = await node(a.db, `state/d/d${i}`);
  return !d.x && !d.m && !(await node(a.db, `state/p/${d.p}/x`));
};
await expectOk('revive sunk d10 into its province', action(r[0], 'd', 'd10', { x: null, p: `p${map.d.prov[10]}` }, 'rev'));
if (!(await isAlive(10))) { failures++; console.log('  FAIL  d10 should be alive again'); }
await expectOk('sink group d2 (d1 is merged into it)', action(r[1], 'd', 'd2', { x: true }, 'del'));
await expectOk('revive merged member d1 on its own', action(r[2], 'd', 'd1', { m: null, p: `p${map.d.prov[1]}` }, 'rev'));
await expectDenied('revive that also merges', action(r[3], 'd', 'd2', { x: null, m: 'd1' }, 'rev'));
await expectDenied('revive that keeps x', action(r[3], 'd', 'd2', { p: `p${map.d.prov[2]}` }, 'rev'));
await expectDenied('revive into a sunk province', action(r[3], 'd', `d${inP5}`, { p: 'p5' }, 'rev'));
await expectDenied('revive that keeps the sunk province', action(r[3], 'd', `d${inP5}`, { n: 'Hayalet' }, 'rev'));
await expectOk('revive district of a sunk province into p34', action(r[4], 'd', `d${inP5}`, { p: 'p34' }, 'rev'));
const atlantis = push(ref(r[5].db, 'state/p')).key;
await expectOk('revive into a brand-new province', action(r[5], 'd', 'd2', { x: null, p: atlantis }, 'rev', { [`state/p/${atlantis}`]: { n: 'Atlantis', c: 2 } }));
await expectDenied('revive province while keeping x', action(r[6], 'p', 'p5', { n: 'Yarım' }, 'pren'));
await expectOk('revive sunk province p5', action(r[7], 'p', 'p5', { x: null }, 'prev'));
await expectOk('rename the revived province', action(r[8], 'p', 'p5', { n: 'Geri Dönen' }, 'pren'));
await expectOk('normal action in the revived province', action(r[9], 'd', `d${inP5 + 1}`, { n: 'Yaşıyor' }, 'ren'));
await expectOk('sink again after revival', action(r[10], 'd', 'd10', { x: true }, 'del'));
await expectDenied('unknown log action', action(r[11], 'd', 'd30', { n: 'Q' }, 'zzz'));

console.log('countries, colours and Cyprus');
const q = [];
for (let k = 0; k < 12; k++) q.push(await fresh());
const girne = idx('Girne');
await expectOk('rename a Cyprus district', action(q[0], 'd', `d${girne}`, { n: 'Kyrenia' }, 'ren'));
await expectOk('merge a Turkish district into a Cyprus one', action(q[1], 'd', `d${idx('Ayvalık')}`, { m: `d${girne}` }, 'mrg'));
await expectOk('custom province colour', action(q[2], 'p', 'p6', { rgb: '#12ab9f', c: 3 }, 'pclr'));
await expectDenied('colour not in #rrggbb form', action(q[3], 'p', 'p7', { rgb: 'red' }, 'pclr'));
await expectDenied('upper-case colour', action(q[3], 'p', 'p7', { rgb: '#FF0000' }, 'pclr'));
await expectOk('back to a palette colour', action(q[3], 'p', 'p6', { rgb: null, c: 1 }, 'pclr'));
await expectOk('province to another country', action(q[4], 'p', 'p22', { k: 'BG' }, 'pcty'));
await expectDenied('lower-case country code', action(q[5], 'p', 'p39', { k: 'bg' }, 'pcty'));
await expectDenied('unknown custom country', action(q[5], 'p', 'p39', { k: '-NotACountry12345' }, 'pcty'));
const trakya = push(ref(q[5].db, 'state/c')).key;
await expectOk('province to a brand-new country', action(q[5], 'p', 'p39', { k: trakya }, 'pcty', { [`state/c/${trakya}`]: { n: 'Trakya Cumhuriyeti' } }));
const stray = push(ref(q[6].db, 'state/c')).key;
await expectDenied('a country nobody uses', action(q[6], 'p', 'p59', { n: 'Rodosto' }, 'pren', { [`state/c/${stray}`]: { n: 'Boş Ülke' } }));
const np = push(ref(q[7].db, 'state/p')).key, nc = push(ref(q[7].db, 'state/c')).key;
await expectOk('district to a new province in a new country', action(q[7], 'd', `d${idx('Bandırma')}`, { p: np }, 'dcty',
  { [`state/p/${np}`]: { n: 'Yeni İl', c: 2, k: nc }, [`state/c/${nc}`]: { n: 'Yeni Ülke' } }));
const np2 = push(ref(q[8].db, 'state/p')).key;
await expectOk('district to a new province in a real country', action(q[8], 'd', `d${idx('Edremit')}`, { p: np2 }, 'dcty',
  { [`state/p/${np2}`]: { n: 'Selanik', c: 1, k: 'GR' } }));
await expectOk('district into a Cyprus province', action(q[9], 'd', `d${idx('Erdek')}`, { p: 'p82' }, 'prv'));
await expectOk('sink a Cyprus district', action(q[10], 'd', `d${idx('Baf')}`, { x: true }, 'del'));
await expectOk('raise it again', action(q[11], 'd', `d${idx('Baf')}`, { x: null, p: 'p83' }, 'rev'));

console.log('anonymous access');
const anon = initializeApp({ projectId: PROJECT, databaseURL: `http://${HOST}:${PORT}?ns=${PROJECT}` }, 'anon');
const anonDb = getDatabase(anon);
connectDatabaseEmulator(anonDb, HOST, PORT);
await expectOk('public read of state', get(ref(anonDb, 'state/d/d5')));
await expectOk('public read of the feature flags', get(ref(anonDb, 'caps')));
await expectOk('public read of the v3 feature flag', get(ref(anonDb, 'caps3')));
await expectOk('public read of custom countries', get(ref(anonDb, `state/c/${trakya}`)));
await expectDenied('read someone else\'s cooldown', get(ref(b.db, `cool/${a.uid}`)));
await expectDenied('write without auth', update(ref(anonDb), { 'state/d/d20': { n: 'Z', p: `p${map.d.prov[20]}`, t: TS } }));

console.log('cooldown expiry (waiting 10 s)');
await sleep(10200);
await expectOk('action after 10 s', action(a, 'd', 'd6', { n: 'Artık Olur' }, 'ren'));
await expectDenied('and again immediately', action(a, 'd', 'd12', { n: 'Olmaz' }, 'ren'));

const st = await node(a.db, 'state/d/d5');
if (st.n !== 'Yeni Ad') { failures++; console.log('  FAIL  rename not stored'); }

console.log(failures ? `\n${failures} FAILED` : '\nall rule tests passed');
process.exit(failures ? 1 : 0);
