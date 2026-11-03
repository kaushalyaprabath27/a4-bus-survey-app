/* =====================================================================
   A4 Godagama – Avissawella widening (feasibility study): roadside bus survey
   ---------------------------------------------------------------------
   One record per bus passing the O-D station. The recorder and station
   (OD 1 – OD 7, from the project KMZ) are set once per shift; every record
   saves its own date, time, Record No. and GPS position.

   Per bus: direction of travel (to / from Colombo), route (quick picks, the
   full list, search or add a new one), operator, bus size and approximate
   number of passengers.
   Routes added on any phone are sent with its records, saved in the
   sheet's Routes tab and offered to every phone as suggestions.

   Offline-first, like the other survey apps: each record goes to
   localStorage first and is sent to the Apps Script backend in batches
   (every 15 s and on reconnect).
   ===================================================================== */

const CONFIG = Object.assign({ appsScriptUrl: '', stations: [], routes: [], routeRefreshMinutes: 5 }, window.A4BUS_CONFIG || {});

const PLACEHOLDER_URL = 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL_HERE';
const SURVEY_TYPE = 'a4-bus-survey';
// v3: direction is To / From Colombo (no From / To route ends).
// v2: no service type or station description; occupancy as passenger counts.
const SYNC_ACTION = 'submit_a4bus_v3';
const BATCH_SIZE = 50;
const SYNC_INTERVAL_MS = 15000;

const QUEUE_KEY = 'a4bus_queue';          // records waiting to sync
const BACKUP_KEY = 'a4bus_backup';        // every record saved on this device
const SESSION_KEY = 'a4bus_session';      // recorder, station
const DRAFT_KEY = 'a4bus_draft';          // the record being filled in
const HISTORY_KEY = 'a4bus_history';      // undo stack (eventIds)
const SEQ_KEY = 'a4bus_seq';              // Record No. counters per recorder and day
const MY_ROUTES_KEY = 'a4bus_my_routes';  // routes added on this phone
const SHARED_ROUTES_KEY = 'a4bus_shared'; // routes added by everyone (from the sheet)
const USAGE_KEY = 'a4bus_usage';          // station -> route key -> times recorded
const THEME_KEY = 'a4bus_theme';

// Answers for each bus. Edit option lists here.
const DIRECTIONS = [['To Colombo', 'fa-arrow-left'], ['From Colombo', 'fa-arrow-right']];
const OPERATORS = [['SLTB', 'fa-building-columns'], ['Private', 'fa-user-tie']];
const SIZES = [['Large bus', 'fa-bus'], ['Minibus', 'fa-van-shuttle']];
const OCCUPANCY = [
    ['Empty', 'fa-circle'], ['Less than 10', null], ['10 – 20', null], ['20 – 30', null], ['30 – 40', null],
    ['40 – 50', null], ['50 – 60', null], ['60 – 80', null], ['More than 80', 'fa-people-group']
];
const REQUIRED = ['dir', 'route', 'operator', 'size', 'occupancy'];

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
function readJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
}
function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { console.error('localStorage write failed for', key, e); showStorageWarning(); return false; }
}
function generateId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}
const pad2 = n => String(n).padStart(2, '0');
function formatDate(ts) { const d = new Date(ts); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function formatTime(ts) { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; }
function escapeHtml(str) { return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
const $ = id => document.getElementById(id);
const iconHtml = icon => !icon ? '' : icon.startsWith('<') ? icon : `<i class="fa-solid ${icon}"></i>`;
function haversineM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
let session = readJSON(SESSION_KEY, null);
let cur = readJSON(DRAFT_KEY, {});    // { dir: 'To Colombo' | 'From Colombo', route: key, operator, size, occupancy }
if (cur.dir && !DIRECTIONS.some(d => d[0] === cur.dir)) cur.dir = ''; // draft from the A → B version
let isSyncing = false;
let inFlightIds = new Set();
let lastSyncError = null;

const screens = { welcome: $('screen-welcome'), setup: $('screen-setup'), survey: $('screen-survey') };
function showScreen(name) {
    Object.keys(screens).forEach(k => screens[k].classList.toggle('active', k === name));
    document.body.classList.toggle('on-survey', name === 'survey');
}
function saveSession() { writeJSON(SESSION_KEY, session); }
function saveDraft() { writeJSON(DRAFT_KEY, cur); }
function stationById(id) { return CONFIG.stations.find(s => s.id === id) || null; }

// ---------------------------------------------------------------------
// Toasts, modal, storage warning, theme
// ---------------------------------------------------------------------
let toastTimer = null;
function showToast(message, type = 'success') {
    const c = $('toast-container');
    c.innerHTML = '';
    const t = el('div', `toast ${type}`);
    t.textContent = message;
    c.appendChild(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), 2200);
}
function openModal({ title, html, okLabel = 'OK', cancelLabel = 'Cancel', danger = false, showCancel = true, onOpen = null, validate = null }) {
    return new Promise(resolve => {
        const modal = $('modal'), ok = $('modal-ok'), cancel = $('modal-cancel');
        $('modal-title').textContent = title;
        $('modal-body').innerHTML = html;
        ok.textContent = okLabel;
        ok.classList.toggle('danger', danger);
        cancel.textContent = cancelLabel;
        cancel.classList.toggle('hidden', !showCancel);
        modal.classList.remove('hidden');
        if (onOpen) onOpen($('modal-body'));
        const close = r => {
            modal.classList.add('hidden');
            ok.removeEventListener('click', onOk);
            cancel.removeEventListener('click', onCancel);
            resolve(r);
        };
        const onOk = () => { if (validate && !validate($('modal-body'))) return; close(true); };
        const onCancel = () => close(false);
        ok.addEventListener('click', onOk);
        cancel.addEventListener('click', onCancel);
    });
}
let storageWarningEl = null;
function showStorageWarning() {
    if (storageWarningEl && document.body.contains(storageWarningEl)) return;
    storageWarningEl = el('div', 'storage-warning', 'DEVICE STORAGE FULL: new records may NOT be saved. Sync or export a backup now. <button type="button">Dismiss</button>');
    storageWarningEl.setAttribute('role', 'alert');
    storageWarningEl.querySelector('button').addEventListener('click', () => { storageWarningEl.remove(); storageWarningEl = null; });
    document.body.prepend(storageWarningEl);
    if (navigator.onLine) syncQueue();
}
function applyTheme(theme) {
    const isLight = theme === 'light';
    document.body.classList.toggle('light-theme', isLight);
    $('theme-toggle').querySelector('i').className = isLight ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
    document.querySelector('meta[name="theme-color"]').setAttribute('content', isLight ? '#f1f5f9' : '#0f172a');
}
$('theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('light-theme') ? 'dark' : 'light';
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
});

