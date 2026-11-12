// Приём шин — приложение для телефона. Работает без интернета, выгрузка на Google Диск кнопкой.
const VERSION = '1.2 (12.11.2026)';
const $ = id => document.getElementById(id);

// ---------- настройки (адрес сервера и ключ) ----------
let cfg = {};
try { cfg = JSON.parse(localStorage.getItem('cfg') || '{}'); } catch (e) {}
(function () {
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('api') && h.get('key')) {
    cfg = { api: h.get('api'), key: h.get('key') };
    try { localStorage.setItem('cfg', JSON.stringify(cfg)); } catch (e) {}
    history.replaceState(null, '', location.pathname);
    setTimeout(() => toast('Приложение настроено'), 300);
  }
})();
function saveCfg() {
  cfg = { api: $('cApi').value.trim(), key: $('cKey').value.trim() };
  try { localStorage.setItem('cfg', JSON.stringify(cfg)); } catch (e) {}
  toast('Сохранено'); refreshBar();
}

async function api(action, data) {
  if (!cfg.api || !cfg.key) throw new Error('приложение не настроено (вкладка «Настройки»)');
  let r;
  try {
    r = await fetch(cfg.api, { method: 'POST', body: JSON.stringify(Object.assign({ action: action, key: cfg.key }, data || {})) });
  } catch (e) { throw new Error('нет интернета'); }
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('сервер ответил непонятно (код ' + r.status + ')'); }
  if (!j.ok) throw new Error(j.error);
  return j.data;
}
async function checkServer() {
  try { await api('list', { q: '___' }); toast('Связь с сервером есть'); } catch (e) { toast('Нет связи: ' + e.message); }
}

// ---------- хранилище в телефоне (IndexedDB) ----------
const dbp = new Promise((res, rej) => {
  const q = indexedDB.open('priem', 1);
  q.onupgradeneeded = () => {
    const d = q.result;
    d.createObjectStore('tires', { keyPath: 'art' });
    d.createObjectStore('photos', { keyPath: 'key' });
    d.createObjectStore('kv');
  };
  q.onsuccess = () => res(q.result);
  q.onerror = () => rej(q.error);
});
async function tx(store, mode, fn) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode), r = fn(t.objectStore(store));
    let out;
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('память телефона переполнена?'));
  });
}
const idb = {
  get: (s, k) => tx(s, 'readonly', x => x.get(k)),
  all: s => tx(s, 'readonly', x => x.getAll()),
  put: (s, v, k) => tx(s, 'readwrite', x => k === undefined ? x.put(v) : x.put(v, k)),
  del: (s, k) => tx(s, 'readwrite', x => x.delete(k)),
  clear: s => tx(s, 'readwrite', x => x.clear())
};
const getSess = () => idb.get('kv', 'session');
const setSess = s => idb.put('kv', s, 'session');
async function photosOf(art) { return (await idb.all('photos')).filter(p => p.art === art).sort((a, b) => a.n - b.n); }

// ---------- общее ----------
function toast(t) { const e = $('toast'); e.textContent = t; e.style.display = 'block'; clearTimeout(e._t); e._t = setTimeout(() => e.style.display = 'none', 4000); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function uid() { return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); }
function pad(n) { return String(n).padStart(5, '0'); }
function tab(x) {
  ['P', 'S', 'C', 'F'].forEach(k => $(k).classList.toggle('hide', k !== x));
  ['P', 'S', 'C'].forEach(k => $('t' + k).classList.toggle('on', k === x || (x === 'F' && k === (cur && cur.mode === 'remote' ? 'S' : 'P'))));
  if (x === 'S') loadList();
  if (x === 'C') { $('cApi').value = cfg.api || ''; $('cKey').value = cfg.key || ''; $('ver').textContent = 'Версия ' + VERSION; }
  if (x === 'P') renderLocal();
  window.scrollTo(0, 0);
}

