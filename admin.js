/* =====================================================================
   A4 survey admin dashboard: live progress of the roadside O-D survey
   against the sampling targets, bus counts, and the answers analysed.

   The password is checked by each Apps Script backend (Script property
   ADMIN_PASSWORD); nothing secret is stored in this file. The same page is
   in both apps (a4-od-survey-app and a4-bus-survey-app).
   ===================================================================== */

const SURVEYS = [
    { id: 'od', label: 'Vehicle O-D', icon: 'fa-car-side', url: 'https://script.google.com/macros/s/AKfycby-59ey8nmTd0EuS5ASO_VhR3tZuOAP5AeMsvjKf6TBpP-6GBd5gO5XTnk1oP8WcgmG/exec' },
    { id: 'bus', label: 'Bus survey', icon: 'fa-bus', url: 'https://script.google.com/macros/s/AKfycbxwvFHRKiUrdsHqi1wcGSWProQOpt5HlxhCbHFL9EZeb44alcswaAxnSxPap1kG_740/exec' }
];
const REFRESH_MS = 120000;
const PW_KEY = 'a4admin_pw';      // sessionStorage: kept only until the browser tab is closed
const VIEW_KEY = 'a4admin_view';  // localStorage: last tab / station / date
const OCCUPANCY = ['Empty', 'Less than 10', '10 – 20', '20 – 30', '30 – 40', '40 – 50', '50 – 60', '60 – 80', 'More than 80'];

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n).toLocaleString('en-US');
const pct = (a, b) => b > 0 ? Math.round(100 * a / b) : 0;
function store(kind, key, value) {
    try { value === undefined ? kind.removeItem(key) : kind.setItem(key, value); } catch (e) { /* private mode */ }
}
function load(kind, key) { try { return kind.getItem(key); } catch (e) { return null; } }

const state = Object.assign({ survey: 'od', station: 'all', date: 'all' }, JSON.parse(load(localStorage, VIEW_KEY) || '{}'));
let password = load(sessionStorage, PW_KEY) || '';
const data = {};    // survey id -> stats from the backend
const errors = {};  // survey id -> message
let editing = false;
let timer = null;

// ---------------------------------------------------------------------
// Backend calls
// ---------------------------------------------------------------------
async function call(survey, body) {
    const res = await fetch(survey.url, { method: 'POST', body: JSON.stringify(Object.assign({ password }, body)), headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
}
async function fetchSurvey(survey, body) {
    try {
        const r = await call(survey, body || { action: 'admin_stats' });
        if (r.status === 'success') { data[survey.id] = r; delete errors[survey.id]; return true; }
        errors[survey.id] = r.message || 'Error';
        if (r.auth === false) return false;
    } catch (e) {
        errors[survey.id] = e.message === 'Failed to fetch' ? 'No connection to the backend.' : e.message;
    }
    return null;
}
async function refreshAll() {
    $('refresh').disabled = true;
    await Promise.all(SURVEYS.map(s => fetchSurvey(s)));
    $('refresh').disabled = false;
    render();
}

// ---------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------
$('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    password = $('pw').value;
    $('login-btn').disabled = true;
    $('login-msg').textContent = '';
    const results = await Promise.all(SURVEYS.map(s => fetchSurvey(s)));
    $('login-btn').disabled = false;
    if (results.some(r => r === true)) { store(sessionStorage, PW_KEY, password); showDash(); return; }
    $('login-msg').textContent = errors.od || errors.bus || 'Could not log in.';
});
$('logout').addEventListener('click', () => {
    password = '';
    store(sessionStorage, PW_KEY);
    clearInterval(timer);
    Object.keys(data).forEach(k => delete data[k]);
    $('dash').classList.add('hidden');
    $('login').classList.remove('hidden');
    $('pw').value = '';
});
$('refresh').addEventListener('click', refreshAll);

function showDash() {
    $('login').classList.add('hidden');
    $('dash').classList.remove('hidden');
    render();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden && !editing) refreshAll(); }, REFRESH_MS);
}

// ---------------------------------------------------------------------
// Counting helpers: rows are [station, date, what, value, n]
// ---------------------------------------------------------------------
function rowsFor(d, what) {
    return (d.counts || []).filter(r => r[2] === what && (state.station === 'all' || r[0] === state.station) && (state.date === 'all' || r[1] === state.date));
}
function tally(d, what) {
    const m = new Map();
    rowsFor(d, what).forEach(r => m.set(r[3], (m.get(r[3]) || 0) + r[4]));
    return m;
}
function sortedDesc(m) { return [...m.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))); }