// ---------------------------------------------------------------------
// GPS: watched from the setup screen on (nearest station) and while surveying.
// A record takes the latest fix without waiting, so counting stays fast.
// ---------------------------------------------------------------------
const GPS_FRESH_MS = 120000;
let lastFix = null, gpsWatch = null, gpsError = '';
function onFix(pos) {
    lastFix = { lat: +pos.coords.latitude.toFixed(6), lon: +pos.coords.longitude.toFixed(6), acc: Math.round(pos.coords.accuracy), ts: pos.timestamp || Date.now() };
    gpsError = '';
    updateGpsStatus();
    renderStations();
}
function onFixError(err) { gpsError = err && err.code === 1 ? 'denied' : 'unavailable'; updateGpsStatus(); renderStations(); }
function startGps() {
    if (gpsWatch !== null || !('geolocation' in navigator)) { updateGpsStatus(); return; }
    gpsWatch = navigator.geolocation.watchPosition(onFix, onFixError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function fixIsFresh() { return !!lastFix && Date.now() - lastFix.ts < GPS_FRESH_MS; }
function updateGpsStatus() {
    const chip = $('gps-chip');
    let cls = 'chip gps-chip', text;
    if (!('geolocation' in navigator)) { cls += ' bad'; text = 'No GPS'; }
    else if (fixIsFresh()) { cls += lastFix.acc <= 30 ? ' good' : ' fair'; text = `GPS ±${lastFix.acc} m`; }
    else if (gpsError === 'denied') { cls += ' bad'; text = 'GPS blocked'; }
    else { cls += ' wait'; text = lastFix ? 'GPS (old fix)' : 'GPS searching…'; }
    chip.className = cls;
    chip.querySelector('.gps-text').textContent = text;
}

// ---------------------------------------------------------------------
// Welcome + shift setup (recorder, station)
// ---------------------------------------------------------------------
const inputName = $('surveyor-name');
const btnStart = $('btn-start');
let pickedStation = session ? session.station : '';

$('btn-next').addEventListener('click', () => { showScreen('setup'); startGps(); });

function renderStations() {
    const box = $('station-list');
    const here = lastFix;
    let nearest = null;
    if (here) CONFIG.stations.forEach(s => { const d = haversineM(here, s); if (!nearest || d < nearest.d) nearest = { id: s.id, d }; });
    box.innerHTML = '';
    CONFIG.stations.forEach(s => {
        const d = here ? haversineM(here, s) : null;
        const b = el('button', 'chip-opt station-opt' + (s.id === pickedStation ? ' selected' : ''),
            `<i class="fa-solid fa-location-dot"></i><span><b>${escapeHtml(s.id)}</b>` +
            (d !== null ? `<small>${fmtDist(d)} away${nearest && nearest.id === s.id ? ' · <em>nearest</em>' : ''}</small>` : '') + '</span>');
        b.type = 'button';
        b.dataset.value = s.id;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(s.id === pickedStation));
        b.addEventListener('click', () => { pickedStation = s.id; renderStations(); checkSetupForm(); });
        box.appendChild(b);
    });
    const note = $('station-gps');
    note.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> ' + (here
        ? `Your position is ±${here.acc} m. Nearest station: <b>${escapeHtml(nearest.id)}</b> (${fmtDist(nearest.d)}).`
        : gpsError === 'denied' ? 'Location is blocked, so pick the station yourself. Records are saved without GPS.'
            : 'Finding your position to show the nearest station…');
}
function checkSetupForm() {
    const ok = !!(inputName.value.trim() && pickedStation);
    btnStart.disabled = !ok;
    btnStart.classList.toggle('btn-disabled', !ok);
}
inputName.addEventListener('input', checkSetupForm);

