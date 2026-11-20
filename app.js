// Приём шин — приложение для телефона. Работает без интернета, выгрузка на Google Диск кнопкой.
const VERSION = '1.4 (20.11.2026)';
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
let currentSessionView = null;          // открытая папка приёмки во вкладке «Шины» (или null — список папок)
let navCtx = { list: [], idx: -1 };     // ← → по шинам в телефоне
let keepView = false;
function tab(x) {
  ['P', 'S', 'C', 'F', 'B'].forEach(k => $(k).classList.toggle('hide', k !== x));
  ['P', 'S', 'C'].forEach(k => $('t' + k).classList.toggle('on', k === x || (x === 'B' && k === 'P') ||
    (x === 'F' && k === (cur && cur.mode === 'remote' ? 'S' : 'P'))));
  // Нажатие на вкладку «Шины» — к списку папок. Возврат из карточки шины — остаёмся там, где были.
  if (x === 'S' && !keepView) { $('q').value = ''; currentSessionView = null; }
  keepView = false;
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
    await setSess({ started: Date.now(), next: Number(d.next), lists: d.lists, hist: d.hist || null });
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
  const tires = (await idb.all('tires')).sort((a, b) => Number(a.art) - Number(b.art));
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
  if (!s.first) s.first = s.next;   // первый номер этой приёмки (для проверки «Копии»)
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
    // Приёмка (папка) создаётся на сервере при первой шине; имя запоминаем — при обрыве связи будет та же папка.
    let currentSession = s.uploadSession || '';
    const sd = new Date(s.started || Date.now());
    const sdate = String(sd.getDate()).padStart(2, '0') + '.' + String(sd.getMonth() + 1).padStart(2, '0') + '.' + sd.getFullYear();
    let i = 0;
    for (const t of tires.sort((a, b) => Number(a.art) - Number(b.art))) {
      if (t.uploaded) continue;
      info.textContent = 'Шины: ' + (++i) + ' из ' + tires.filter(x => !x.uploaded).length + '…';
      const res = await api('uploadTire', { tire: payload(t), session: currentSession, sdate: sdate });
      if (res && res.session && !currentSession) {
        currentSession = res.session; s.uploadSession = currentSession; await setSess(s);
      }
      t.uploaded = true; t.sent = true; await idb.put('tires', t);  // sent: шина уже есть в журнале — не удалять и не занимать номер
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
    toast('Выгружено: ' + tires.length + ' шин, ' + ph.length + ' фото' + (currentSession ? ' → приёмка ' + currentSession : '') + '. Телефон очищен.');
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
  await fillLists(); await drawPics(); await updateNavUI(); tab('F');
}
async function openRemote(art) {
  const t = await api('get', { art: art });
  cur = Object.assign({ mode: 'remote' }, t);
  remotePics = t.pics || [];
  fillForm(t);
  $('mode').textContent = 'Правка шины в журнале (нужен интернет)';
  $('stat').textContent = (t.status || '') + (t.date ? ' · принята ' + t.date : '') + (t.session ? ' · ' + t.session : '');
  $('bNext').classList.add('hide');
  await drawPics(); await updateNavUI(); tab('F');
}

// Панель ← →, «Копия» и «Удалить» — только для шин в телефоне (до выгрузки).
async function updateNavUI() {
  const local = !!cur && cur.mode === 'local';
  ['navBar', 'bCopy', 'bDel'].forEach(id => $(id).classList.toggle('hide', !local));
  if (!local) return;
  const tires = (await idb.all('tires')).sort((a, b) => Number(a.art) - Number(b.art));
  navCtx.list = tires.map(t => t.art);
  navCtx.idx = navCtx.list.indexOf(cur.art);
  $('navInfo').textContent = (navCtx.idx + 1) + ' / ' + navCtx.list.length;
  $('btnPrev').disabled = navCtx.idx <= 0;
  $('btnNext').disabled = navCtx.idx < 0 || navCtx.idx >= navCtx.list.length - 1;
}
async function navGo(dir) {
  if (!cur || cur.mode !== 'local') return;
  clearTimeout(dt); await doAutoSave();        // сохранить текущую карточку перед переходом
  const i = navCtx.idx + dir;
  if (i < 0 || i >= navCtx.list.length) return;
  await openLocal(navCtx.list[i], false);
}
function navPrev() { return navGo(-1); }
function navNext() { return navGo(1); }

// Копия: новая шина с теми же размером, брендом, моделью, типом, конструкцией, TT/TL и страной.
async function copyTire() {
  if (!cur || cur.mode !== 'local') return;
  clearTimeout(dt); await doAutoSave();
  const s = await getSess(); if (!s) return;
  const v = prompt('Артикул для копии (напиши его на шине):', pad(s.next));
  if (v === null) return;
  const n = v.trim();
  if (!/^\d+$/.test(n)) { alert('Артикул — только цифры'); return; }
  const art = pad(Number(n));
  if (await idb.get('tires', art)) { alert('Шина ' + art + ' уже есть в телефоне'); return; }
  // Номер меньше «следующего» можно взять, только если он освободился в этой приёмке (шину удалили до выгрузки).
  // Иначе он может быть занят в журнале — будет дубль.
  const arts = (await idb.all('tires')).map(t => Number(t.art));
  const first = Math.min(s.first || Infinity, ...arts);
  if (Number(art) < s.next && Number(art) < first) { alert('Номер ' + art + ' может быть уже занят в журнале. Возьми ' + pad(s.next) + ' или больше.'); return; }
  if (Number(art) >= s.next) { s.next = Number(art) + 1; await setSess(s); }
  const o = collect();
  await idb.put('tires', { art: art, uid: uid(), date: new Date().toISOString(),
    size: o.size, brand: o.brand, model: o.model, type: o.type, constr: o.constr, ttl: o.ttl, country: o.country,
    tread: '', serial: '', cond: '-', noiz: '-', norepair: '-', result: '-', place: '', note: '',
    status: 'Черновик', uploaded: false });
  toast('Создана копия: ' + art);
  await openLocal(art, true);
}

// Удалить шину из телефона (только если её ещё нет в журнале).
async function deleteCurrentTire() {
  if (!cur || cur.mode !== 'local') return;
  const t = await idb.get('tires', cur.art); if (!t) return;
  if (t.sent || (await photosOf(cur.art)).some(p => p.up)) {
    alert('Эта шина уже выгружена (или начала выгружаться). Удалять в Google Таблице.'); return;
  }
  if (!confirm('Удалить шину ' + cur.art + ' и все её фото? Это необратимо.')) return;
  clearTimeout(dt);                              // чтобы автосохранение не вернуло запись
  const s = await getSess();
  for (const p of await photosOf(cur.art)) await idb.del('photos', p.key);
  await idb.del('tires', cur.art);
  if (s && Number(cur.art) === s.next - 1) { s.next = Number(cur.art); await setSess(s); }  // удалили последнюю — номер освобождается
  toast('Шина ' + cur.art + ' удалена');
  closeForm();
}
function closeForm() { const m = cur && cur.mode; cur = null; if (m === 'remote') keepView = true; tab(m === 'remote' ? 'S' : 'P'); }

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
async function doAutoSave() {
  if (!cur || cur.mode !== 'local') return;
  const t = await idb.get('tires', cur.art); if (!t) return;
  Object.assign(t, collect(), { uploaded: false }); await idb.put('tires', t);
}
function autoSave() {
  if (!cur || cur.mode !== 'local') return;
  clearTimeout(dt);
  dt = setTimeout(doAutoSave, 600);
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

// ---------- автоподстановка ----------
// Конструкция по размеру: «R» перед диаметром — радиальная, дефис — диагональная.
function inferConstr(size) {
  const s = String(size || '').trim();
  if (/R\s*\d+(?:[.,]\d+)?\s*$/i.test(s)) return 'Радиальная';
  if (s.includes('-')) return 'Диагональная';
  return '';
}
// TT/TL, тип и страна — из последней шины с тем же размером, брендом и моделью:
// сначала из телефона, потом из журнала (подсказки приходят при «Начать приёмку»). Заполняются только пустые поля.
async function inferFromHistory() {
  if (!cur || cur.mode !== 'local') return;
  const size = $('size').value.trim(), brand = $('brand').value.trim(), model = $('model').value.trim();
  if (!size || !brand || !model) return;
  const k = [size, brand, model].map(x => x.toLowerCase());
  const same = t => [t.size, t.brand, t.model].map(x => String(x || '').trim().toLowerCase()).join('|') === k.join('|');
  const loc = (await idb.all('tires')).filter(t => t.art !== cur.art && same(t) && (t.ttl || t.type || t.country))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const s = await getSess();
  const h = loc || (s && s.hist && s.hist[k.join('|')]);
  if (!h) return;
  let ch = false;
  if (!getChip('ttl') && h.ttl) { setChip('ttl', h.ttl); ch = true; }
  if (!getChip('type') && h.type) { setChip('type', h.type); ch = true; }
  if (!$('country').value.trim() && h.country) { $('country').value = h.country; ch = true; }
  if (ch) autoSave();
}
$('size').addEventListener('change', () => {
  if (cur && cur.mode === 'local' && !getChip('constr')) { const c = inferConstr($('size').value); if (c) { setChip('constr', c); autoSave(); } }
  inferFromHistory();
});
$('brand').addEventListener('change', inferFromHistory);
$('model').addEventListener('change', inferFromHistory);

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

// ---------- массовая загрузка фото (с проверкой «фото → артикул») ----------
// Фото раздаются по порядку шинам БЕЗ фото. Перед сохранением кладовщик видит каждое фото и номер шины
// и может поменять номер или выбрать «не добавлять». Ничего не пишется, пока не нажато «Сохранить фото».
let bulk = [];   // [{ file, url, art }]
async function addBulkPhotos(files) {
  if (!(await getSess())) { toast('Сначала «Начать приёмку»'); return; }
  const tires = (await idb.all('tires')).sort((a, b) => Number(a.art) - Number(b.art));
  if (!tires.length) { toast('В текущей приёмке нет шин'); return; }
  const photos = await idb.all('photos');
  const free = tires.filter(t => !photos.some(p => p.art === t.art));
  const arr = [...files];
  bulk.forEach(b => URL.revokeObjectURL(b.url));
  bulk = arr.map((f, i) => ({ file: f, url: URL.createObjectURL(f), art: free[i] ? free[i].art : '' }));
  const opt = tires.map(t => '<option value="' + esc(t.art) + '">' + esc(t.art + ' · ' + (t.size || '—') + ' ' + (t.brand || '')) + '</option>').join('');
  $('bList').innerHTML = bulk.map((b, i) => '<div class="brow" data-i="' + i + '"><img src="' + b.url + '" alt="">' +
    '<div class="t"><div class="muted">Фото ' + (i + 1) + ' из ' + bulk.length + '</div>' +
    '<select data-i="' + i + '"><option value="">— не добавлять —</option>' + opt + '</select></div></div>').join('');
  $('bList').querySelectorAll('select').forEach(sel => { sel.value = bulk[sel.dataset.i].art; markBulk(sel); });
  const extra = arr.length - free.length;
  $('bInfo').textContent = 'Фото: ' + arr.length + ', шин без фото: ' + free.length + '. ' +
    (!free.length ? 'У всех шин уже есть фото — выбери номер вручную.' :
      extra > 0 ? 'Лишние ' + extra + ' фото пока не добавляются.' :
      extra < 0 ? 'Без фото останутся: ' + free.slice(arr.length).map(t => t.art).join(', ') + '.' : 'Каждой шине по одному фото.') +
    ' Сравни номер на шине на фото с номером справа.';
  $('bErr').textContent = '';
  tab('B');
}
function markBulk(sel) { bulk[sel.dataset.i].art = sel.value; sel.closest('.brow').classList.toggle('skip', !sel.value); }
$('bList').addEventListener('change', e => { if (e.target.tagName === 'SELECT') markBulk(e.target); });
function cancelBulk() { bulk.forEach(b => URL.revokeObjectURL(b.url)); bulk = []; $('bList').innerHTML = ''; tab('P'); }
async function saveBulk() {
  const todo = bulk.filter(b => b.art);
  if (!todo.length) { $('bErr').textContent = 'Ни одному фото не выбран номер шины'; return; }
  const btn = $('bSave'); btn.disabled = true;
  let ok = 0, errs = 0;
  for (let i = 0; i < todo.length; i++) {
    btn.textContent = 'Загрузка ' + (i + 1) + '/' + todo.length + '…';
    try {
      const d = await compress(todo[i].file), art = todo[i].art;
      const n = (await photosOf(art)).reduce((m, p) => Math.max(m, p.n), 0) + 1;
      await idb.put('photos', { key: art + '_' + n, art: art, n: n, data: d, up: false });
      ok++;
    } catch (e) { errs++; }
  }
  btn.disabled = false; btn.textContent = 'Сохранить фото';
  const skipped = bulk.length - todo.length;
  toast('Добавлено фото: ' + ok + (errs ? ', ошибок: ' + errs : '') + (skipped ? ', не добавлено: ' + skipped : ''));
  cancelBulk(); refreshBar();
}
$('bulk').onchange = e => { addBulkPhotos(e.target.files); e.target.value = ''; };

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
// showStatus — в поиске справа приёмка, поэтому статус «Черновик» пишем в строке под размером.
function tireRow(t, tagText, tagCls, showStatus) {
  const info = [((t.brand || '') + ' ' + (t.model || '')).trim(), t.tread ? t.tread + ' мм' : '',
    t.cond && t.cond !== '-' ? t.cond : '', (t.photos || 0) + ' фото',
    showStatus && t.status && t.status !== 'Готово' ? t.status : ''].filter(Boolean).join(' · ');
  return '<div class="row" data-a="' + esc(t.art) + '">' +
    (t.thumb ? '<img src="' + esc(t.thumb) + '" alt="">' : '<div class="noimg"></div>') +
    '<div class="t"><b>' + esc(t.art) + '</b> · ' + esc(t.size || '—') + '<div class="muted">' + esc(info) + '</div></div>' +
    '<span class="tag ' + tagCls + '">' + esc(tagText) + '</span></div>';
}
// Три состояния: поиск по всем приёмкам / шины одной приёмки / список приёмок (папок).
async function loadList() {
  const q = $('q').value.trim(), sl = $('sessList'), tl = $('tireList');
  const busy = el => { el.innerHTML = '<p class="muted">Загрузка…</p>'; };
  try {
    if (q) {
      sl.classList.add('hide'); tl.classList.remove('hide'); busy(tl);
      const l = await api('list', { q: q });
      if ($('q').value.trim() !== q) return;   // пока грузилось, ввели другое
      tl.innerHTML = l.map(t => tireRow(t, t.session || '', '', true)).join('') || '<p class="muted">Ничего не найдено</p>';
    } else if (currentSessionView) {
      const id = currentSessionView;
      sl.classList.add('hide'); tl.classList.remove('hide');
      const head = '<div class="session-header"><button class="btn sec" onclick="closeSession()">← К папкам</button><b>📁 ' + esc(id) + '</b></div>' +
        '<button class="btn" onclick="doExport(currentSessionView)">Сохранить в Excel</button><div style="height:10px"></div>';
      tl.innerHTML = head + '<p class="muted">Загрузка…</p>';
      const l = await api('list', { session: id });
      if (currentSessionView !== id) return;
      tl.innerHTML = head + (l.map(t => tireRow(t, t.status || '', t.status === 'Готово' ? 'g' : 'y')).join('') || '<p class="muted">В папке нет шин</p>');
    } else {
      tl.classList.add('hide'); sl.classList.remove('hide'); busy(sl);
      const l = await api('listSessions');
      if ($('q').value.trim() || currentSessionView) return;
      sl.innerHTML = l.map(s => '<div class="row" data-s="' + esc(s.id) + '"><div class="folder">📁</div>' +
        '<div class="t"><b>' + esc(s.id) + '</b><div class="muted">' + esc(s.count) + ' шин</div></div><span class="arr">→</span></div>').join('') ||
        '<p class="muted">Выгруженных приёмок пока нет</p>';
    }
  } catch (e) {
    const el = q || currentSessionView ? tl : sl;
    el.innerHTML = '<p class="err">Нет связи: ' + esc(e.message) + '</p>';
  }
}
function openSession(id) { currentSessionView = id; loadList(); window.scrollTo(0, 0); }
function closeSession() { currentSessionView = null; loadList(); }
$('sessList').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openSession(r.dataset.s); });
$('tireList').addEventListener('click', async e => {
  if (e.target.closest('.session-header') || e.target.tagName === 'BUTTON') return;
  const r = e.target.closest('.row'); if (!r) return;
  try { await openRemote(r.dataset.a); } catch (er) { toast('Не открылась: ' + er.message); }
});
async function doExport(session) { toast('Сохраняю в Excel…'); try { toast(await api('exportXlsx', { session: session })); } catch (e) { toast('Ошибка: ' + e.message); } }
function doExportAll() { return doExport(null); }

// ---------- старт ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
showCode();
renderLocal();