// ---------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------
function render() {
    const tabs = $('tabs');
    tabs.innerHTML = '';
    SURVEYS.forEach(s => {
        const b = document.createElement('button');
        b.className = 'tab';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(state.survey === s.id));
        const total = data[s.id] ? ` (${fmt(data[s.id].total)})` : '';
        b.innerHTML = `<i class="fa-solid ${s.icon}"></i> ${esc(s.label)}${total}`;
        b.addEventListener('click', () => { state.survey = s.id; editing = false; saveView(); render(); });
        tabs.appendChild(b);
    });
    const d = data[state.survey];
    renderFilters(d);
    $('updated').textContent = d ? `Updated ${d.generated.slice(11, 16)}` : '';
    const view = $('view');
    if (!d) {
        view.innerHTML = `<section class="card wide error-card"><h2><i class="fa-solid fa-triangle-exclamation"></i> ${esc(errors[state.survey] || 'Loading…')}</h2></section>`;
        return;
    }
    view.innerHTML = (errors[state.survey] ? `<section class="card wide error-card">Showing the last data: ${esc(errors[state.survey])}</section>` : '') +
        (state.survey === 'od' ? odView(d) : busView(d));
    if (state.survey === 'od') wireTargets(d);
}

function renderFilters(d) {
    const stations = d ? [...new Set((d.stations || []).concat((d.counts || []).map(r => r[0])))].sort() : [];
    const dates = d ? [...new Set((d.counts || []).map(r => r[1]))].sort().reverse() : [];
    if (state.station !== 'all' && !stations.includes(state.station)) state.station = 'all';
    if (state.date !== 'all' && !dates.includes(state.date)) state.date = 'all';
    $('f-station').innerHTML = `<option value="all">All stations</option>` + stations.map(s => `<option${s === state.station ? ' selected' : ''}>${esc(s)}</option>`).join('');
    $('f-date').innerHTML = `<option value="all">All dates</option>` + dates.map(s => `<option${s === state.date ? ' selected' : ''}>${esc(s)}</option>`).join('');
}
$('f-station').addEventListener('change', e => { state.station = e.target.value; editing = false; saveView(); render(); });
$('f-date').addEventListener('change', e => { state.date = e.target.value; saveView(); render(); });
function saveView() { store(localStorage, VIEW_KEY, JSON.stringify({ survey: state.survey, station: state.station, date: state.date })); }

function kpi(label, value, sub) {
    return `<div class="kpi"><div class="k-label">${esc(label)}</div><div class="k-value">${value}</div><div class="k-sub">${sub || '&nbsp;'}</div></div>`;
}
function progress(done, target) {
    if (!(target > 0)) return '<span class="muted">no target</span>';
    const p = pct(done, target);
    return `<div class="prog" title="${fmt(done)} of ${fmt(target)}"><div class="track"><div class="fill${p >= 100 ? ' done' : ''}" style="width:${Math.min(p, 100)}%"></div></div><span class="pct ${p >= 100 ? 'met' : ''}">${p >= 100 ? '✓ ' : ''}${p}%</span></div>`;
}
function bars(title, m, opts = {}) {
    let rows = opts.order ? opts.order.filter(k => m.has(k)).map(k => [k, m.get(k)]).concat(sortedDesc(m).filter(([k]) => !opts.order.includes(k))) : sortedDesc(m);
    const total = rows.reduce((s, r) => s + r[1], 0);
    const more = opts.top && rows.length > opts.top ? rows.length - opts.top : 0;
    if (more) rows = rows.slice(0, opts.top);
    const max = Math.max(1, ...rows.map(r => r[1]));
    const body = rows.length ? rows.map(([k, n]) =>
        `<div class="bar-row" title="${esc(k)}: ${fmt(n)} (${pct(n, total)}%)"><span class="b-label">${esc(k)}</span><div class="track"><div class="fill" style="width:${100 * n / max}%"></div></div><span class="b-val"><b>${fmt(n)}</b> · ${pct(n, total)}%</span></div>`).join('')
        : '<p class="empty">No answers yet.</p>';
    return `<section class="card"><h2>${esc(title)}</h2><div class="bars">${body}</div>${more ? `<p class="muted small card-note">+ ${more} more</p>` : ''}</section>`;
}
function recordersCard(d, noun) {
    const n = tally(d, 'recorder');
    const latest = new Map((d.recorders || []).map(r => [r.name, r]));
    const rows = sortedDesc(n).map(([name, c]) => {
        const r = latest.get(name) || {};
        return `<tr><td>${esc(name)}</td><td>${esc(r.station || '')}</td><td class="num">${fmt(c)}</td><td>${esc(r.last || '')}</td></tr>`;
    }).join('');
    return `<section class="card"><h2><i class="fa-solid fa-user"></i> Recorders</h2><div class="table-wrap"><table><tr><th>Recorder</th><th>Station (last)</th><th class="num">${esc(noun)}</th><th>Last record</th></tr>${rows || '<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>'}</table></div></section>`;
}

