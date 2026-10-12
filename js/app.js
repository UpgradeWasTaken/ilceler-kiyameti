import { Geo } from './geo.js';
import { GameState, COOLDOWN_MS, PALETTE, HOME_COUNTRY, nearestPalette, districtIndex, districtKey, fold, cleanName } from './state.js';
import { MapView } from './view.js';
import { COUNTRIES, COUNTRY_FULL_NAMES } from './countries.js';
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
let sunkSel = -1;  // a selected district that is under the sea
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
  if (sunkSel >= 0) {
    if (state.alive[sunkSel]) select(sunkSel, { pan: false }); // it rose from the sea
    else view.sunkSel = { key: sunkSel, members: state.subtreeOf(sunkSel) };
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
    el('span', {}, '🌍 ', b(s.countries.toLocaleString('tr')), ' ülke'),
    el('span', {}, '🌊 ', b(s.sea.toLocaleString('tr')), ' denizde'),
    el('span', {}, '🔗 ', b(s.merged.toLocaleString('tr')), ' birleşmiş'),
  );
}
renderStats();

// ---- selection ------------------------------------------------------------------

const groupOf = (i) => (i >= 0 && state.alive[i] ? state.root[i] : -1);
// Only districts / provinces that exist in the database can be changed (the Cyprus
// districts are added to an existing game once the newer database rules are live).
const districtReady = (r) => backend?.mode === 'local' || state.inDb[r] === 1;
const provinceReady = (pk) => backend?.mode === 'local' || state.provActionable(pk);

function select(i, { fly = false, pan = true } = {}) {
  selected = groupOf(i);
  view.selected = selected;
  if (selected >= 0) backend?.checkCaps(); // picks up newly published rules (throttled)
  sunkSel = -1;
  view.sunkSel = null;
  closeForm();
  renderSelection();
  view.requestRender();
  if (selected >= 0) {
    const box = state.boxOf(state.groups.get(selected));
    showTab('sel', true);
    updateInsets();
    if (fly) view.flyToBox(box);
    else if (pan && isMobile()) setTimeout(() => { updateInsets(); view.ensureVisible(box); }, 60);
  }
}

function selectSunk(i, { fly = false, pan = true } = {}) {
  select(-1);
  if (i < 0 || state.alive[i]) return;
  sunkSel = i;
  const members = state.subtreeOf(i);
  view.sunkSel = { key: i, members };
  renderSelection();
  view.requestRender();
  backend?.checkCaps().then(() => renderSelection());
  const box = state.boxOf(members);
  showTab('sel', true);
  updateInsets();
  if (fly) view.flyToBox(box);
  else if (pan && isMobile()) setTimeout(() => { updateInsets(); view.ensureVisible(box); }, 60);
}

function renderSunk(i) {
  const members = state.subtreeOf(i);
  const r = state.root[i];
  const wasIn = state.provName(r >= 0 ? state.prov[r] : state.prov[i]);
  $('sunk-name').textContent = state.name[i];
  $('sunk-sub').textContent = `🌊 Denizde · ${wasIn} ilindeydi`;
  const pk = state.reviveProvince(i);
  const others = members.length > 1 ? ` Ona katılmış ${members.length - 1} ilçe de onunla geri gelir.` : '';
  $('sunk-info').textContent = pk
    ? `Denizden çıkarsan ${state.provName(pk)} iline geri döner.${others}`
    : `Eski ili de denizde: çıkarırken yeni bir il seçeceksin.${others}`;
  const sp = state.sunkProvinceOf(i);
  $('sunk-prov').hidden = !sp;
  if (sp) {
    $('sunk-prov-name').textContent = `${state.provName(sp)} ili de denizde`;
    $('sunk-prov-count').textContent = `${state.provinceReviveCount(sp)} ilçe`;
  }
  const can = !!backend?.canRevive;
  $('sunk-off').hidden = can || !backend;
  for (const btn of document.querySelectorAll('[data-act="revive"], [data-act="previve"]')) btn.parentElement.hidden = !can && !!backend;
}