async function refreshBar() {
  const b = $('bar'), s = await getSess();
  if (!cfg.api) { b.className = 'bad'; b.textContent = 'Не настроено — открой ссылку настройки от менеджера'; return; }
  if (!s) { b.className = ''; b.textContent = 'Приёмка не начата'; return; }
  const tires = await idb.all('tires'), ph = (await idb.all('photos')).filter(p => !p.up);
  const waitT = tires.filter(t => !t.uploaded).length;
  if (!tires.length) { b.className = 'ok'; b.textContent = 'Приёмка начата · следующий артикул ' + pad(s.next); return; }
  const old = Date.now() - s.started > 24 * 3600 * 1000;
  b.className = old ? 'bad' : 'warn';
  b.textContent = 'В телефоне: ' + tires.length + ' шин, ' + ph.length + ' фото — не выгружено' +
    (waitT < tires.length ? ' (частично)' : '') + (old ? '. Больше суток! Выгрузи.' : '');
}

// ---------- списки-подсказки ----------
// Справочник из каталога сайта (размеры, бренды, модели по брендам, страны) лежит в телефоне — работает без интернета.
let SPR = { size: [], brand: [], country: [], models: {} };
const sprReady = fetch('spravochnik.json').then(r => r.json()).then(j => { SPR = j; }).catch(() => {});
let extraModels = [];
function opts(id, arr) { $(id).innerHTML = [...new Set(arr)].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).map(v => '<option value="' + esc(v) + '">').join(''); }
async function fillLists() {
  await sprReady;
  const s = await getSess(), l = { size: [], brand: [], model: [], country: [] };
  if (s && s.lists) Object.keys(l).forEach(k => l[k] = (s.lists[k] || []).slice());
  (await idb.all('tires')).forEach(t => Object.keys(l).forEach(k => { if (t[k]) l[k].push(t[k]); }));
  opts('L_size', l.size.concat(SPR.size || []));
  opts('L_brand', l.brand.concat(SPR.brand || []));
  opts('L_country', l.country.concat(SPR.country || []));
  extraModels = l.model;
  fillModels();
}
// Модели: если бренд выбран — только модели этого бренда, иначе все.
function fillModels() {
  const b = ($('brand').value || '').trim().toLowerCase(), m = SPR.models || {};
  const key = Object.keys(m).find(k => k.toLowerCase() === b);
  const all = key ? m[key] : [].concat(...Object.values(m));
  opts('L_model', all.concat(extraModels));
}
$('brand').addEventListener('input', fillModels);
$('brand').addEventListener('change', fillModels);

// ---------- приёмка ----------
async function startSession() {
  if (await getSess()) { toast('Приёмка уже начата'); return; }
  $('bStart').disabled = true; $('bStart').textContent = 'Связываюсь с журналом…';
  try {
    const d = await api('start');
    await setSess({ started: Date.now(), next: Number(d.next), lists: d.lists });
    toast('Приёмка начата с артикула ' + pad(d.next));
  } catch (e) {
    const v = prompt('Не получилось связаться с журналом (' + e.message + ').\n\nЕсли точно знаешь следующий свободный артикул — введи его. Иначе нажми «Отмена» и попробуй при интернете.');
    if (v && /^\d+$/.test(v.trim())) {
      await setSess({ started: Date.now(), next: Number(v.trim()), lists: null, manual: true });
      toast('Приёмка начата вручную с ' + pad(v.trim()));
    }
  }
  $('bStart').disabled = false; $('bStart').textContent = 'Начать приёмку';
  renderLocal();
}

async function renderLocal() {
  const s = await getSess();
  $('noSess').classList.toggle('hide', !!s); $('sess').classList.toggle('hide', !s);
  refreshBar();
  if (!s) return;
  const tires = (await idb.all('tires')).sort((a, b) => b.art.localeCompare(a.art));
  const photos = await idb.all('photos');
  $('local').innerHTML = tires.map(t => {
    const ph = photos.filter(p => p.art === t.art).sort((a, b) => a.n - b.n);
    return '<div class="row" data-a="' + esc(t.art) + '">' +
      (ph[0] ? '<img src="' + ph[0].data + '" alt="">' : '<div class="noimg"></div>') +
      '<div class="t"><b>' + esc(t.art) + '</b> · ' + esc(t.size || '—') + '<div class="muted">' +
      esc([((t.brand || '') + ' ' + (t.model || '')).trim(), t.tread ? t.tread + ' мм' : '',
        t.cond && t.cond !== '-' ? t.cond : '', ph.length + ' фото'].filter(Boolean).join(' · ')) + '</div></div>' +
      '<span class="tag ' + (t.uploaded ? 'g' : t.status === 'Готово' ? '' : 'y') + '">' +
      (t.uploaded ? 'выгружена' : esc(t.status)) + '</span></div>';
  }).join('') || '<p class="muted">Шин пока нет. Нажми «+ Новая шина».</p>';
}
$('local').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openLocal(r.dataset.a); });