// ---------------------------------------------------------------------
// Vehicle O-D: progress against targets (as in the sampling plan) + answers
// ---------------------------------------------------------------------
function odTargets(d) {
    // Sum of the targets of the selected station(s): per class, per group, and per hour per group.
    const sts = state.station === 'all' ? Object.keys(d.targets || {}) : [state.station];
    const byClass = {}, group = {}, perHour = {};
    sts.forEach(st => {
        const t = (d.targets || {})[st];
        if (!t) return;
        d.classes.forEach(c => {
            const v = t.byClass[c.name];
            if (!(v > 0)) return;
            byClass[c.name] = (byClass[c.name] || 0) + v;
            group[c.group] = (group[c.group] || 0) + v;
            perHour[c.group] = (perHour[c.group] || 0) + v / (t.hours || 12);
        });
    });
    return { byClass, group, perHour };
}

function odView(d) {
    const done = tally(d, 'class');
    const t = odTargets(d);
    const hours = tally(d, 'hour'); // "07|Passenger" -> n
    const hourList = [...new Set([...hours.keys()].map(k => k.split('|')[0]))].sort();
    const totalDone = [...done.values()].reduce((s, n) => s + n, 0);
    const totalTarget = Object.values(t.group).reduce((s, n) => s + n, 0);
    const counted = d.classes.reduce((s, c) => s + Math.min(done.get(c.name) || 0, t.byClass[c.name] || 0), 0);
    const station = state.station === 'all' ? 'all stations' : state.station;
    const singleStation = state.station !== 'all';
    const tg = singleStation ? (d.targets[state.station] || { hours: 12, byClass: {} }) : null;

    let html = `<div class="kpis">` +
        kpi('Interviews', fmt(totalDone), `${esc(station)}${state.date !== 'all' ? ' · ' + esc(state.date) : ''}`) +
        kpi('Target', totalTarget ? fmt(totalTarget) : '–', totalTarget ? '' : 'set targets for this station') +
        kpi('Target reached', totalTarget ? pct(counted, totalTarget) + '%' : '–', 'counting each class up to its target') +
        kpi('Still needed', totalTarget ? fmt(Math.max(0, totalTarget - counted)) : '–', '') + `</div>`;

    // Progress table
    const groups = ['Passenger', 'Freight'];
    let rows = '';
    groups.forEach(g => {
        const cls = d.classes.filter(c => c.group === g);
        cls.forEach(c => {
            const n = done.get(c.name) || 0, target = t.byClass[c.name] || 0;
            const tcell = editing ? `<input type="number" min="0" step="1" data-class="${esc(c.name)}" value="${tg && tg.byClass[c.name] !== undefined ? tg.byClass[c.name] : ''}" aria-label="Target ${esc(c.name)}">` : (target ? fmt(target) : '–');
            rows += `<tr><td>${esc(c.name)}</td><td class="num">${tcell}</td><td class="num">${fmt(n)}</td><td class="num">${target ? fmt(Math.max(0, target - n)) : '–'}</td><td>${progress(n, target)}</td></tr>`;
        });
        const gDone = cls.reduce((s, c) => s + (done.get(c.name) || 0), 0);
        const gT = t.group[g] || 0;
        const ph = t.perHour[g] || 0;
        rows += `<tr class="group"><td>${g} total${ph ? ` <span class="muted small">· ${fmt(ph)} per hour</span>` : ''}</td><td class="num">${gT ? fmt(gT) : '–'}</td><td class="num">${fmt(gDone)}</td><td class="num">${gT ? fmt(Math.max(0, gT - gDone)) : '–'}</td><td>${progress(gDone, gT)}</td></tr>`;
    });
    const others = sortedDesc(done).filter(([k]) => !d.classes.some(c => c.name === k));
    others.forEach(([k, n]) => { rows += `<tr><td>${esc(k)}</td><td class="num">–</td><td class="num">${fmt(n)}</td><td class="num">–</td><td></td></tr>`; });
    rows += `<tr class="grand"><td>All vehicles</td><td class="num">${totalTarget ? fmt(totalTarget) : '–'}</td><td class="num">${fmt(totalDone)}</td><td class="num">${totalTarget ? fmt(Math.max(0, totalTarget - counted)) : '–'}</td><td>${progress(counted, totalTarget)}</td></tr>`;
    const editBtn = singleStation
        ? (editing
            ? `<label class="small">Survey hours <input type="number" min="1" max="24" step="0.5" id="t-hours" value="${tg.hours}"></label><button class="btn" id="t-save"><i class="fa-solid fa-floppy-disk"></i> Save targets</button><button class="btn-ghost" id="t-cancel">Cancel</button>`
            : `<button class="btn-ghost" id="t-edit"><i class="fa-solid fa-pen"></i> Edit targets</button>`)
        : '<span class="muted small">Pick one station to edit its targets</span>';
    const mapping = d.classes.map(c => `<li><b>${esc(c.name)}</b>: ${c.types.map(esc).join(', ')}</li>`).join('');
    html += `<section class="card wide"><h2><i class="fa-solid fa-bullseye"></i> Progress: ${esc(station)}<span class="spacer"></span>${editBtn}</h2>
        <div class="table-wrap"><table><tr><th>Type of vehicle</th><th class="num">Total to be surveyed</th><th class="num">Surveyed</th><th class="num">Remaining</th><th>Progress</th></tr>${rows}</table></div>
        <details class="map card-note"><summary class="small">Which app vehicle types count in each class</summary><ul class="small">${mapping}</ul></details></section>`;

    // Per hour
    const hourRows = hourList.map(h => {
        const cells = groups.map(g => {
            const n = hours.get(`${h}|${g}`) || 0, need = t.perHour[g] || 0;
            const cls = need && state.date !== 'all' ? (n >= need ? 'met' : 'below') : '';
            return `<td class="num ${cls}">${fmt(n)}${need && state.date !== 'all' ? ` <span class="muted small">/ ${fmt(need)}</span>` : ''}</td>`;
        }).join('');
        const tot = groups.reduce((s, g) => s + (hours.get(`${h}|${g}`) || 0), 0) + (hours.get(`${h}|Other`) || 0);
        return `<tr><td>${esc(h)}:00</td>${cells}<td class="num">${fmt(tot)}</td></tr>`;
    }).join('');
    html += `<section class="card"><h2><i class="fa-solid fa-clock"></i> Interviews per hour</h2>
        <div class="table-wrap"><table><tr><th>Hour</th><th class="num">Passenger</th><th class="num">Freight</th><th class="num">Total</th></tr>${hourRows || '<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>'}</table></div>
        <p class="muted small card-note">${state.date === 'all' ? 'Pick a date to compare each hour with the per-hour target.' : 'Shown as surveyed / needed per hour.'}</p></section>`;
    html += recordersCard(d, 'Interviews');

    // Answers
    html += bars('Direction', tally(d, 'direction'));
    html += bars('Vehicle type', tally(d, 'type'));
    html += bars('Origin district', tally(d, 'originDistrict'), { top: 12 });
    html += bars('Destination district', tally(d, 'destinationDistrict'), { top: 12 });
    html += bars('Trip purpose', tally(d, 'tripPurpose'));
    html += bars('Trip frequency', tally(d, 'frequency'));
    html += bars('Future use of the Kahathuduwa – Ingiriya Expressway', tally(d, 'expressway'));
    html += bars('Commodity (freight)', tally(d, 'commodity'));
    html += bars('Load condition (freight)', tally(d, 'load'));
    html += bars('Monthly household income (owners)', tally(d, 'income'));
    return html;
}