btnStart.addEventListener('click', () => {
    if (btnStart.disabled) return;
    session = { id: generateId(), active: true, name: inputName.value.trim(), station: pickedStation, startedAt: Date.now() };
    saveSession();
    writeJSON(HISTORY_KEY, []);
    startGps();
    startSurveyScreen();
});

function startSurveyScreen() {
    $('info-name').textContent = session.name;
    $('info-station').textContent = session.station;
    renderAll();
    updateCount();
    updateGpsStatus();
    updateSyncStatus();
    showScreen('survey');
}

// ---------------------------------------------------------------------
// Routes: the config list, routes shared through the sheet and routes added
// on this phone. A route is the same whichever way its ends are written.
// ---------------------------------------------------------------------
const norm = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9/]+/g, ' ').trim();
function routeKey(r) { return [norm(r.no), ...[norm(r.a), norm(r.b)].sort()].join('|'); }
function routeLabel(r) { return (r.no ? `${r.no} · ` : '') + `${r.a} – ${r.b}`; }
function allRoutes() {
    const out = new Map();
    const add = (r, source) => {
        const k = routeKey(r);
        if (!out.has(k)) out.set(k, Object.assign({ stations: [] }, r, { key: k, source }));
    };
    CONFIG.routes.forEach(([no, a, b, stations]) => add({ no, a, b, stations: stations || [] }, 'list'));
    readJSON(SHARED_ROUTES_KEY, []).forEach(r => add(r, 'shared'));
    readJSON(MY_ROUTES_KEY, []).forEach(r => add(r, 'added'));
    return out;
}
function usageHere() { return (readJSON(USAGE_KEY, {})[session && session.station] || {}); }
// Quick picks: routes recorded most at this station, then routes that pass it.
function quickRoutes() {
    const routes = allRoutes(), use = usageHere(), st = session && session.station;
    // Most recorded here first, then routes the enumerators added, then the list order.
    const scored = [...routes.values()]
        .map((r, i) => ({ r, i, n: use[r.key] || 0, here: r.stations.includes(st), added: r.source !== 'list' }))
        .filter(x => x.n > 0 || x.here)
        .sort((x, y) => y.n - x.n || (y.added - x.added) || x.i - y.i);
    return scored.slice(0, 10).map(x => x.r);
}
function searchRoutes(text) {
    const words = norm(text).split(/\s+/).filter(Boolean);
    const use = usageHere();
    return [...allRoutes().values()]
        .filter(r => words.every(w => `${norm(r.no)} ${norm(r.a)} ${norm(r.b)} ${r.a.toLowerCase()} ${r.b.toLowerCase()}`.includes(w)))
        .sort((x, y) => ((norm(y.no) === words[0]) - (norm(x.no) === words[0])) || (use[y.key] || 0) - (use[x.key] || 0) || routeLabel(x).localeCompare(routeLabel(y)))
        .slice(0, 30);
}
// Route numbers in natural order: 3, 3/6, 18/2, 23, 99, 122, 122/1 ... (unnumbered last).
function byRouteNo(x, y) {
    const parts = r => (r.no || '~').split(/[^0-9]+/).filter(Boolean).map(Number);
    const a = parts(x), b = parts(y);
    if (!x.no !== !y.no) return x.no ? -1 : 1;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    }
    return routeLabel(x).localeCompare(routeLabel(y));
}
function currentRoute() { return cur.route ? allRoutes().get(cur.route) || cur.routeObj || null : null; }

