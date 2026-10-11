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

function seed() {
  const d = {}, p = {};
  map.d.names.forEach((n, i) => { d[`d${i}`] = { n, p: `p${map.d.prov[i]}` }; });
  for (const [k, [n, c]] of Object.entries(map.provinces)) p[`p${k}`] = { n, c };
  return { v: 1, d, p };
}

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
await expectDenied('partial seed', set(ref(a.db, 'state'), { v: 1, d: { d0: { n: 'X', p: 'p1' } }, p: { p1: { n: 'Adana', c: 0 } } }));
await expectOk('full seed', set(ref(a.db, 'state'), seed()));
await expectDenied('second seed', set(ref(b.db, 'state'), seed()));

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

console.log('anonymous access');
const anon = initializeApp({ projectId: PROJECT, databaseURL: `http://${HOST}:${PORT}?ns=${PROJECT}` }, 'anon');
const anonDb = getDatabase(anon);
connectDatabaseEmulator(anonDb, HOST, PORT);
await expectOk('public read of state', get(ref(anonDb, 'state/d/d5')));
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
