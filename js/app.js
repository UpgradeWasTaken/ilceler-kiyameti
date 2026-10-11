import { Geo } from './geo.js';
import { GameState, COOLDOWN_MS, districtIndex, districtKey, fold, cleanName } from './state.js';
import { MapView, PALETTE } from './view.js';
import { createBackend, preloadBackend } from './backend.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const b = (text) => el('b', { textContent: text });
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const isMobile = () => matchMedia('(max-width: 760px)').matches;

// ---- boot ---------------------------------------------------------------------

preloadBackend();
const geo = new Geo(await fetch('data/map.json').then((r) => r.json()));
const state = new GameState(geo);
const view = new MapView($('map'), geo, state);
$('attrib').textContent = geo.attribution;
window.ik = { geo, state, view }; // handy for debugging from the console
$('loading').classList.add('done');
setTimeout(() => $('loading').remove(), 400);

let backend = null;
let selected = -1; // any district of the selected group
let ownChangeUntil = 0; // our own action may remove the selection: no "it's gone" toast then
let pick = null;   // { text, onPick(i) } while choosing a target on the map

// ---- state updates (batched) ------------------------------------------------------

let flushTimer = 0;
function markDirty() {
  if (!flushTimer) flushTimer = setTimeout(flush, 24);
}
function flush() {
  flushTimer = 0;
  const rootBefore = selected >= 0 ? state.root[selected] : -1;
  state.derive();
  if (selected >= 0 && !state.alive[selected]) {
    if (Date.now() > ownChangeUntil) toast('Seçtiğin ilçe artık yok 🌊', 'warn');
    select(-1);
  } else if (selected >= 0 && state.root[selected] !== rootBefore) {
    closeForm(); // someone merged the selected group away: an open form would target a stale group
  }
  view.requestRender();
  renderStats();
  renderSelection();
  if (searchBox.input.value) searchBox.update();
}

function setStatus(kind, detail) {
  const s = $('status');
  s.dataset.s = kind;
  s.textContent = { live: 'Canlı', connecting: 'Bağlanıyor…', local: 'Demo', error: 'Hata' }[kind] || kind;
  s.title = detail || {
    live: 'Değişiklikler herkese anında gidiyor',
    local: 'Firebase ayarlanmadı: değişiklikler yalnızca bu tarayıcıda kalır (README)',
    connecting: 'Sunucuya bağlanılıyor',
  }[kind] || '';
  if (kind === 'error' && detail) toast(detail, 'err', 6000);
}

// ---- layout insets (top bar and the mobile bottom sheet cover the map) ------

function updateInsets() {
  const top = $('topbar').getBoundingClientRect().height;
  const side = $('side');
  const bottom = isMobile() ? side.getBoundingClientRect().height : 0;
  view.setInsets({ t: top, b: bottom });
}
new ResizeObserver(updateInsets).observe($('side'));
new ResizeObserver(updateInsets).observe($('topbar'));
updateInsets();
view.fitAll(false);

// ---- stats ------------------------------------------------------------------------

function renderStats() {
  const s = state.stats;
  $('stats').replaceChildren(
    el('span', {}, '🗺️ ', b(s.districts.toLocaleString('tr')), ' ilçe'),
    el('span', {}, '🏳️ ', b(s.provinces.toLocaleString('tr')), ' il'),
    el('span', {}, '🌊 ', b(s.sea.toLocaleString('tr')), ' denizde'),
    el('span', {}, '🔗 ', b(s.merged.toLocaleString('tr')), ' birleşmiş'),
  );
}
renderStats();

// ---- selection ------------------------------------------------------------------

const groupOf = (i) => (i >= 0 && state.alive[i] ? state.root[i] : -1);

function select(i, { fly = false, pan = true } = {}) {
  selected = groupOf(i);
  view.selected = selected;
  closeForm();
  renderSelection();
  view.requestRender();
  if (selected >= 0) {
    const box = state.boxOf(state.groups.get(selected));
    showTab('sel', true);
    if (fly) view.flyToBox(box);
    else if (pan && isMobile()) setTimeout(() => { updateInsets(); view.ensureVisible(box); }, 60);
  }
}