// Shared routes from the sheet (GET ?action=routes).
let lastRouteFetch = 0;
function fetchSharedRoutes(force) {
    if (!isBackendConfigured() || !navigator.onLine) return;
    if (!force && Date.now() - lastRouteFetch < (CONFIG.routeRefreshMinutes || 5) * 60000) return;
    lastRouteFetch = Date.now();
    fetch(CONFIG.appsScriptUrl + (CONFIG.appsScriptUrl.includes('?') ? '&' : '?') + 'action=routes')
        .then(res => res.json())
        .then(d => {
            if (d.status !== 'success' || !Array.isArray(d.routes)) return;
            writeJSON(SHARED_ROUTES_KEY, d.routes.map(r => ({ no: String(r.no || ''), a: String(r.a || ''), b: String(r.b || ''), stations: r.stations || [] })).filter(r => r.a && r.b));
            if (screens.survey.classList.contains('active')) renderRouteSection();
        })
        .catch(err => console.warn('Route list not updated:', err));
}

async function addRouteDialog(prefill) {
    let res = null;
    const guess = (prefill || '').trim();
    const isNo = /^[0-9][0-9/\-]*$/.test(guess);
    const ok = await openModal({
        title: 'Add a bus route',
        html: `<p class="modal-note">Write the route as it is shown on the bus. It is saved for every phone.</p>
            <label class="modal-label" for="nr-no">Route number (if shown)</label><input id="nr-no" class="other-input" type="text" inputmode="text" placeholder="e.g. 122/2" value="${isNo ? escapeHtml(guess) : ''}">
            <label class="modal-label" for="nr-a">From (end A)</label><input id="nr-a" class="other-input" type="text" placeholder="e.g. Colombo" value="${isNo ? '' : escapeHtml(guess)}">
            <label class="modal-label" for="nr-b">To (end B)</label><input id="nr-b" class="other-input" type="text" placeholder="e.g. Kosgama">`,
        okLabel: 'Add route',
        onOpen: body => setTimeout(() => body.querySelector(isNo ? '#nr-a' : '#nr-no').focus(), 60),
        validate: body => {
            const no = body.querySelector('#nr-no').value.trim(), a = body.querySelector('#nr-a').value.trim(), b = body.querySelector('#nr-b').value.trim();
            if (!a || !b) { showToast('Type both ends of the route', 'error'); return false; }
            if (norm(a) === norm(b)) { showToast('The two ends must be different', 'error'); return false; }
            res = { no, a, b, stations: [session.station] };
            return true;
        }
    });
    if (!ok || !res) return;
    const k = routeKey(res);
    const existing = allRoutes().get(k);
    if (!existing) {
        const mine = readJSON(MY_ROUTES_KEY, []);
        mine.push(res);
        writeJSON(MY_ROUTES_KEY, mine);
        showToast(`Route added: ${routeLabel(res)}`);
    } else showToast(`Already in the list: ${routeLabel(existing)}`, 'info');
    selectRoute(k);
}

// ---------------------------------------------------------------------
// The record form
// ---------------------------------------------------------------------
const formEl = $('bus-form');
const sections = {};
function qBlock(id, num, label, hint) {
    const q = el('section', 'q');
    q.dataset.q = id;
    q.appendChild(el('div', 'q-label', `<span class="q-num">${num}</span><span>${escapeHtml(label)}</span>` + (hint ? `<span class="q-hint">${escapeHtml(hint)}</span>` : '')));
    formEl.appendChild(q);
    sections[id] = q;
    return q;
}
function choiceRow(q, id, options, cls) {
    const box = el('div', 'chips ' + (cls || 'grid'));
    box.setAttribute('role', 'radiogroup');
    options.forEach(([value, icon]) => {
        const b = el('button', 'chip-opt', iconHtml(icon) + `<span>${escapeHtml(value)}</span>`);
        b.type = 'button';
        b.dataset.value = value;
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => { cur[id] = cur[id] === value ? '' : value; changed(); });
        box.appendChild(b);
    });
    q.appendChild(box);
    return box;
}