function renderSelection() {
  const r = groupOf(selected);
  const sunk = r < 0 && sunkSel >= 0 && !state.alive[sunkSel];
  $('sel-empty').hidden = r >= 0 || sunk;
  $('sel').hidden = r < 0;
  $('sunk').hidden = !sunk;
  if (sunk) { renderSunk(sunkSel); renderCooldown(); }
  if (r < 0) return;
  const members = state.groups.get(r);
  const pk = state.prov[r];
  const color = state.provFill(pk);
  const country = state.countryOf(pk);
  const inCountry = country === HOME_COUNTRY ? '' : ` · ${state.countryName(country)}`;
  $('sel-name').textContent = state.name[r];
  const original = geo.names[r] !== state.name[r] ? ` · eski adı ${geo.names[r]}` : '';
  $('sel-sub').textContent = `${state.provName(pk)} ili${inCountry}${members.length > 1 ? ` · ${members.length} ilçenin birleşimi` : ''}${original}`;
  $('sel-swatch').style.background = color;
  $('prov-swatch').style.background = color;
  $('prov-name').textContent = `${state.provName(pk)} ili`;
  $('prov-count').textContent = `${(state.provGroups.get(pk) || []).length} ilçe${inCountry}`;
  $('sel-note').hidden = !backend || districtReady(r);
  $('sel-note').textContent = r >= geo.base.d && !backend?.canV3
    ? 'Kıbrıs ilçeleri, veritabanı kuralları güncellenince değiştirilebilecek.'
    : 'Sunucuyla eşitleniyor…';
  for (const btn of document.querySelectorAll('[data-v3]')) btn.hidden = !!backend && !backend.canV3;
  renderCooldown();
}

$('sel-close').onclick = () => select(-1);
$('sunk-close').onclick = () => select(-1);

view.onClick = (i, e, sunk) => {
  if (pick) {
    if (i >= 0) pick.onPick(i);
    return;
  }
  if (i < 0 && sunk >= 0) selectSunk(sunk);
  else select(i);
};