let lastType = '';
async function newTire() {
  const s = await getSess();
  if (!s) { toast('Сначала «Начать приёмку»'); return; }
  const art = pad(s.next);
  s.next += 1; await setSess(s);
  await idb.put('tires', { art: art, uid: uid(), date: new Date().toISOString(), status: 'Черновик', type: lastType, result: '-', uploaded: false });
  await openLocal(art, true);
}

async function uploadAll() {
  const s = await getSess(); if (!s) return;
  const tires = await idb.all('tires');
  const drafts = tires.filter(t => t.status !== 'Готово').length;
  if (drafts && !confirm('Есть черновики (не нажато «Сохранить»): ' + drafts + '. Выгрузить их как есть?')) return;
  const btn = $('bUp'), info = $('upInfo');
  btn.disabled = true;
  try {
    let i = 0;
    for (const t of tires) {
      if (t.uploaded) continue;
      info.textContent = 'Шины: ' + (++i) + ' из ' + tires.filter(x => !x.uploaded).length + '…';
      await api('uploadTire', { tire: payload(t) });
      t.uploaded = true; await idb.put('tires', t);
    }
    const ph = (await idb.all('photos')).filter(p => !p.up).sort((a, b) => a.art.localeCompare(b.art) || a.n - b.n);
    for (let k = 0; k < ph.length; k++) {
      info.textContent = 'Фото: ' + (k + 1) + ' из ' + ph.length + '…';
      await api('uploadPhoto', { art: ph[k].art, n: ph[k].n, b64: ph[k].data.split(',')[1] });
      ph[k].up = true; await idb.put('photos', ph[k]);
      refreshBar();
    }
    info.textContent = 'Завершаю…';
    await api('finish', { next: s.next });
    await idb.clear('tires'); await idb.clear('photos'); await idb.del('kv', 'session');
    info.textContent = 'Когда приёмка закончена и есть интернет — нажми «Выгрузить». Всё уйдёт на Google Диск.';
    toast('Выгружено: ' + tires.length + ' шин, ' + ph.length + ' фото. Телефон очищен.');
  } catch (e) {
    info.textContent = 'Выгрузка остановилась: ' + e.message + '. Уже отправленное не потеряется — нажми «Выгрузить» ещё раз, когда будет связь.';
  }
  btn.disabled = false;
  renderLocal();
}
const PKEYS = ['art', 'uid', 'date', 'status', 'type', 'size', 'brand', 'model', 'constr', 'ttl', 'serial', 'country',
  'tread', 'cond', 'norepair', 'noiz', 'result', 'place', 'note'];
function payload(t) { const o = {}; PKEYS.forEach(k => o[k] = t[k] == null ? '' : t[k]); return o; }

// ---------- кнопки-выбор ----------
const KINDS = { 'р': 'Ремонт', 'к': 'Косметика', 'х': 'Хим' };
const KIND_FULL = { 'р': 'Ремонт', 'к': 'Косметическое повреждение', 'х': 'Ремонт холодной вулканизацией' };
const PLACES = { 'бок': 'боковина', 'бег': 'беговая', 'плечо': 'плечо' };
const PLACE_FULL = { 'бок': 'на боковине', 'бег': 'на беговой дорожке', 'плечо': 'в плечевой зоне' };
const EXTRA = { 'нарезка': 'Нарезка', 'подкова': 'Подкова', 'проверка': 'Проверка на диске' };
let parts = {}, extras = new Set(), other = [];