function renderSelection() {
  const r = groupOf(selected);
  $('sel-empty').hidden = r >= 0;
  $('sel').hidden = r < 0;
  if (r < 0) return;
  const members = state.groups.get(r);
  const pk = state.prov[r];
  const color = PALETTE[state.provColor(pk)];
  $('sel-name').textContent = state.name[r];
  const original = geo.names[r] !== state.name[r] ? ` · eski adı ${geo.names[r]}` : '';
  $('sel-sub').textContent = `${state.provName(pk)} ili${members.length > 1 ? ` · ${members.length} ilçenin birleşimi` : ''}${original}`;
  $('sel-swatch').style.background = color;
  $('prov-swatch').style.background = color;
  $('prov-name').textContent = `${state.provName(pk)} ili`;
  $('prov-count').textContent = `${(state.provGroups.get(pk) || []).length} ilçe`;
  renderCooldown();
}

$('sel-close').onclick = () => select(-1);

view.onClick = (i) => {
  if (pick) {
    if (i >= 0) pick.onPick(i);
    return;
  }
  select(i);
};

const tip = $('tip');
view.onHover = (i, e) => {
  const r = groupOf(i);
  if (r < 0 || !e) { tip.hidden = true; return; }
  tip.hidden = false;
  tip.replaceChildren(pick ? '→ ' : '', state.name[r], el('small', { textContent: state.provName(state.prov[r]) }));
  const rect = $('stage').getBoundingClientRect();
  tip.style.left = `${e.clientX - rect.left}px`;
  tip.style.top = `${e.clientY - rect.top}px`;
};
view.onMove = () => { tip.hidden = true; };

// ---- actions ------------------------------------------------------------------------

const form = $('act-form');
let formSubmit = null;
form.addEventListener('submit', (e) => { e.preventDefault(); formSubmit?.(); });
function closeForm() {
  form.hidden = true;
  form.replaceChildren();
  formSubmit = null;
  setPick(null);
  for (const btn of document.querySelectorAll('.actions button')) btn.classList.remove('on');
}

function openForm(act, ...children) {
  closeForm();
  document.querySelector(`[data-act="${act}"]`)?.classList.add('on');
  form.replaceChildren(...children);
  form.hidden = false;
  form.querySelector('input')?.focus({ preventScroll: true });
}

function formRow(submitLabel) {
  const cancel = el('button', { type: 'button', textContent: 'Vazgeç' });
  cancel.onclick = closeForm;
  return el('div', { className: 'row' }, cancel, submitLabel ? el('button', { type: 'submit', className: 'primary', textContent: submitLabel }) : null);
}

function setPick(p) {
  pick = p;
  view.picking = !!p;
  view.pickHover = -1;
  $('pick').hidden = !p;
  if (p) $('pick-text').textContent = p.text;
  view.requestRender();
}
$('pick-cancel').onclick = closeForm;

for (const btn of document.querySelectorAll('[data-act]')) {
  btn.addEventListener('click', () => {
    const r = groupOf(selected);
    if (r < 0) return;
    if (btn.classList.contains('on')) { closeForm(); return; }
    ACTIONS[btn.dataset.act](r);
  });
}

function districtOp(r, fields, log, extra = {}) {
  return { kind: 'd', id: districtKey(r), fields, full: { ...state.districtNode(r), ...fields }, log, ...extra };
}
function provinceOp(pk, fields, log) {
  const p = state.provinces.get(pk);
  const full = { n: p.n, c: p.c, ...(p.x ? { x: true } : {}), ...fields };
  return { kind: 'p', id: pk, fields, full, log };
}

