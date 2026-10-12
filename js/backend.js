// Live sync. FirebaseBackend talks to the Realtime Database (rules in
// database.rules.json enforce the 10 s cooldown server-side); LocalBackend is a
// same-interface demo used while no Firebase project is configured.
//
// Handlers: district(key, node), province(key, node), country(key, node),
//           log(key, entry, isLive), status(kind, detail), cooldown(untilServerMs), caps()

import { FIREBASE_CONFIG } from './config.js';
import { COOLDOWN_MS } from './state.js';

const LOG_LIMIT = 60;

// ?demo forces the local demo mode (handy for trying changes without touching the live game).
const useFirebase = () => {
  const q = new URLSearchParams(location.search);
  return !q.has('demo') && !!(q.get('emulator') || FIREBASE_CONFIG.apiKey);
};

// Starts downloading the Firebase SDK while the map data is still loading.
export function preloadBackend() {
  if (useFirebase()) import('../vendor/firebase.js').catch(() => {});
}

export async function createBackend(geo, handlers) {
  const emu = new URLSearchParams(location.search).get('emulator');
  if (useFirebase()) {
    const b = new FirebaseBackend(geo, handlers, emu);
    await b.start();
    return b;
  }
  const b = new LocalBackend(geo, handlers);
  b.start();
  return b;
}

// The original map, as the first version of the site seeded it ...
export function buildSeed(geo) {
  const d = {}, p = {};
  for (let i = 0; i < geo.base.d; i++) d[`d${i}`] = { n: geo.names[i], p: `p${geo.plates[i]}` };
  for (const [k, [n, c]] of Object.entries(geo.provinces)) if (+k <= geo.base.p) p[`p${k}`] = { n, c };
  return { v: 1, d, p };
}

// ... and the districts and provinces added since (Cyprus), as one multi-path update.
export function buildTopUp(geo) {
  const u = {};
  for (const [k, [n, c, country]] of Object.entries(geo.provinces)) {
    if (+k > geo.base.p) u[`state/p/p${k}`] = country ? { n, c, k: country } : { n, c };
  }
  for (let i = geo.base.d; i < geo.count; i++) u[`state/d/d${i}`] = { n: geo.names[i], p: `p${geo.plates[i]}` };
  return u;
}

function logEntry(uid, t, op, nick) {
  const e = { u: uid, t, a: op.log.a, i: op.id };
  if (op.log.s) e.s = String(op.log.s).slice(0, 64);
  if (op.log.o) e.o = String(op.log.o).slice(0, 64);
  if (nick) e.w = String(nick).slice(0, 24);
  return e;
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

function randomId(n = 16) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const a = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(a, (v) => abc[v % abc.length]).join('');
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode etc. */ }
}

class FirebaseBackend {
  constructor(geo, h, emu) {
    this.geo = geo;
    this.h = h;
    this.emu = emu;
    this.mode = emu ? 'emulator' : 'firebase';
    this.offset = 0;
    this.uid = null;
    this.canRevive = false;
    this.canV3 = false;
    this.capsChecked = 0;
  }

  now() { return Date.now() + this.offset; }

  // Each rules version makes one more /caps… node readable; older rules deny the read,
  // so the site keeps newer features hidden until their rules are published.
  // caps: raising from the sea · caps3: countries, colours and the Cyprus districts
  async checkCaps() {
    if ((this.canRevive && this.canV3) || Date.now() - this.capsChecked < 20000) return this.canRevive;
    this.capsChecked = Date.now();
    const readable = (path) => this.fb.get(this.fb.ref(this.db, path)).then(() => true, () => false);
    const [revive, v3] = await Promise.all([readable('caps'), readable('caps3')]);
    const changed = revive !== this.canRevive || v3 !== this.canV3;
    this.canRevive = revive;
    this.canV3 = v3;
    if (changed) {
      this.h.caps?.();
      if (v3) this.topUp();
    }
    return this.canRevive;
  }

  // Adds districts newer than the live database (once, by whichever visitor comes first).
  // Calls are queued so the check always sees the result of the previous one.
  topUp() {
    this.topUpQueue = (this.topUpQueue || Promise.resolve()).then(() => this.tryTopUp());
    return this.topUpQueue;
  }