function mkChips(box, items, multi, onClick) {
  box.innerHTML = '';
  Object.keys(items).forEach(v => {
    const b = document.createElement('button'); b.className = 'chip'; b.textContent = items[v]; b.dataset.v = v;
    b.onclick = () => {
      if (multi) b.classList.toggle('on');
      else { const was = b.classList.contains('on'); box.querySelectorAll('.chip').forEach(x => x.classList.remove('on')); if (!was) b.classList.add('on'); }
      if (onClick) onClick();
    };
    box.appendChild(b);
  });
}
// data-opts: «значение» или «значение=надпись на кнопке», через |
document.querySelectorAll('[data-f]').forEach(box => {
  const o = {};
  box.dataset.opts.split('|').forEach(v => { const i = v.indexOf('='); if (i > 0) o[v.slice(0, i)] = v.slice(i + 1); else o[v] = v; });
  mkChips(box, o, false);
});
function getChip(f) { const b = document.querySelector('[data-f="' + f + '"] .on'); return b ? b.dataset.v : ''; }
function setChip(f, v) { document.querySelectorAll('[data-f="' + f + '"] .chip').forEach(b => b.classList.toggle('on', b.dataset.v === v)); }
mkChips($('kind'), KINDS, false); mkChips($('place'), PLACES, false);
mkChips($('extra'), EXTRA, true, () => { extras = new Set([...$('extra').querySelectorAll('.on')].map(b => b.dataset.v)); showCode(); });

// ---------- состояние (коды как в 1С) ----------
function addPart() {
  const k = $('kind').querySelector('.on'), p = $('place').querySelector('.on');
  if (!k || !p) { toast('Выбери вид и место повреждения'); return; }
  const key = k.dataset.v + '|' + p.dataset.v; parts[key] = (parts[key] || 0) + 1; showCode();
}
function clearCond() { parts = {}; extras = new Set(); other = []; $('extra').querySelectorAll('.chip').forEach(b => b.classList.remove('on')); showCode(); }
function codeStr() {
  const out = [];
  Object.keys(PLACES).forEach(p => {
    const k = Object.keys(KINDS).filter(k => parts[k + '|' + p]).map(k => parts[k + '|' + p] + k);
    if (k.length) out.push(k.join(',') + '-' + p);
  });
  Object.keys(EXTRA).forEach(x => { if (extras.has(x)) out.push(x); });
  return out.concat(other).join(', ') || '-';
}
function parseCode(s) {
  parts = {}; extras = new Set(); other = [];
  String(s || '').split(/\s*;\s*|,\s+/).map(x => x.trim()).filter(x => x && x !== '-').forEach(x => {
    const m = x.match(/^((?:\d+[ркх],?)+)-(бок|бег|плечо)$/);
    if (m) m[1].split(',').filter(Boolean).forEach(y => { const z = y.match(/(\d+)([ркх])/); const key = z[2] + '|' + m[2]; parts[key] = (parts[key] || 0) + Number(z[1]); });
    else if (EXTRA[x.toLowerCase()]) extras.add(x.toLowerCase());
    else other.push(x);
  });
  $('extra').querySelectorAll('.chip').forEach(b => b.classList.toggle('on', extras.has(b.dataset.v)));
}
function showCode() {
  $('code').textContent = codeStr();
  const h = [];
  Object.keys(parts).forEach(key => { const [k, p] = key.split('|'); h.push(KIND_FULL[k] + ': ' + parts[key] + ' ' + PLACE_FULL[p]); });
  if (extras.has('нарезка')) h.push('Нарезка — протектор углублён');
  if (extras.has('подкова')) h.push('Подкова');
  if (extras.has('проверка')) h.push('Требуется проверка на диске');
  if (other.length) h.push('Прочее: ' + other.join(', '));
  $('human').textContent = h.length ? 'На сайте: ' + h.join('; ') : 'Без ремонтов';
}