const ACTIONS = {
  rename(r) {
    const input = el('input', { type: 'text', value: state.name[r], maxLength: 30, required: true });
    openForm('rename', el('label', { textContent: 'Yeni ilçe adı' }), input, formRow('Kaydet'));
    input.select();
    formSubmit = () => {
      const name = cleanName(input.value);
      if (!name) return toast('Ad boş olamaz', 'warn');
      if (name === state.name[r]) return closeForm();
      run(districtOp(r, { n: name }, { a: 'ren', s: state.name[r], o: name }));
    };
  },

  province(r) {
    const input = el('input', { type: 'text', placeholder: 'İl ara ya da yeni il adı yaz…', maxLength: 30 });
    const list = el('ul', { className: 'results', role: 'listbox' });
    const fromMap = el('button', { type: 'button', textContent: '🗺️ Haritadan seç' });
    const choose = (pk) => {
      if (pk === state.prov[r]) return toast('Zaten bu ilde', 'warn');
      run(districtOp(r, { p: pk }, { a: 'prv', s: state.name[r], o: state.provName(pk) }));
    };
    const create = (name) => {
      if (!backend) return toast('Henüz bağlanılamadı', 'warn');
      const key = backend.newProvinceKey();
      const c = state.pickColor(r);
      run(districtOp(r, { p: key }, { a: 'prv', s: state.name[r], o: name }, { newProvince: { key, n: name, c } }));
    };
    const refresh = () => {
      const q = fold(cleanName(input.value));
      const items = [];
      let exact = false;
      for (const pk of [...state.provGroups.keys()].sort((a, c) => state.provName(a).localeCompare(state.provName(c), 'tr'))) {
        if (pk === state.prov[r]) continue;
        const name = state.provName(pk);
        if (q && !fold(name).includes(q)) continue;
        if (fold(name) === q) exact = true;
        if (items.length < 60) {
          const li = el('li', {}, el('span', { className: 'swatch sm', style: `background:${PALETTE[state.provColor(pk)]}` }), name,
            el('small', { textContent: `${state.provGroups.get(pk).length} ilçe` }));
          li.onclick = () => choose(pk);
          items.push(li);
        }
      }
      const name = cleanName(input.value);
      if (name && !exact) {
        const li = el('li', { className: 'create', textContent: `➕ “${name}” adında yeni il kur` });
        li.onclick = () => create(name);
        items.unshift(li);
      }
      list.replaceChildren(...items);
    };
    input.oninput = refresh;
    fromMap.onclick = () => setPick({
      text: `${state.name[r]} hangi ile geçsin? Haritada o ilden bir ilçeye dokun.`,
      onPick: (i) => choose(state.prov[state.root[i]]),
    });
    openForm('province', el('label', { textContent: `${state.name[r]} hangi ile geçsin?` }), input, list,
      el('div', { className: 'row' }, fromMap), formRow());
    formSubmit = () => list.firstElementChild?.click();
    refresh();
  },

  merge(r) {
    const input = el('input', { type: 'text', placeholder: 'Hedef ilçeyi ara…' });
    const list = el('ul', { className: 'results', role: 'listbox' });
    const target = async (i) => {
      const t = groupOf(i);
      if (t < 0) return;
      if (t === r) return toast('Bir ilçe kendisine katılamaz', 'warn');
      const ok = await confirmBox([b(state.name[r]), ' ilçesi, ', b(state.name[t]), ` (${state.provName(state.prov[t])}) ilçesine katılsın mı? Bu geri alınamaz.`], 'Birleştir');
      if (ok && groupOf(r) === r && groupOf(t) === t) run(districtOp(r, { m: districtKey(t) }, { a: 'mrg', s: state.name[r], o: state.name[t] }));
    };
    const refresh = () => {
      const q = fold(input.value.trim());
      list.replaceChildren(...(q ? searchGroups(q, 30, r) : []).map(({ r: g, name }) => {
        const li = el('li', {}, el('span', { className: 'swatch sm', style: `background:${PALETTE[state.color[g]]}` }), name,
          el('small', { textContent: state.provName(state.prov[g]) }));
        li.onclick = () => target(g);
        return li;
      }));
    };
    input.oninput = refresh;
    openForm('merge', el('label', { textContent: `${state.name[r]} hangi ilçeye katılsın?` }), input, list,
      el('p', { className: 'hint', textContent: 'Komşu olması gerekmez. Haritadan da seçebilirsin.' }), formRow());
    formSubmit = () => list.firstElementChild?.click();
    setPick({ text: `${state.name[r]} hangi ilçeye katılsın? Haritadan seç.`, onPick: target });
  },

  async delete(r) {
    closeForm();
    const n = state.groups.get(r).length;
    const ok = await confirmBox([b(state.name[r]), n > 1 ? ` (${n} ilçe)` : '', ' denize gömülsün mü? 🌊 Bu geri alınamaz.'], 'Denize göm');
    if (ok && groupOf(r) === r) run(districtOp(r, { x: true }, { a: 'del', s: state.name[r], o: state.provName(state.prov[r]) }));
  },

  prename(r) {
    const pk = state.prov[r];
    const input = el('input', { type: 'text', value: state.provName(pk), maxLength: 30, required: true });
    openForm('prename', el('label', { textContent: 'Yeni il adı' }), input, formRow('Kaydet'));
    input.select();
    formSubmit = () => {
      const name = cleanName(input.value);
      if (!name) return toast('Ad boş olamaz', 'warn');
      if (name === state.provName(pk)) return closeForm();
      run(provinceOp(pk, { n: name }, { a: 'pren', s: state.provName(pk), o: name }));
    };
  },

  async pdelete(r) {
    closeForm();
    const pk = state.prov[r];
    const n = (state.provGroups.get(pk) || []).length;
    const ok = await confirmBox([b(`${state.provName(pk)} ili`), ` ve içindeki ${n} ilçenin tamamı denize gömülsün mü? 🌊 Bu geri alınamaz.`], 'İli denize göm');
    if (ok && state.provGroups.has(pk)) run(provinceOp(pk, { x: true }, { a: 'pdel', s: state.provName(pk), o: `${n} ilçe` }));
  },
};