const tip = $('tip');
view.onHover = (i, e, sunk = -1) => {
  const r = groupOf(i);
  if ((r < 0 && sunk < 0) || !e) { tip.hidden = true; return; }
  tip.hidden = false;
  if (r < 0) tip.replaceChildren('🌊 ', state.name[sunk], el('small', { textContent: 'denizde' }));
  else {
    const c = state.countryOf(state.prov[r]);
    tip.replaceChildren(pick ? '→ ' : '', state.name[r],
      el('small', { textContent: state.provName(state.prov[r]) + (c === HOME_COUNTRY ? '' : ` · ${state.countryName(c)}`) }));
  }
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

const SUNK_ACTIONS = new Set(['revive', 'previve']);
for (const btn of document.querySelectorAll('[data-act]')) {
  btn.addEventListener('click', () => {
    const target = SUNK_ACTIONS.has(btn.dataset.act) ? (sunkSel >= 0 && !state.alive[sunkSel] ? sunkSel : -1) : groupOf(selected);
    if (target < 0) return;
    if (btn.classList.contains('on')) { closeForm(); return; }
    ACTIONS[btn.dataset.act](target);
  });
}

const withoutNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

function districtOp(r, fields, log, extra = {}) {
  return { kind: 'd', id: districtKey(r), fields, full: withoutNulls({ ...state.districtNode(r), ...fields }), log, ...extra };
}
function provinceOp(pk, fields, log, extra = {}) {
  const p = state.provinces.get(pk);
  const full = withoutNulls({ n: p.n, c: p.c, ...(p.x ? { x: true } : {}), ...(p.rgb ? { rgb: p.rgb } : {}), ...(p.k ? { k: p.k } : {}), ...fields });
  return { kind: 'p', id: pk, fields, full, log, ...extra };
}

// Country chooser: every real country (and de facto ones), countries players founded,
// or a new one typed in. Countries already on the map are listed first.
function countryPicker({ act, label, exclude, onChoose }) {
  const input = el('input', { type: 'text', placeholder: 'Ülke ara ya da yeni ülke adı yaz…', maxLength: 30 });
  const list = el('ul', { className: 'results', role: 'listbox' });
  const onMap = new Set([...state.provGroups.keys()].map((pk) => state.countryOf(pk)));
  const all = Object.entries(COUNTRIES).map(([code, name]) => ({ code, name }))
    .concat([...state.countries].map(([code, name]) => ({ code, name, custom: true })))
    .sort((a, c) => (onMap.has(c.code) - onMap.has(a.code)) || a.name.localeCompare(c.name, 'tr'));
  const refresh = () => {
    const q = fold(cleanName(input.value));
    const items = [];
    let exact = false;
    for (const c of all) {
      if (c.code === exclude) continue;
      const f = fold(c.name);
      if (q && !f.includes(q) && !fold(COUNTRY_FULL_NAMES[c.code] || '').includes(q)) continue;
      if (f === q) exact = true;
      if (items.length >= 80) continue;
      const li = el('li', {}, c.name, el('small', { textContent: onMap.has(c.code) ? 'haritada' : c.custom ? 'oyuncu ülkesi' : '' }));
      li.title = COUNTRY_FULL_NAMES[c.code] || c.name;
      li.onclick = () => onChoose(c);
      items.push(li);
    }
    const name = cleanName(input.value);
    if (name && !exact) {
      const li = el('li', { className: 'create', textContent: `➕ “${name}” adında yeni ülke kur` });
      li.onclick = () => onChoose({ code: null, name, isNew: true });
      items.unshift(li);
    }
    list.replaceChildren(...items);
  };
  input.oninput = refresh;
  openForm(act, el('label', { textContent: label }), input, list, formRow());
  formSubmit = () => list.firstElementChild?.click();
  refresh();
}

// Raising a sunk district: it becomes its own district again (no merge, not sunk) in a living province.
function reviveOp(i, pk, newProvince) {
  const fields = { x: null, m: null, p: pk };
  return districtOp(i, fields, { a: 'rev', s: state.name[i], o: newProvince ? newProvince.n : state.provName(pk) }, newProvince ? { newProvince } : {});
}

// Province chooser shared by "change province" and "raise from the sea".
function provincePicker({ act, label, exclude, colorFor, onChoose, onCreate, mapText }) {
  const input = el('input', { type: 'text', placeholder: 'İl ara ya da yeni il adı yaz…', maxLength: 30 });
  const list = el('ul', { className: 'results', role: 'listbox' });
  const fromMap = el('button', { type: 'button', textContent: '🗺️ Haritadan seç' });
  const create = (name) => {
    if (!backend) return toast('Henüz bağlanılamadı', 'warn');
    onCreate({ key: backend.newProvinceKey(), n: name, c: colorFor() });
  };
  const refresh = () => {
    const q = fold(cleanName(input.value));
    const items = [];
    let exact = false;
    for (const pk of [...state.provGroups.keys()].sort((a, c) => state.provName(a).localeCompare(state.provName(c), 'tr'))) {
      if (pk === exclude || !provinceReady(pk)) continue;
      const name = state.provName(pk);
      if (q && !fold(name).includes(q)) continue;
      if (fold(name) === q) exact = true;
      if (items.length < 60) {
        const c = state.countryOf(pk);
        const li = el('li', {}, el('span', { className: 'swatch sm', style: `background:${state.provFill(pk)}` }), name,
          el('small', { textContent: `${state.provGroups.get(pk).length} ilçe${c === HOME_COUNTRY ? '' : ` · ${state.countryName(c)}`}` }));
        li.onclick = () => onChoose(pk);
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
  fromMap.onclick = () => setPick({ text: mapText, onPick: (i) => onChoose(state.prov[state.root[i]]) });
  openForm(act, el('label', { textContent: label }), input, list, el('div', { className: 'row' }, fromMap), formRow());
  formSubmit = () => list.firstElementChild?.click();
  refresh();
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
    provincePicker({
      act: 'province',
      label: `${state.name[r]} hangi ile geçsin?`,
      exclude: state.prov[r],
      colorFor: () => state.pickColor(r),
      mapText: `${state.name[r]} hangi ile geçsin? Haritada o ilden bir ilçeye dokun.`,
      onChoose: (pk) => {
        if (pk === state.prov[r]) return toast('Zaten bu ilde', 'warn');
        run(districtOp(r, { p: pk }, { a: 'prv', s: state.name[r], o: state.provName(pk) }));
      },
      onCreate: (np) => run(districtOp(r, { p: np.key }, { a: 'prv', s: state.name[r], o: np.n }, { newProvince: np })),
    });
  },

  merge(r) {
    const input = el('input', { type: 'text', placeholder: 'Hedef ilçeyi ara…' });
    const list = el('ul', { className: 'results', role: 'listbox' });
    const target = async (i) => {
      const t = groupOf(i);
      if (t < 0) return;
      if (t === r) return toast('Bir ilçe kendisine katılamaz', 'warn');
      if (!districtReady(t)) return toast('Bu ilçe henüz değiştirilemiyor', 'warn');
      const ok = await confirmBox([b(state.name[r]), ' ilçesi, ', b(state.name[t]), ` (${state.provName(state.prov[t])}) ilçesine katılsın mı? Bu geri alınamaz.`], 'Birleştir');
      if (ok && groupOf(r) === r && groupOf(t) === t) run(districtOp(r, { m: districtKey(t) }, { a: 'mrg', s: state.name[r], o: state.name[t] }));
    };
    const refresh = () => {
      const q = fold(input.value.trim());
      list.replaceChildren(...(q ? searchGroups(q, 30, r) : []).map(({ r: g, name }) => {
        const li = el('li', {}, el('span', { className: 'swatch sm', style: `background:${state.fill[g]}` }), name,
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

  country(r) {
    const name = state.name[r];
    countryPicker({
      act: 'country',
      label: `${name} hangi ülkeye geçsin?`,
      exclude: state.countryOf(state.prov[r]),
      onChoose: (c) => {
        if (!backend) return toast('Henüz bağlanılamadı', 'warn');
        const key = c.isNew ? backend.newCountryKey() : c.code;
        const newCountry = c.isNew ? { key, n: c.name } : null;
        const log = { a: 'dcty', s: name, o: c.name };
        // join one of that country's provinces, or found a new one there
        const provs = c.isNew ? [] : [...state.provGroups.keys()]
          .filter((pk) => state.countryOf(pk) === key && provinceReady(pk))
          .sort((a, b) => state.provName(a).localeCompare(state.provName(b), 'tr'));
        const list = el('ul', { className: 'results', role: 'listbox' }, ...provs.map((pk) => {
          const li = el('li', {}, el('span', { className: 'swatch sm', style: `background:${state.provFill(pk)}` }), state.provName(pk),
            el('small', { textContent: `${state.provGroups.get(pk).length} ilçe` }));
          li.onclick = () => run(districtOp(r, { p: pk }, log));
          return li;
        }));
        const input = el('input', { type: 'text', value: name, maxLength: 30, required: true });
        openForm('country',
          el('label', { textContent: provs.length ? `${c.name}: hangi ile katılsın?` : `${c.name} içinde yeni bir il kurulacak` }),
          provs.length ? list : null,
          el('label', { className: 'sub', textContent: provs.length ? '… ya da yeni bir il kur:' : 'Yeni ilin adı:' }),
          input, formRow('Yeni il kur'));
        formSubmit = () => {
          const n = cleanName(input.value);
          if (!n) return toast('Ad boş olamaz', 'warn');
          const np = { key: backend.newProvinceKey(), n, c: state.pickColor(r), k: key };
          run(districtOp(r, { p: np.key }, log, { newProvince: np, ...(newCountry ? { newCountry } : {}) }));
        };
      },
    });
  },

  pcountry(r) {
    const pk = state.prov[r];
    countryPicker({
      act: 'pcountry',
      label: `${state.provName(pk)} ili hangi ülkeye geçsin?`,
      exclude: state.countryOf(pk),
      onChoose: (c) => {
        if (!backend) return toast('Henüz bağlanılamadı', 'warn');
        const key = c.isNew ? backend.newCountryKey() : c.code;
        run(provinceOp(pk, { k: key }, { a: 'pcty', s: state.provName(pk), o: c.name }, c.isNew ? { newCountry: { key, n: c.name } } : {}));
      },
    });
  },

  pcolor(r) {
    const pk = state.prov[r];
    const BASIC = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#00897b', '#1e88e5', '#3949ab', '#8e24aa', '#d81b60', '#6d4c41', '#9e9e9e', '#ffffff'];
    let hex = state.provFill(pk);
    const hexOf = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, v | 0)).toString(16).padStart(2, '0')).join('');
    const preview = el('span', { className: 'color-preview' });
    const hexInput = el('input', { type: 'text', maxLength: 7, className: 'hex', spellcheck: false, ariaLabel: 'Renk kodu' });
    const native = el('input', { type: 'color', className: 'native', title: 'Renk seçici', ariaLabel: 'Renk seçici' });
    const sliders = ['R', 'G', 'B'].map((ch, k) => {
      const range = el('input', { type: 'range', min: 0, max: 255, step: 1, ariaLabel: ['Kırmızı', 'Yeşil', 'Mavi'][k] });
      const out = el('output', {});
      range.oninput = () => set(hexOf(sliders.map((x) => +x.range.value)), range);
      return { range, out, row: el('label', { className: `rgb-row c${k}` }, el('span', { textContent: ch }), range, out) };
    });
    const swatches = [...PALETTE, ...BASIC].map((c) => {
      const btn = el('button', { type: 'button', className: 'sw', title: c });
      btn.style.background = c;
      btn.onclick = () => set(c);
      return btn;
    });
    // source: the control being dragged or typed in, which must not be overwritten
    function set(h, source) {
      hex = h.toLowerCase();
      const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      preview.style.background = hex;
      sliders.forEach((sl, k) => { if (sl.range !== source) sl.range.value = rgb[k]; sl.out.textContent = rgb[k]; });
      if (source !== hexInput) hexInput.value = hex;
      native.value = hex;
      swatches.forEach((sw) => sw.classList.toggle('on', sw.title === hex));
    }
    hexInput.oninput = () => { const v = hexInput.value.trim(); if (/^#?[0-9a-fA-F]{6}$/.test(v)) set(v.startsWith('#') ? v : `#${v}`, hexInput); };
    native.oninput = () => set(native.value, native);
    openForm('pcolor', el('label', { textContent: `${state.provName(pk)} ilinin rengi` }),
      el('div', { className: 'swatches' }, ...swatches),
      el('div', { className: 'rgb' }, el('div', { className: 'rgb-top' }, preview, hexInput, native), ...sliders.map((x) => x.row)),
      formRow('Kaydet'));
    hexInput.blur(); // no keyboard popping up on phones
    set(hex);
    formSubmit = () => {
      if (hex === state.provFill(pk)) return closeForm();
      const idx = PALETTE.indexOf(hex);
      run(provinceOp(pk, idx >= 0 ? { c: idx, rgb: null } : { rgb: hex, c: nearestPalette(hex) }, { a: 'pclr', s: state.provName(pk), o: hex }));
    };
  },

  async revive(i) {
    const members = state.subtreeOf(i);
    const others = members.length > 1 ? ` Ona katılmış ${members.length - 1} ilçe de geri gelir.` : '';
    const pk = state.reviveProvince(i);
    if (pk) {
      closeForm();
      const ok = await confirmBox([b(state.name[i]), ' denizden çıkıp ', b(`${state.provName(pk)} iline`), ` geri dönsün mü? 🏝️${others}`], 'Denizden çıkar');
      if (ok && !state.alive[i] && state.provinceAlive(pk)) run(reviveOp(i, pk));
      return;
    }
    provincePicker({
      act: 'revive',
      label: `${state.name[i]} hangi ilde denizden çıksın?`,
      exclude: null,
      colorFor: () => state.pickColor(i),
      mapText: `${state.name[i]} hangi ilde denizden çıksın? Haritada o ilden bir ilçeye dokun.`,
      onChoose: (p) => run(reviveOp(i, p)),
      onCreate: (np) => run(reviveOp(i, np.key, np)),
    });
  },

  async previve(i) {
    closeForm();
    const pk = state.sunkProvinceOf(i);
    if (!pk) return;
    const n = state.provinceReviveCount(pk);
    const ok = await confirmBox([b(`${state.provName(pk)} ili`), ` ve içindeki ${n} ilçe denizden çıksın mı? 🏝️`], 'İli denizden çıkar');
    if (ok && state.provinces.get(pk)?.x) run(provinceOp(pk, { x: null }, { a: 'prev', s: state.provName(pk), o: `${n} ilçe` }));
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
const PROVINCE_ACTIONS = new Set(['prename', 'pdelete', 'pcolor', 'pcountry']);
const V3_ACTIONS = new Set(['country', 'pcolor', 'pcountry']);
function allowed(act) {
  if (V3_ACTIONS.has(act) && !backend?.canV3) return false;
  if (act === 'revive') return sunkSel >= 0 && districtReady(sunkSel);
  if (act === 'previve') return sunkSel >= 0 && provinceReady(state.sunkProvinceOf(sunkSel));
  const r = groupOf(selected);
  if (r < 0) return false;
  return PROVINCE_ACTIONS.has(act) ? provinceReady(state.prov[r]) : districtReady(r);
}
function renderCooldown() {
  const left = cooldown.left();
  const ready = left <= 0;
  $('cool').dataset.ready = ready ? '1' : '0';
  $('cool-fill').style.transform = `scaleX(${ready ? 1 : 1 - Math.min(1, left / COOLDOWN_MS)})`;
  $('cool-text').textContent = ready ? 'Hamle yapabilirsin' : `Sonraki hamle: ${(left / 1000).toFixed(1)} sn`;
  for (const btn of document.querySelectorAll('[data-act]')) btn.disabled = !ready || !backend || !allowed(btn.dataset.act);
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

const ICONS = { del: '🌊', mrg: '🔗', ren: '✏️', prv: '🏳️', pren: '✏️', pdel: '🌊', rev: '🏝️', prev: '🏝️', dcty: '🌍', pcty: '🌍', pclr: '🎨' };
const colorDot = (c) => el('span', { className: 'dot', style: `background:${/^#[0-9a-f]{6}$/i.test(c) ? c : '#ccc'}` });
function describe(e) {
  const s = e.s || '?', o = e.o || '?';
  switch (e.a) {
    case 'del': return [b(s), ' ilçesi denize gömüldü'];
    case 'mrg': return [b(s), ' ilçesi ', b(o), ' ilçesine katıldı'];
    case 'ren': return [b(s), ' ilçesinin adı artık ', b(o)];
    case 'prv': return [b(s), ' ilçesi ', b(o), ' iline geçti'];
    case 'pren': return [b(s), ' ilinin adı artık ', b(o)];
    case 'pdel': return [b(s), ` ili (${o}) denize gömüldü`];
    case 'rev': return [b(s), ' ilçesi denizden çıktı (', b(o), ' ili)'];
    case 'prev': return [b(s), ` ili (${o}) denizden çıktı`];
    case 'dcty': return [b(s), ' ilçesi ', b(o), ' ülkesine geçti'];
    case 'pcty': return [b(s), ' ili ', b(o), ' ülkesine geçti'];
    case 'pclr': return [b(s), ' ilinin rengi değişti ', colorDot(o)];
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
      if (isMobile() && !$('panel-feed').classList.contains('on') && e.u !== backend?.uid) this.unread++;
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
  const raised = e.a === 'rev' || e.a === 'prev';
  view.flash(members, sunk ? '#0b5fd6' : raised ? '#1b8a4b' : '#ff5a1f');
  if (!passive) {
    view.flyToBox(state.boxOf(members), 10);
    // select what the entry is about; if it is under water now, offer to raise it
    const focus = di >= 0 && di < geo.count ? di : members.reduce((a, c) => (geo.area[c] > geo.area[a] ? c : a));
    if (state.alive[focus]) select(focus, { pan: false });
    else selectSunk(focus, { pan: false });
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
      // provinces, then names starting with the query (sunk ones too), then names containing it
      const groups = searchGroups(q, 8).map((g) => ({ type: 'd', ...g }));
      const starts = groups.filter((g) => fold(g.name).startsWith(q));
      const sunk = [];
      for (let i = 0; i < geo.count && sunk.length < 3 && !pick; i++) {
        if (!state.alive[i] && fold(state.name[i]).startsWith(q)) sunk.push({ type: 's', i, name: state.name[i] });
      }
      this.items = this.items.slice(0, 3).concat(starts, sunk, groups.filter((g) => !starts.includes(g)));
    }
    this.active = this.items.length ? 0 : -1;
    this.render();
  },
  render() {
    this.list.hidden = !this.items.length || document.activeElement !== this.input;
    this.list.replaceChildren(...this.items.map((it, k) => {
      const swatch = it.type === 's' ? el('span', { className: 'swatch sm sea' })
        : el('span', { className: 'swatch sm', style: `background:${it.type === 'p' ? state.provFill(it.pk) : state.fill[it.r]}` });
      const pk = it.type === 'p' ? it.pk : it.type === 'd' ? state.prov[it.r] : null;
      const country = pk && state.countryOf(pk) !== HOME_COUNTRY ? ` · ${state.countryName(state.countryOf(pk))}` : '';
      const li = el('li', { role: 'option' }, swatch, it.name,
        el('small', { textContent: it.type === 'p' ? `il${country}` : it.type === 's' ? '🌊 denizde' : state.provName(pk) + country }));
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
    } else if (it.type === 's') {
      selectSunk(it.i, { fly: true });
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
  country(key, v) { if (state.setCountry(key, v)) markDirty(); },
  log(key, e, live) { feed.add(key, e, live); },
  status: setStatus,
  cooldown(until) { cooldown.setUntil(until); },
  caps() { renderSelection(); },
}).then((be) => { backend = be; renderCooldown(); renderSelection(); feed.render(); }).catch((e) => {
  console.error(e);
  setStatus('error', 'Sunucuya bağlanılamadı');
});