function wireTargets(d) {
    const edit = $('t-edit'), save = $('t-save'), cancel = $('t-cancel');
    if (edit) edit.addEventListener('click', () => { editing = true; render(); });
    if (cancel) cancel.addEventListener('click', () => { editing = false; render(); });
    if (save) save.addEventListener('click', async () => {
        const byClass = {};
        document.querySelectorAll('input[data-class]').forEach(i => { byClass[i.dataset.class] = i.value === '' ? '' : Math.max(0, Math.round(+i.value)); });
        save.disabled = true;
        const ok = await fetchSurvey(SURVEYS[0], { action: 'admin_set_targets', targets: { [state.station]: { hours: +$('t-hours').value, byClass } } });
        save.disabled = false;
        if (ok) editing = false;
        else alert(errors.od || 'Could not save the targets.');
        render();
    });
}

// ---------------------------------------------------------------------
// Bus survey: counts by direction, hour and route
// ---------------------------------------------------------------------
function busView(d) {
    const dir = tally(d, 'direction');
    const total = [...dir.values()].reduce((s, n) => s + n, 0);
    const routes = tally(d, 'route'); // "122 · Colombo – Avissawella|To Colombo" -> n
    const byRoute = new Map();
    routes.forEach((n, k) => {
        const i = k.lastIndexOf('|');
        const r = k.slice(0, i), dr = k.slice(i + 1);
        const o = byRoute.get(r) || { to: 0, from: 0, other: 0 };
        if (dr === 'To Colombo') o.to += n; else if (dr === 'From Colombo') o.from += n; else o.other += n;
        byRoute.set(r, o);
    });
    const station = state.station === 'all' ? 'all stations' : state.station;
    let html = `<div class="kpis">` +
        kpi('Buses counted', fmt(total), `${esc(station)}${state.date !== 'all' ? ' · ' + esc(state.date) : ''}`) +
        kpi('To Colombo', fmt(dir.get('To Colombo') || 0), total ? pct(dir.get('To Colombo') || 0, total) + '%' : '') +
        kpi('From Colombo', fmt(dir.get('From Colombo') || 0), total ? pct(dir.get('From Colombo') || 0, total) + '%' : '') +
        kpi('Routes seen', fmt(byRoute.size), '') + `</div>`;

    const hours = tally(d, 'hour');
    const hourList = [...new Set([...hours.keys()].map(k => k.split('|')[0]))].sort();
    const hourRows = hourList.map(h => {
        const to = hours.get(`${h}|To Colombo`) || 0, from = hours.get(`${h}|From Colombo`) || 0;
        const all = [...hours.entries()].filter(([k]) => k.startsWith(h + '|')).reduce((s, [, n]) => s + n, 0);
        return `<tr><td>${esc(h)}:00</td><td class="num">${fmt(to)}</td><td class="num">${fmt(from)}</td><td class="num">${fmt(all)}</td></tr>`;
    }).join('');
    html += `<section class="card"><h2><i class="fa-solid fa-clock"></i> Buses per hour</h2><div class="table-wrap"><table><tr><th>Hour</th><th class="num">To Colombo</th><th class="num">From Colombo</th><th class="num">Total</th></tr>${hourRows || '<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>'}</table></div></section>`;
    html += recordersCard(d, 'Buses');

    const routeRows = [...byRoute.entries()].sort((a, b) => (b[1].to + b[1].from + b[1].other) - (a[1].to + a[1].from + a[1].other)).map(([r, o]) =>
        `<tr><td>${esc(r)}</td><td class="num">${fmt(o.to)}</td><td class="num">${fmt(o.from)}</td><td class="num"><b>${fmt(o.to + o.from + o.other)}</b></td></tr>`).join('');
    html += `<section class="card wide"><h2><i class="fa-solid fa-route"></i> Buses by route</h2><div class="table-wrap"><table><tr><th>Route</th><th class="num">To Colombo</th><th class="num">From Colombo</th><th class="num">Total</th></tr>${routeRows || '<tr><td colspan="4" class="empty">Nothing recorded yet.</td></tr>'}</table></div></section>`;
    html += bars('Operator', tally(d, 'operator'));
    html += bars('Bus size', tally(d, 'size'));
    html += bars('Number of passengers', tally(d, 'occupancy'), { order: OCCUPANCY });
    return html;
}

// ---------------------------------------------------------------------
// Start: log straight in if the password is kept for this browser tab.
// ---------------------------------------------------------------------
if (password) {
    showDash();
    refreshAll().then(() => { if (!SURVEYS.some(s => data[s.id])) $('logout').click(); });
}