let busy = false;
async function run(op) {
  if (!backend) return toast('Henüz sunucuya bağlanılamadı', 'warn');
  const left = cooldown.left();
  if (left > 0) return toast(`Biraz bekle: ${Math.ceil(left / 1000)} sn`, 'warn');
  if (busy) return;
  busy = true;
  closeForm();
  cooldown.optimistic();
  ownChangeUntil = Date.now() + 4000;
  try {
    await backend.submit(op, nick());
    toast('Tamam! Herkes görüyor 👀', 'ok', 1800);
  } catch (e) {
    cooldown.rollback();
    console.warn(e);
    toast(e.code === 'denied'
      ? 'Hamle reddedildi: bekleme süresi dolmamış ya da hedef artık geçerli değil.'
      : 'Bağlantı hatası, tekrar dene.', 'err', 4500);
  } finally {
    busy = false;
    renderCooldown();
  }
}

// ---- cooldown (enforced by the database rules; this is only the display) ---------

const cooldown = {
  // server-clock ms until which this user must wait
  until: (+store.get('ik-cooldown-until') || 0),
  prev: 0,
  now() { return backend ? backend.now() : Date.now(); },
  left() { return Math.max(0, this.until - this.now()); },
  setUntil(t) {
    this.until = t;
    // stored in local-clock terms so a refresh shows the wait immediately
    store.set('ik-cooldown-until', String(t - (this.now() - Date.now())));
    renderCooldown();
  },
  optimistic() { this.prev = this.until; this.until = this.now() + COOLDOWN_MS; renderCooldown(); },
  rollback() { this.until = this.prev; renderCooldown(); },
};

let coolTimer = 0;
function renderCooldown() {
  const left = cooldown.left();
  const ready = left <= 0;
  $('cool').dataset.ready = ready ? '1' : '0';
  $('cool-fill').style.transform = `scaleX(${ready ? 1 : 1 - Math.min(1, left / COOLDOWN_MS)})`;
  $('cool-text').textContent = ready ? 'Hamle yapabilirsin' : `Sonraki hamle: ${(left / 1000).toFixed(1)} sn`;
  for (const btn of document.querySelectorAll('[data-act]')) btn.disabled = !ready || !backend;
  clearTimeout(coolTimer);
  if (!ready) coolTimer = setTimeout(renderCooldown, 100);
}
renderCooldown();

// ---- nickname -----------------------------------------------------------------------

const nickInput = $('nick');
nickInput.value = store.get('ik-nick') || '';
nickInput.onchange = () => { nickInput.value = cleanName(nickInput.value).slice(0, 20); store.set('ik-nick', nickInput.value); };
const nick = () => cleanName(nickInput.value).slice(0, 20);

// ---- live feed ------------------------------------------------------------------------

const ICONS = { del: '🌊', mrg: '🔗', ren: '✏️', prv: '🏳️', pren: '✏️', pdel: '🌊' };
function describe(e) {
  const s = e.s || '?', o = e.o || '?';
  switch (e.a) {
    case 'del': return [b(s), ' ilçesi denize gömüldü'];
    case 'mrg': return [b(s), ' ilçesi ', b(o), ' ilçesine katıldı'];
    case 'ren': return [b(s), ' ilçesinin adı artık ', b(o)];
    case 'prv': return [b(s), ' ilçesi ', b(o), ' iline geçti'];
    case 'pren': return [b(s), ' ilinin adı artık ', b(o)];
    case 'pdel': return [b(s), ` ili (${o}) denize gömüldü`];
    default: return ['Bilinmeyen değişiklik'];
  }
}