function buildForm() {
    formEl.innerHTML = '';
    // 1. Direction
    choiceRow(qBlock('dir', '1', 'Direction of travel', 'Which way is the bus going?'), 'dir', DIRECTIONS, 'yesno dir-chips');
    // 2. Route
    const q1 = qBlock('route', '2', 'Bus route', 'Read the route board');
    q1.appendChild(el('div', 'route-picked hidden'));
    q1.appendChild(el('div', 'chips grid route-quick'));
    const allBox = el('details', 'route-all');
    allBox.innerHTML = '<summary><i class="fa-solid fa-list"></i> All bus routes in the area <span class="route-all-n"></span></summary><div class="route-all-list"></div>';
    q1.appendChild(allBox);
    const wrap = el('div', 'place');
    wrap.innerHTML = '<i class="fa-solid fa-magnifying-glass place-icon"></i><input type="text" class="bus-search" placeholder="Search number or town, e.g. 122 or Kosgama" aria-label="Search bus routes"><ul class="suggest hidden" role="listbox"></ul>';
    q1.appendChild(wrap);
    const addBtn = el('button', 'btn-link route-add', '<i class="fa-solid fa-plus"></i> Add a route that is not in the list');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => addRouteDialog(wrap.querySelector('input').value));
    q1.appendChild(addBtn);
    const input = wrap.querySelector('input'), list = wrap.querySelector('ul');
    const showList = () => {
        const t = input.value.trim();
        if (!t) { list.classList.add('hidden'); return; }
        const rows = searchRoutes(t);
        list.innerHTML = '';
        rows.forEach(r => {
            const li = el('li', '', `<div class="s-main"><i class="fa-solid fa-bus"></i> ${escapeHtml(routeLabel(r))}${r.source !== 'list' ? '<span class="s-tag">added</span>' : ''}</div>`);
            li.setAttribute('role', 'option');
            li.addEventListener('mousedown', e => e.preventDefault());
            li.addEventListener('click', () => { input.value = ''; list.classList.add('hidden'); selectRoute(r.key); });
            list.appendChild(li);
        });
        const add = el('li', 's-typed', `<div class="s-main"><i class="fa-solid fa-plus"></i> Add “${escapeHtml(t)}” as a new route</div>`);
        add.setAttribute('role', 'option');
        add.addEventListener('mousedown', e => e.preventDefault());
        add.addEventListener('click', () => { list.classList.add('hidden'); addRouteDialog(t); input.value = ''; });
        list.appendChild(add);
        list.classList.remove('hidden');
    };
    input.addEventListener('input', showList);
    input.addEventListener('focus', () => { setTimeout(() => q1.scrollIntoView({ block: 'start', behavior: 'smooth' }), 150); showList(); });
    input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 150));
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); const first = list.querySelector('li'); if (first) first.click(); }
        if (e.key === 'Escape') list.classList.add('hidden');
    });

    // 3 – 5
    choiceRow(qBlock('operator', '3', 'Operator'), 'operator', OPERATORS, 'yesno');
    choiceRow(qBlock('size', '4', 'Bus size'), 'size', SIZES, 'yesno');
    choiceRow(qBlock('occupancy', '5', 'Number of passengers', 'Approximate count, including standing'), 'occupancy', OCCUPANCY, 'grid occ-grid');
}

function selectRoute(key) {
    const r = allRoutes().get(key);
    cur.route = key;
    cur.routeObj = r ? { no: r.no, a: r.a, b: r.b, source: r.source } : null;
    changed();
    setTimeout(() => sections.operator.scrollIntoView({ block: 'center', behavior: 'smooth' }), 80);
}

function renderRouteSection() {
    const q = sections.route;
    const r = currentRoute();
    const picked = q.querySelector('.route-picked');
    picked.classList.toggle('hidden', !r);
    if (r) {
        picked.innerHTML = `<span class="route-name"><i class="fa-solid fa-bus"></i> ${escapeHtml(routeLabel(r))}</span>`;
        const x = el('button', 'icon-btn route-change', '<i class="fa-solid fa-xmark"></i><span class="hide-sm">Change</span>');
        x.type = 'button';
        x.addEventListener('click', () => { cur.route = ''; cur.routeObj = null; changed(); });
        picked.appendChild(x);
    }
    const all = q.querySelector('.route-all');
    all.classList.toggle('hidden', !!r);
    if (!r) {
        const routes = [...allRoutes().values()].sort(byRouteNo);
        all.querySelector('.route-all-n').textContent = `(${routes.length})`;
        const listEl = all.querySelector('.route-all-list');
        listEl.innerHTML = '';
        routes.forEach(rt => {
            const b = el('button', 'route-row', `<b>${escapeHtml(rt.no || '–')}</b><span>${escapeHtml(rt.a)} – ${escapeHtml(rt.b)}</span>`);
            b.type = 'button';
            b.dataset.value = rt.key;
            b.addEventListener('click', () => { all.open = false; selectRoute(rt.key); });
            listEl.appendChild(b);
        });
    }
    const quick = q.querySelector('.route-quick');
    quick.innerHTML = '';
    quick.classList.toggle('hidden', !!r);
    q.querySelector('.place').classList.toggle('hidden', !!r);
    q.querySelector('.route-add').classList.toggle('hidden', !!r);
    if (!r) {
        const routes = quickRoutes();
        routes.forEach(rt => {
            const b = el('button', 'chip-opt', `<i class="fa-solid fa-bus"></i><span>${escapeHtml(routeLabel(rt))}</span>`);
            b.type = 'button';
            b.dataset.value = rt.key;
            b.addEventListener('click', () => selectRoute(rt.key));
            quick.appendChild(b);
        });
        if (!routes.length) quick.appendChild(el('p', 'chips-empty', 'Search for the route below. Routes you record here will appear as quick picks.'));
    }
}