  async tryTopUp() {
    if (this.toppedUp || !this.uid || !this.canV3) return;
    const { fb, db } = this;
    try {
      const [seeded, newest] = await Promise.all([
        fb.get(fb.ref(db, 'state/v')),
        fb.get(fb.ref(db, `state/d/d${this.geo.count - 1}`)),
      ]);
      if (!seeded.exists()) return; // not seeded yet; start() calls again afterwards
      if (!newest.exists()) await fb.update(fb.ref(db), buildTopUp(this.geo));
      this.toppedUp = true;
    } catch (e) {
      console.warn('top-up skipped:', e.message);
    }
  }

  async start() {
    const fb = (this.fb = await import('../vendor/firebase.js'));
    let config = FIREBASE_CONFIG, host, port;
    if (this.emu) {
      [host, port = '9000'] = this.emu === '1' ? ['127.0.0.1'] : this.emu.split(':');
      config = { projectId: 'demo-ilceler', databaseURL: `http://${host}:${port}?ns=demo-ilceler` };
    }
    const app = fb.initializeApp(config);
    const db = (this.db = fb.getDatabase(app));
    if (this.emu) {
      let uid = storageGet('ik-emu-uid');
      if (!uid) storageSet('ik-emu-uid', (uid = `emu${randomId(10)}`));
      fb.connectDatabaseEmulator(db, host, +port, { mockUserToken: { sub: uid, user_id: uid } });
      this.uid = uid;
    }
    const ref = (p) => fb.ref(db, p);

    // Public data first, so the map comes alive while sign-in is still running.
    fb.onValue(ref('.info/serverTimeOffset'), (s) => { this.offset = s.val() || 0; });
    fb.onValue(ref('.info/connected'), (s) => this.h.status(s.val() ? 'live' : 'connecting'));
    const dRef = ref('state/d'), pRef = ref('state/p'), cRef = ref('state/c');
    const onD = (s) => this.h.district(s.key, s.val());
    const onP = (s) => this.h.province(s.key, s.val());
    const onC = (s) => this.h.country(s.key, s.val());
    fb.onChildAdded(cRef, onC);
    fb.onChildChanged(cRef, onC);
    fb.onChildAdded(pRef, onP);
    fb.onChildChanged(pRef, onP);
    fb.onChildAdded(dRef, onD);
    fb.onChildChanged(dRef, onD);
    fb.onChildAdded(fb.query(ref('log'), fb.limitToLast(LOG_LIMIT)), (s) => {
      const e = s.val();
      if (e && typeof e === 'object') this.h.log(s.key, e, typeof e.t === 'number' && e.t > this.now() - 8000);
    });
    this.checkCaps();

    if (!this.uid) {
      try {
        this.uid = await this.signIn(fb, app);
      } catch (e) {
        console.error(e);
        this.h.status('error', /operation-not-allowed|admin-restricted/.test(e.code || '')
          ? 'Firebase konsolunda Anonymous giriş açık değil'
          : 'Giriş yapılamadı');
        return;
      }
    }
    fb.onValue(ref(`cool/${this.uid}`), (s) => {
      const v = s.val();
      this.h.cooldown(v && typeof v.t === 'number' ? v.t + COOLDOWN_MS : 0);
    });

    // An empty database is seeded with the original map by the first visitor.
    const seeded = await fb.get(ref('state/v')).catch(() => null);
    if (seeded && !seeded.exists()) {
      await fb.set(ref('state'), buildSeed(this.geo)).catch((e) => console.warn('seed skipped:', e.message));
    }
    this.topUp();
  }

  async signIn(fb, app) {
    const auth = fb.initializeAuth(app, { persistence: [fb.indexedDBLocalPersistence, fb.browserLocalPersistence] });
    const user = await new Promise((resolve) => {
      const off = fb.onAuthStateChanged(auth, (u) => { off(); resolve(u); });
    });
    if (user) return user.uid;
    return (await fb.signInAnonymously(auth)).user.uid;
  }

  newProvinceKey() {
    return this.fb.push(this.fb.ref(this.db, 'state/p')).key;
  }

  newCountryKey() {
    return this.fb.push(this.fb.ref(this.db, 'state/c')).key;
  }