function ago(t) {
  const s = Math.max(0, Math.round(((backend ? backend.now() : Date.now()) - t) / 1000));
  if (s < 5) return 'az önce';
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return new Date(t).toLocaleString('tr', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const feed = {
  entries: [],
  seen: new Set(),
  unread: 0,
  timer: 0,
  add(key, e, live) {
    if (typeof e.t !== 'number' || typeof e.a !== 'string') return;
    const dedupe = `${e.u}|${e.t}`; // one action per user per server timestamp
    if (this.seen.has(key) || this.seen.has(dedupe)) return;
    this.seen.add(key).add(dedupe);
    const entry = { ...e, key, fresh: live };
    this.entries.push(entry);
    this.entries.sort((x, y) => y.t - x.t);
    if (this.entries.length > 80) this.entries.length = 80;
    if (live) {
      if (backend && e.u !== backend.uid) setTimeout(() => flashEntry(entry, true), 60);
      if (isMobile() && !$('panel-feed').classList.contains('on')) { this.unread++; }
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 30);
  },
  render() {
    $('feed-empty').hidden = this.entries.length > 0;
    $('feed-badge').hidden = !this.unread;
    $('feed-badge').textContent = this.unread > 9 ? '9+' : String(this.unread);
    const me = backend && backend.uid;
    $('feed').replaceChildren(...this.entries.slice(0, 60).map((e) => {
      const who = e.w || `Anonim-${String(e.u).slice(-4)}`;
      const li = el('li', { className: e.fresh ? 'new' : '' },
        el('span', { className: 'ico', textContent: ICONS[e.a] || '•' }),
        el('div', {},
          el('p', {}, ...describe(e)),
          el('small', {}, who, e.u === me ? el('span', { className: 'me', textContent: ' (sen)' }) : null, ` · ${ago(e.t)}`)));
      li.onclick = () => flashEntry(e, false);
      e.fresh = false;
      return li;
    }));
  },
};
setInterval(() => feed.render(), 15000);

function flashEntry(e, passive) {
  let members = [];
  const di = districtIndex(e.i);
  if (di >= 0 && di < geo.count) {
    const r = state.root[di];
    members = r >= 0 ? state.membersOf(r) : [di];
    if (!members.includes(di)) members.push(di);
  } else if (typeof e.i === 'string') {
    members = state.provinceMembers(e.i);
  }
  if (!members.length) return;
  const sunk = e.a === 'del' || e.a === 'pdel';
  view.flash(members, sunk ? '#0b5fd6' : '#ff5a1f');
  if (!passive) {
    view.flyToBox(state.boxOf(members), 10);
    if (!sunk && di >= 0 && state.alive[di]) select(di, { pan: false });
  }
}

// ---- search ---------------------------------------------------------------------------

function searchGroups(q, limit, exclude = -1) {
  const starts = [], contains = [];
  for (const r of state.groupOrder) {
    if (r === exclude) continue;
    const f = fold(state.name[r]);
    if (f.startsWith(q)) starts.push({ r, name: state.name[r] });
    else if (f.includes(q)) contains.push({ r, name: state.name[r] });
    if (starts.length >= limit) break;
  }
  return starts.concat(contains).slice(0, limit);
}

const searchBox = {
  input: $('search'),
  list: $('search-results'),
  items: [],
  active: -1,
  update() {
    const q = fold(this.input.value.trim());
    this.items = [];
    if (q) {
      for (const pk of state.provGroups.keys()) {
        const name = state.provName(pk);
        if (fold(name).startsWith(q)) this.items.push({ type: 'p', pk, name });
      }
      this.items = this.items.slice(0, 3).concat(searchGroups(q, 8).map((g) => ({ type: 'd', ...g })));
    }
    this.active = this.items.length ? 0 : -1;
    this.render();
  },
  render() {
    this.list.hidden = !this.items.length || document.activeElement !== this.input;
    this.list.replaceChildren(...this.items.map((it, k) => {
      const color = PALETTE[it.type === 'p' ? state.provColor(it.pk) : state.color[it.r]];
      const li = el('li', { role: 'option' }, el('span', { className: 'swatch sm', style: `background:${color}` }), it.name,
        el('small', { textContent: it.type === 'p' ? 'il' : state.provName(state.prov[it.r]) }));
      li.setAttribute('aria-selected', String(k === this.active));
      li.onpointerdown = (e) => { e.preventDefault(); this.choose(it); };
      return li;
    }));
  },
  choose(it) {
    this.input.value = '';
    this.items = [];
    this.render();
    this.input.blur();
    if (it.type === 'p') {
      const roots = state.provGroups.get(it.pk);
      if (!roots) return;
      const members = roots.flatMap((r) => state.groups.get(r));
      select(roots.reduce((a, c) => (state.groupArea.get(c) > state.groupArea.get(a) ? c : a)), { pan: false });
      view.flyToBox(state.boxOf(members), 8);
    } else if (pick) {
      pick.onPick(it.r);
    } else {
      select(it.r, { fly: true });
    }
  },
};
searchBox.input.addEventListener('input', () => searchBox.update());
searchBox.input.addEventListener('focus', () => searchBox.update());
searchBox.input.addEventListener('blur', () => { searchBox.list.hidden = true; });
searchBox.input.addEventListener('keydown', (e) => {
  const n = searchBox.items.length;
  if (e.key === 'ArrowDown' && n) { searchBox.active = (searchBox.active + 1) % n; searchBox.render(); e.preventDefault(); }
  else if (e.key === 'ArrowUp' && n) { searchBox.active = (searchBox.active - 1 + n) % n; searchBox.render(); e.preventDefault(); }
  else if (e.key === 'Enter' && searchBox.active >= 0) { searchBox.choose(searchBox.items[searchBox.active]); e.preventDefault(); }
  else if (e.key === 'Escape') { searchBox.input.value = ''; searchBox.update(); searchBox.input.blur(); }
});

// ---- dialogs, toasts, tabs, keys -------------------------------------------------------

function confirmBox(parts, okLabel) {
  const d = $('confirm');
  $('confirm-text').replaceChildren(...parts);
  $('confirm-ok').textContent = okLabel;
  d.returnValue = '';
  d.showModal();
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true }));
}