// ---------- форма шины ----------
let cur = null, remotePics = [];
const FIELDS = ['size', 'tread', 'brand', 'model', 'serial', 'country', 'note'];
function fillForm(o) {
  $('art').textContent = o.art;
  FIELDS.forEach(f => $(f).value = o[f] || '');
  $('place_s').value = o.place || '';
  setChip('type', o.type); setChip('constr', o.constr); setChip('ttl', o.ttl); setChip('result', o.result || '-');
  setChip('noiz', o.noiz === 'Да' ? 'Да' : '-');
  parseCode(o.cond); showCode(); $('ferr').textContent = '';
}
async function openLocal(art, isNew) {
  const t = await idb.get('tires', art); if (!t) return;
  cur = Object.assign({ mode: 'local' }, t);
  fillForm(t);
  $('mode').textContent = isNew ? 'Новая шина — напиши артикул на шине' : 'Шина в телефоне';
  $('stat').textContent = (t.uploaded ? 'выгружена' : t.status) + ' · не на Диске до выгрузки';
  $('bNext').classList.remove('hide');
  await fillLists(); await drawPics(); tab('F');
}
async function openRemote(art) {
  const t = await api('get', { art: art });
  cur = Object.assign({ mode: 'remote' }, t);
  remotePics = t.pics || [];
  fillForm(t);
  $('mode').textContent = 'Правка шины в журнале (нужен интернет)';
  $('stat').textContent = (t.status || '') + (t.date ? ' · принята ' + t.date : '');
  $('bNext').classList.add('hide');
  await drawPics(); tab('F');
}
function closeForm() { const m = cur && cur.mode; cur = null; tab(m === 'remote' ? 'S' : 'P'); }

function collect() {
  const noRep = !Object.keys(parts).length && !other.length && !extras.has('нарезка') && !extras.has('подкова');
  const o = { art: cur.art, type: getChip('type'), constr: getChip('constr'), ttl: getChip('ttl'),
    result: getChip('result') || '-', cond: codeStr(), norepair: noRep ? 'Да' : '-', noiz: getChip('noiz') === 'Да' ? 'Да' : '-',
    place: $('place_s').value.trim() };
  FIELDS.forEach(f => o[f] = $(f).value.trim());
  o.tread = o.tread.replace(',', '.');
  return o;
}
// Черновик шины в телефоне сохраняется сам при каждом изменении — ничего не потеряется.
let dt;
function autoSave() {
  if (!cur || cur.mode !== 'local') return;
  clearTimeout(dt);
  dt = setTimeout(async () => {
    if (!cur || cur.mode !== 'local') return;
    const t = await idb.get('tires', cur.art); if (!t) return;
    Object.assign(t, collect(), { uploaded: false }); await idb.put('tires', t);
  }, 600);
}
$('F').addEventListener('input', autoSave);
$('F').addEventListener('click', e => { if (e.target.closest('.chip,.btn.sec')) autoSave(); });

async function saveForm(next) {
  if (!cur) return;
  if (!$('size').value.trim() || !$('tread').value.trim()) { $('ferr').textContent = 'Заполни размер и протектор'; return; }
  clearTimeout(dt);
  const o = Object.assign(collect(), { status: 'Готово' });
  lastType = o.type;
  try {
    if (cur.mode === 'local') {
      const t = await idb.get('tires', cur.art);
      Object.assign(t, o, { uploaded: false }); await idb.put('tires', t);
      Object.assign(cur, t);
      toast('Сохранено в телефоне: ' + cur.art);
      if (next) { await newTire(); return; }
      $('stat').textContent = 'Готово · сохранено в телефоне';
    } else {
      await api('save', { tire: o });
      toast('Сохранено в журнале: ' + cur.art);
      $('stat').textContent = 'Готово · сохранено в журнале';
    }
    $('ferr').textContent = '';
  } catch (e) { $('ferr').textContent = 'Не сохранилось: ' + e.message; }
}
['size', 'tread'].forEach(f => $(f).addEventListener('input', () => $('ferr').textContent = ''));