  // One action = one atomic multi-path update: the changed fields of exactly one
  // district or province, this user's cooldown stamp and a log entry.
  async submit(op, nick) {
    if (!this.uid) throw fail('auth', 'Henüz bağlanılamadı');
    const { fb, db } = this;
    const TS = fb.serverTimestamp();
    const base = `state/${op.kind}/${op.id}`;
    const u = {};
    for (const [k, v] of Object.entries(op.fields)) u[`${base}/${k}`] = v;
    u[`${base}/t`] = TS;
    if (op.newProvince) {
      const np = op.newProvince;
      u[`state/p/${np.key}`] = np.k ? { n: np.n, c: np.c, k: np.k } : { n: np.n, c: np.c };
    }
    if (op.newCountry) u[`state/c/${op.newCountry.key}`] = { n: op.newCountry.n };
    u[`cool/${this.uid}`] = { t: TS, k: op.kind, i: op.id };
    u[`log/${fb.push(fb.ref(db, 'log')).key}`] = logEntry(this.uid, TS, op, nick);
    try {
      await fb.update(fb.ref(db), u);
    } catch (e) {
      throw fail(/permission/i.test(e.message) ? 'denied' : 'network', e.message);
    }
  }
}

// Demo mode: the same game in localStorage, synced between tabs of this browser.
class LocalBackend {
  constructor(geo, h) {
    this.geo = geo;
    this.h = h;
    this.mode = 'local';
    this.canRevive = true;
    this.canV3 = true;
    this.key = 'ik-demo-v1';
    this.uid = storageGet('ik-demo-uid');
    if (!this.uid) storageSet('ik-demo-uid', (this.uid = `demo${randomId(8)}`));
  }

  now() { return Date.now(); }

  load() {
    try {
      const v = JSON.parse(storageGet(this.key) || 'null');
      if (v && v.d && v.p && Array.isArray(v.log)) return { c: {}, ...v };
    } catch { /* corrupted: start over */ }
    return { d: {}, p: {}, c: {}, log: [] };
  }

  start() {
    this.data = this.load();
    this.emitAll(this.data, null);
    this.h.status('local');
    this.h.cooldown((+storageGet('ik-demo-cool') || 0) + COOLDOWN_MS);
    const onRemote = () => {
      const prev = this.data;
      this.data = this.load();
      this.emitAll(this.data, prev);
      this.h.cooldown((+storageGet('ik-demo-cool') || 0) + COOLDOWN_MS);
    };
    try { this.channel = new BroadcastChannel('ik-demo'); this.channel.onmessage = onRemote; } catch { /* old browser */ }
    window.addEventListener('storage', (e) => { if (e.key === this.key && !this.channel) onRemote(); });
  }

  emitAll(data, prev) {
    for (const [k, v] of Object.entries(data.c)) if (!prev || !prev.c[k]) this.h.country(k, v);
    for (const [k, v] of Object.entries(data.p)) if (!prev || JSON.stringify(prev.p[k]) !== JSON.stringify(v)) this.h.province(k, v);
    for (const [k, v] of Object.entries(data.d)) if (!prev || JSON.stringify(prev.d[k]) !== JSON.stringify(v)) this.h.district(k, v);
    const seen = new Set(prev ? prev.log.map((e) => e.k) : []);
    for (const e of data.log.slice(-LOG_LIMIT)) if (!seen.has(e.k)) this.h.log(e.k, e, !!prev);
  }

  newProvinceKey() { return `-L${randomId(18)}`; }

  newCountryKey() { return `-L${randomId(18)}`; }

  async checkCaps() { return true; }

  async submit(op, nick) {
    const t = Date.now();
    const last = +storageGet('ik-demo-cool') || 0;
    if (t < last + COOLDOWN_MS) throw fail('denied', 'cooldown');
    const data = this.load();
    const table = op.kind === 'd' ? data.d : data.p;
    table[op.id] = { ...op.full, t };
    if (op.newProvince) {
      const np = op.newProvince;
      data.p[np.key] = np.k ? { n: np.n, c: np.c, k: np.k } : { n: np.n, c: np.c };
    }
    if (op.newCountry) data.c[op.newCountry.key] = { n: op.newCountry.n };
    data.log.push({ ...logEntry(this.uid, t, op, nick), k: `${t}${randomId(4)}` });
    if (data.log.length > 300) data.log.splice(0, data.log.length - 300);
    storageSet('ik-demo-cool', String(t));
    storageSet(this.key, JSON.stringify(data));
    const prev = this.data;
    this.data = data;
    this.emitAll(data, prev);
    this.h.cooldown(t + COOLDOWN_MS);
    this.channel?.postMessage(1);
  }
}