function toast(text, kind = '', ms = 2600) {
  const t = el('div', { className: `toast ${kind}`, textContent: text });
  $('toasts').append(t);
  while ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}

function showTab(name, open) {
  const side = $('side');
  for (const t of document.querySelectorAll('.tabs button')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('on', p.dataset.panel === name);
  if (open !== undefined) side.classList.toggle('open', open);
  if (name === 'feed') { feed.unread = 0; feed.render(); }
}
for (const t of document.querySelectorAll('.tabs button')) {
  t.onclick = () => {
    const side = $('side');
    const same = t.getAttribute('aria-selected') === 'true';
    showTab(t.dataset.tab, same ? !side.classList.contains('open') : true);
  };
}
showTab('sel', !isMobile());

$('zoom-in').onclick = () => view.zoomBy(2);
$('zoom-out').onclick = () => view.zoomBy(0.5);
$('zoom-fit').onclick = () => view.fitAll(true);

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog')) return;
  if (e.key === 'Escape') { if (pick || !form.hidden) closeForm(); else select(-1); }
  else if (e.key === '+' || e.key === '=') view.zoomBy(1.6);
  else if (e.key === '-') view.zoomBy(1 / 1.6);
  else if (e.key === '/') { e.preventDefault(); searchBox.input.focus(); }
});

// ---- connect last: the handlers use everything above ------------------------------------

createBackend(geo, {
  district(key, v) { if (state.setDistrict(key, v) >= 0) markDirty(); },
  province(key, v) { if (state.setProvince(key, v)) markDirty(); },
  log(key, e, live) { feed.add(key, e, live); },
  status: setStatus,
  cooldown(until) { cooldown.setUntil(until); },
}).then((be) => { backend = be; renderCooldown(); renderSelection(); feed.render(); }).catch((e) => {
  console.error(e);
  setStatus('error', 'Sunucuya bağlanılamadı');
});