// ---------- фото ----------
function compress(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      const M = 1600, k = Math.min(1, M / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(img.src);
      res(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => rej(new Error('не удалось открыть фото'));
    img.src = URL.createObjectURL(file);
  });
}
async function addFiles(list) {
  if (!cur) return;
  for (const f of list) {
    let d;
    try { d = await compress(f); } catch (e) { toast(e.message); continue; }
    if (cur.mode === 'local') {
      const n = (await photosOf(cur.art)).reduce((m, p) => Math.max(m, p.n), 0) + 1;
      await idb.put('photos', { key: cur.art + '_' + n, art: cur.art, n: n, data: d, up: false });
    } else {
      toast('Отправляю фото…');
      try { remotePics.push(await api('addPhoto', { art: cur.art, b64: d.split(',')[1] })); toast('Фото добавлено'); }
      catch (e) { toast('Фото не отправлено: ' + e.message); }
    }
    await drawPics();
  }
  refreshBar();
}
$('cam').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('gal').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };

async function drawPics() {
  let items;
  if (cur.mode === 'local') {
    items = (await photosOf(cur.art)).map(p => ({ key: p.key, src: p.data, name: p.art + (p.n === 1 ? '' : '_' + p.n) + '.jpg', up: p.up }));
  } else {
    items = remotePics.slice().sort((a, b) => a.n - b.n).map(p => ({ key: p.id, src: 'https://drive.google.com/thumbnail?id=' + p.id + '&sz=w200', name: p.name, up: true }));
  }
  $('pc').textContent = '(' + items.length + ')';
  $('pics').innerHTML = items.map((p, i) => '<div class="' + (i === 0 ? 'main' : '') + '"><img src="' + esc(p.src) + '" alt="">' +
    '<b data-k="' + esc(p.key) + '">×</b><span>' + esc(p.name) + (cur.mode === 'local' && p.up ? ' ✓' : '') + '</span></div>').join('');
}
$('pics').addEventListener('click', async e => {
  const b = e.target.closest('b'); if (!b || !cur) return;
  if (!confirm('Удалить это фото?')) return;
  try {
    if (cur.mode === 'local') {
      const all = await photosOf(cur.art);
      if (all.some(p => p.up)) { toast('Фото этой шины уже начали выгружаться — удалять можно во вкладке «Шины» после выгрузки'); return; }
      const rest = all.filter(p => p.key !== b.dataset.k);
      for (const p of all) await idb.del('photos', p.key);
      for (let i = 0; i < rest.length; i++) { rest[i].n = i + 1; rest[i].key = cur.art + '_' + (i + 1); await idb.put('photos', rest[i]); }
    } else {
      remotePics = await api('delPhoto', { id: b.dataset.k });
    }
    await drawPics(); refreshBar();
  } catch (er) { toast('Не удалилось: ' + er.message); }
});

// ---------- шины в журнале ----------
let lt;
function debList() { clearTimeout(lt); lt = setTimeout(loadList, 500); }
async function loadList() {
  $('list').innerHTML = '<p class="muted">Загрузка…</p>';
  try {
    const l = await api('list', { q: $('q').value });
    $('list').innerHTML = l.map(t => '<div class="row" data-a="' + esc(t.art) + '">' +
      (t.thumb ? '<img src="' + esc(t.thumb) + '" alt="">' : '<div class="noimg"></div>') +
      '<div class="t"><b>' + esc(t.art) + '</b> · ' + esc(t.size || '—') + '<div class="muted">' + esc(((t.brand || '') + ' ' + (t.model || '')).trim()) +
      (t.tread ? ' · ' + esc(t.tread) + ' мм' : '') + ' · ' + esc(t.cond || '-') + ' · ' + esc(t.photos || 0) + ' фото</div></div>' +
      '<span class="tag ' + (t.status === 'Готово' ? 'g' : 'y') + '">' + esc(t.status) + '</span></div>').join('') ||
      '<p class="muted">Ничего не найдено</p>';
  } catch (e) { $('list').innerHTML = '<p class="err">Нет связи: ' + esc(e.message) + '</p>'; }
}
$('list').addEventListener('click', async e => {
  const r = e.target.closest('.row'); if (!r) return;
  try { await openRemote(r.dataset.a); } catch (er) { toast('Не открылась: ' + er.message); }
});
async function doExport() { toast('Сохраняю…'); try { toast(await api('exportXlsx')); } catch (e) { toast('Ошибка: ' + e.message); } }

// ---------- старт ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
showCode();
renderLocal();