function renderAll() {
    renderRouteSection();
    ['dir', 'operator', 'size', 'occupancy'].forEach(id => {
        sections[id].querySelectorAll('.chip-opt').forEach(b => {
            const on = cur[id] === b.dataset.value;
            b.classList.toggle('selected', on);
            b.setAttribute('aria-checked', String(on));
        });
    });
    refreshProgress();
}
function answeredCount() { return REQUIRED.filter(id => !!cur[id] && (id !== 'route' || !!currentRoute())).length; }
function refreshProgress() {
    REQUIRED.forEach(id => sections[id].classList.toggle('answered', !!cur[id] && (id !== 'route' || !!currentRoute())));
    const n = answeredCount();
    $('progress').textContent = `${n} of ${REQUIRED.length} answered`;
    return n;
}
function changed() { saveDraft(); renderAll(); }

// ---------------------------------------------------------------------
// Record No.: recorder initials, date and a counter on this device, e.g. KW-20261103-0042.
// ---------------------------------------------------------------------
function initials(name) {
    const letters = String(name || '').trim().split(/\s+/).filter(Boolean).map(w => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
    return (letters || 'X').slice(0, 3);
}
function recordKey() { return `${initials(session.name)}-${formatDate(Date.now()).replace(/-/g, '')}`; }
function nextRecordNo(take) {
    const key = recordKey(), seq = readJSON(SEQ_KEY, {});
    const n = (seq[key] || 0) + 1;
    if (take) { seq[key] = n; writeJSON(SEQ_KEY, seq); }
    return `${key}-${String(n).padStart(4, '0')}`;
}
function releaseRecordNo(id) {
    const m = /^(.*)-(\d+)$/.exec(id || '');
    if (!m) return;
    const seq = readJSON(SEQ_KEY, {});
    if (seq[m[1]] === +m[2]) { seq[m[1]] = +m[2] - 1; writeJSON(SEQ_KEY, seq); }
}

// ---------------------------------------------------------------------
// Save / clear / undo
// ---------------------------------------------------------------------
function buildRecord(recordNo, ts) {
    const r = currentRoute() || {};
    const fix = fixIsFresh() ? lastFix : null;
    return {
        action: 'submit',
        surveyType: SURVEY_TYPE,
        eventId: generateId(),
        sessionId: session.id,
        recordNo,
        name: session.name,
        station: session.station,
        shiftStart: `${formatDate(session.startedAt)} ${formatTime(session.startedAt).slice(0, 5)}`,
        date: formatDate(ts),
        time: formatTime(ts),
        gpsLat: fix ? fix.lat : '',
        gpsLon: fix ? fix.lon : '',
        gpsAccuracyM: fix ? fix.acc : '',
        gpsStatus: fix ? 'ok' : (lastFix ? 'stale' : 'unavailable'),
        routeNo: r.no || '',
        routeA: r.a || '',
        routeB: r.b || '',
        routeSource: r.source || '',
        direction: cur.dir || '',
        operator: cur.operator || '',
        busSize: cur.size || '',
        occupancy: cur.occupancy || ''
    };
}

function resetForm() {
    cur = {};
    saveDraft();
    renderAll();
    $('form-scroll').scrollTo({ top: 0, behavior: 'smooth' });
}

$('btn-save').addEventListener('click', async () => {
    const n = refreshProgress();
    if (!currentRoute()) { showToast('Pick the bus route first', 'error'); return; }
    if (n < REQUIRED.length) {
        const names = { route: 'Bus route', dir: 'Direction of travel', operator: 'Operator', size: 'Bus size', occupancy: 'Number of passengers' };
        const missing = REQUIRED.filter(id => !cur[id]).map(id => `<li>${names[id]}</li>`).join('');
        const ok = await openModal({ title: `Save with ${REQUIRED.length - n} blank?`, html: `These are blank:<ul style="margin:0.5rem 0 0 1.2rem">${missing}</ul>`, okLabel: 'Save anyway', cancelLabel: 'Go back' });
        if (!ok) return;
    }
    const record = buildRecord(nextRecordNo(true), Date.now());
    const queue = readJSON(QUEUE_KEY, []);
    queue.push(record);
    if (!writeJSON(QUEUE_KEY, queue)) { showToast('STORAGE FULL: record NOT saved!', 'error'); return; }
    const backup = readJSON(BACKUP_KEY, []);
    backup.push(record);
    writeJSON(BACKUP_KEY, backup);
    const history = readJSON(HISTORY_KEY, []);
    history.push(record.eventId);
    writeJSON(HISTORY_KEY, history.slice(-50));
    const usage = readJSON(USAGE_KEY, {});
    usage[session.station] = usage[session.station] || {};
    usage[session.station][cur.route] = (usage[session.station][cur.route] || 0) + 1;
    writeJSON(USAGE_KEY, usage);
    resetForm();
    updateCount();
    updateSyncStatus();
    showToast(`Bus ${record.recordNo.split('-').pop()} saved: ${[record.routeNo, record.direction].filter(Boolean).join(' · ')}`);
    syncQueue();
});

$('btn-clear').addEventListener('click', async () => {
    if (!answeredCount()) return;
    const ok = await openModal({ title: 'Clear this record?', html: 'All answers for this bus will be removed. Saved records are not affected.', okLabel: 'Clear', danger: true });
    if (ok) resetForm();
});

$('btn-undo').addEventListener('click', async () => {
    const history = readJSON(HISTORY_KEY, []);
    const id = history[history.length - 1];
    if (!id) { showToast('Nothing to undo', 'error'); return; }
    if (inFlightIds.has(id)) { showToast('Sending it right now. Try again in a moment.', 'error'); return; }
    const record = readJSON(QUEUE_KEY, []).find(r => r.eventId === id);
    if (!record) { history.pop(); writeJSON(HISTORY_KEY, history); showToast('Already synced to the sheet. Cannot undo.', 'error'); return; }
    const ok = await openModal({
        title: 'Delete the last saved bus?',
        html: `${escapeHtml(record.recordNo)}: ${escapeHtml([record.routeNo, record.direction].filter(Boolean).join(' · '))}, saved at ${escapeHtml(record.time)}.`,
        okLabel: 'Delete', danger: true
    });
    if (!ok) return;
    history.pop();
    writeJSON(HISTORY_KEY, history);
    writeJSON(QUEUE_KEY, readJSON(QUEUE_KEY, []).filter(r => r.eventId !== id));
    writeJSON(BACKUP_KEY, readJSON(BACKUP_KEY, []).filter(r => r.eventId !== id));
    releaseRecordNo(record.recordNo);
    const usage = readJSON(USAGE_KEY, {});
    const k = routeKey({ no: record.routeNo, a: record.routeA, b: record.routeB });
    if (usage[record.station] && usage[record.station][k]) { usage[record.station][k]--; writeJSON(USAGE_KEY, usage); }
    updateCount();
    updateSyncStatus();
    renderAll();
    showToast('Last bus deleted');
});

function sessionRecords() { return session ? readJSON(BACKUP_KEY, []).filter(r => r.sessionId === session.id) : []; }
function updateCount() { $('count-session').textContent = sessionRecords().length; }

// ---------------------------------------------------------------------
// End shift
// ---------------------------------------------------------------------
$('btn-end').addEventListener('click', async () => {
    const records = sessionRecords();
    const ok = await openModal({
        title: 'End shift?',
        html: `<b>${escapeHtml(session.name)}</b> at <b>${escapeHtml(session.station)}</b>: ${records.length} bus(es) recorded.` + (answeredCount() ? '<br><b>The record on screen is not saved yet</b> and will be kept as a draft.' : ''),
        okLabel: 'End shift', danger: true
    });
    if (!ok) return;
    session.active = false;
    saveSession();
    writeJSON(HISTORY_KEY, []);
    syncQueue();
    const pending = readJSON(QUEUE_KEY, []).length;
    const byDir = {};
    records.forEach(r => { const k = r.direction || '(no direction)'; byDir[k] = (byDir[k] || 0) + 1; });
    const rows = Object.keys(byDir).sort((a, b) => byDir[b] - byDir[a]).slice(0, 6).map(k => `<tr><td>${escapeHtml(k)}</td><td>${byDir[k]}</td></tr>`).join('');
    await openModal({
        title: `${session.name}: shift ended`,
        html: `<table><tr><td>Buses recorded</td><td>${records.length}</td></tr>${rows}<tr><td>Waiting to sync (this device)</td><td>${pending}</td></tr></table>` +
            (pending ? '<p style="margin-top:0.6rem">Keep the app open with internet until everything is synced, or export a backup.</p>' : ''),
        okLabel: 'New shift', showCancel: false
    });
    inputName.value = session.name;
    pickedStation = session.station;
    renderStations();
    checkSetupForm();
    showScreen('setup');
});

// ---------------------------------------------------------------------
// Sync (batches of 50, removed from the queue only after server success)
// ---------------------------------------------------------------------
function isBackendConfigured() { return !!CONFIG.appsScriptUrl && CONFIG.appsScriptUrl !== PLACEHOLDER_URL; }
function syncQueue() {
    if (isSyncing || !navigator.onLine || !isBackendConfigured()) { updateSyncStatus(); return; }
    fetchSharedRoutes(false);
    const queue = readJSON(QUEUE_KEY, []);
    if (!queue.length) { updateSyncStatus(); return; }
    const batch = queue.slice(0, BATCH_SIZE);
    isSyncing = true;
    inFlightIds = new Set(batch.map(r => r.eventId));
    updateSyncStatus();
    fetch(CONFIG.appsScriptUrl, { method: 'POST', body: JSON.stringify({ action: SYNC_ACTION, payload: batch }), headers: { 'Content-Type': 'text/plain;charset=utf-8' } })
        .then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
        .then(result => {
            if (result.status !== 'success') throw new Error(result.message || 'Server error');
            writeJSON(QUEUE_KEY, readJSON(QUEUE_KEY, []).filter(r => !inFlightIds.has(r.eventId)));
            lastSyncError = null;
            if (batch.some(r => r.routeSource === 'added')) fetchSharedRoutes(true);
        })
        .catch(err => { lastSyncError = err.message || String(err); console.error('Sync failed:', err); })
        .finally(() => {
            isSyncing = false;
            inFlightIds = new Set();
            updateSyncStatus();
            if (!lastSyncError && readJSON(QUEUE_KEY, []).length) setTimeout(syncQueue, 800);
        });
}
function updateSyncStatus() {
    const node = $('sync-status');
    const pending = readJSON(QUEUE_KEY, []).length;
    let cls = 'sync-status', label;
    if (!isBackendConfigured()) { cls += ' unconfigured'; label = `Not linked to sheet · ${pending} on device`; }
    else if (!navigator.onLine) { cls += ' offline'; label = `Offline · ${pending} pending`; }
    else if (isSyncing) { cls += ' syncing'; label = `Syncing · ${pending} pending`; }
    else if (lastSyncError && pending) { cls += ' error'; label = `Sync error · ${pending} pending`; }
    else if (pending) { cls += ' pending'; label = `Online · ${pending} pending`; }
    else label = 'Online · Synced';
    node.className = cls;
    node.querySelector('.sync-text').textContent = label;
    node.title = lastSyncError ? `Last error: ${lastSyncError}` : '';
}
window.addEventListener('online', () => { updateSyncStatus(); syncQueue(); fetchSharedRoutes(true); });
window.addEventListener('offline', updateSyncStatus);

// ---------------------------------------------------------------------
// Local backup export
// ---------------------------------------------------------------------
function exportLocalBackup() {
    const records = readJSON(BACKUP_KEY, []), pending = readJSON(QUEUE_KEY, []);
    if (!records.length && !pending.length) { showToast('No records on this device yet', 'error'); return; }
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records, pendingSync: pending, addedRoutes: readJSON(MY_ROUTES_KEY, []) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = `a4_bus_backup_${formatDate(Date.now())}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast(`Backup exported (${records.length} records)`);
}
$('btn-export').addEventListener('click', exportLocalBackup);
$('btn-export-setup').addEventListener('click', exportLocalBackup);

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
function init() {
    let theme = 'dark';
    try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (e) {}
    applyTheme(theme);
    const markHostBadge = () => {
        if (/\.netlify\.app$/.test(location.hostname) || document.querySelector('script[src*="/.netlify/scripts/"]')) document.body.classList.add('has-host-badge');
    };
    markHostBadge();
    document.addEventListener('DOMContentLoaded', markHostBadge);
    if (CONFIG.projectName) document.querySelector('#screen-welcome .subtitle').textContent = `${CONFIG.projectName} · One record per bus`;

    buildForm();
    if (session) inputName.value = session.name || '';
    renderStations();
    checkSetupForm();
    if (session && session.active) {
        startGps();
        startSurveyScreen();
        if (answeredCount()) showToast('Unsaved record restored');
    }
    updateSyncStatus();
    fetchSharedRoutes(true);
    setInterval(syncQueue, SYNC_INTERVAL_MS);
    setInterval(() => { if (screens.survey.classList.contains('active')) updateGpsStatus(); }, 15000);
    if (!isBackendConfigured()) setTimeout(() => showToast('Apps Script URL not set: data is kept on this device only', 'error'), 600);
    syncQueue();
}

init();
