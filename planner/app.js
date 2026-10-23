/* Roman's Planner
 * Plain JS, no build step. Data lives in planner/data/planner.json in the repo and is
 * committed through the GitHub Contents API (batched autosave). Canvas items arrive in
 * planner/data/canvas.json via the planner-sync GitHub Action.
 */
(() => {
'use strict';

// ---------- Constants ----------
const STATUSES = [
    { id: 'todo',      label: 'To Do',       icon: '○' },
    { id: 'doing',     label: 'In Progress', icon: '◐' },
    { id: 'review',    label: 'In Review',   icon: '◎' },
    { id: 'complete',  label: 'Complete',    icon: '●' },
    { id: 'turned_in', label: 'Turned In',   icon: '✓' },
];
const DONE = new Set(['complete', 'turned_in']);
const TYPES = [
    { id: 'homework', label: 'Homework' },
    { id: 'quiz',     label: 'Quiz' },
    { id: 'test',     label: 'Test' },
    { id: 'project',  label: 'Project' },
    { id: 'reading',  label: 'Reading' },
    { id: 'other',    label: 'Other' },
];
const ACCENTS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#f43f5e', '#06b6d4', '#f97316', '#84cc16', '#ec4899'];
const CLASS_COLORS = ['#3b82f6', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f97316', '#ec4899', '#84cc16', '#eab308', '#14b8a6', '#a855f7'];
const DEFAULT_GH = { owner: 'DestinyRoman', repo: 'roman-talaiver-source', branch: 'main', path: 'planner/data/planner.json', token: '' };
const AUTOSAVE_MS = 15000;
const OLD_TURNED_IN_DAYS = 14;
const LS = { gh: 'planner.gh', cache: 'planner.cache', ui: 'planner.ui' };

// ---------- Small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const nowIso = () => new Date().toISOString();
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const todayStr = () => ymd(new Date());
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
function b64decode(b64) {
    const bin = atob(b64.replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function toast(msg, ms = 2600) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- State ----------
const emptyData = () => ({ version: 1, updatedAt: nowIso(), settings: { accent: ACCENTS[0], settingsAt: nowIso() }, classes: [], tasks: [] });
let data = emptyData();
let canvas = null;           // contents of canvas.json
let gh = { ...DEFAULT_GH, ...lsGet(LS.gh, {}) };
let sha = null;              // sha of planner.json on the branch
let dirty = false;
let changeLog = [];
let saveTimer = null;
let saving = false;
let saveAgain = false;
let editGen = 0;
let lastSaved = null;
let ui = { view: 'board', search: '', type: '', hiddenClasses: [], showOld: false, weekStart: null, month: null, ...lsGet(LS.ui, {}) };

const connected = () => !!gh.token;
const liveTasks = () => data.tasks.filter(t => !t.deleted);
const classById = (id) => data.classes.find(c => c.id === id && !c.deleted);
const classColor = (id) => classById(id)?.color || '#64748b';
const saveUi = () => lsSet(LS.ui, { ...ui, weekStart: null, month: null });

// ---------- Merge (last writer wins per item) ----------
function mergeList(a = [], b = []) {
    const map = new Map();
    for (const item of [...a, ...b]) {
        const cur = map.get(item.id);
        if (!cur || (item.updatedAt || '') > (cur.updatedAt || '')) map.set(item.id, item);
    }
    return [...map.values()];
}
function mergeData(a, b) {
    if (!a) return b; if (!b) return a;
    const sa = a.settings || {}, sb = b.settings || {};
    return {
        version: 1,
        updatedAt: nowIso(),
        settings: (sb.settingsAt || '') > (sa.settingsAt || '') ? sb : sa,
        classes: mergeList(a.classes, b.classes),
        tasks: mergeList(a.tasks, b.tasks),
    };
}
function normalize(d) {
    d = { ...emptyData(), ...(d || {}) };
    d.settings = { ...emptyData().settings, ...(d.settings || {}) };
    d.classes = Array.isArray(d.classes) ? d.classes : [];
    d.tasks = (Array.isArray(d.tasks) ? d.tasks : []).map(t => ({ subtasks: [], status: 'todo', type: 'homework', ...t }));
    return d;
}

// ---------- GitHub API ----------
const apiBase = () => `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;
const dataDir = () => gh.path.replace(/[^/]*$/, '');
const headers = () => ({ Accept: 'application/vnd.github+json', Authorization: `Bearer ${gh.token}`, 'X-GitHub-Api-Version': '2022-11-28' });

async function ghGet(path) {
    const res = await fetch(`${apiBase()}/contents/${path}?ref=${encodeURIComponent(gh.branch)}&t=${Date.now()}`, { headers: headers(), cache: 'no-store' });
    if (res.status === 404) return { missing: true };
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
    const j = await res.json();
    let text;
    if (j.content) text = b64decode(j.content);
    else { // files > 1MB come without inline content
        const raw = await fetch(j.git_url, { headers: { ...headers(), Accept: 'application/vnd.github.raw' }, cache: 'no-store' });
        text = await raw.text();
    }
    return { sha: j.sha, json: JSON.parse(text) };
}

async function ghPut(path, json, prevSha, message, keepalive = false) {
    const body = { message, content: b64encode(JSON.stringify(json, null, 2) + '\n'), branch: gh.branch };
    if (prevSha) body.sha = prevSha;
    const res = await fetch(`${apiBase()}/contents/${path}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body), keepalive });
    if (!res.ok) {
        const err = new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({}))).message || res.statusText}`);
        err.status = res.status;
        throw err;
    }
    return (await res.json()).content.sha;
}

// ---------- Load / save ----------
function writeCache() { lsSet(LS.cache, { data, dirty, changeLog }); }

async function load() {
    const cache = lsGet(LS.cache, null);
    let remote = null;
    setSaveStatus('Loading…');
    try {
        if (connected()) {
            const r = await ghGet(gh.path);
            if (!r.missing) { remote = r.json; sha = r.sha; } else sha = null;
        } else {
            const res = await fetch(`./data/planner.json?t=${Date.now()}`, { cache: 'no-store' });
            if (res.ok) remote = await res.json();
        }
    } catch (e) {
        console.warn(e);
        toast('Could not reach GitHub. Using the copy saved in this browser.');
    }

    if (cache?.dirty && cache.data) {
        data = normalize(mergeData(remote ? normalize(remote) : null, normalize(cache.data)));
        dirty = true; changeLog = cache.changeLog || ['offline edits'];
    } else {
        data = normalize(remote || cache?.data || emptyData());
    }

    await loadCanvas();
    pruneTombstones();
    writeCache();
    applyAccent();
    render();
    renderBanner();
    if (dirty) scheduleSave(1500);
    else setSaveStatus(connected() ? 'Synced' : 'Local only');
}

async function loadCanvas() {
    try {
        if (connected()) {
            const r = await ghGet(dataDir() + 'canvas.json');
            canvas = r.missing ? null : r.json;
        } else {
            const res = await fetch(`./data/canvas.json?t=${Date.now()}`, { cache: 'no-store' });
            canvas = res.ok ? await res.json() : null;
        }
    } catch { canvas = null; }
    if (canvas?.items?.length) applyCanvas(canvas.items);
}

function markDirty(reason) {
    data.updatedAt = nowIso();
    dirty = true;
    editGen++;
    if (reason) changeLog.push(reason);
    writeCache();
    scheduleSave();
    setSaveStatus(connected() ? 'Unsaved changes…' : 'Saved in this browser');
}

function scheduleSave(ms = AUTOSAVE_MS) {
    if (!connected()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, ms);
}

function commitMessage() {
    const uniq = [...new Set(changeLog)];
    const head = uniq.slice(0, 3).join('; ');
    return `planner: ${head || 'update'}${uniq.length > 3 ? ` (+${uniq.length - 3} more)` : ''}`;
}

async function save(opts = {}) {
    if (!connected() || !dirty) return;
    if (saving) { saveAgain = true; return; }
    saving = true;
    clearTimeout(saveTimer);
    setSaveStatus('Saving…');
    const msg = commitMessage();
    const loggedCount = changeLog.length;
    const gen = editGen;
    try {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                sha = await ghPut(gh.path, data, sha, msg, !!opts.keepalive);
                break;
            } catch (e) {
                if ((e.status === 409 || e.status === 422) && attempt < 2) {
                    // Someone else (another device) saved first: merge and retry.
                    const r = await ghGet(gh.path);
                    if (!r.missing) { data = normalize(mergeData(normalize(r.json), data)); sha = r.sha; }
                    else sha = null;
                    continue;
                }
                throw e;
            }
        }
        changeLog = changeLog.slice(loggedCount);
        dirty = gen !== editGen; // edits made while the request was in flight stay dirty
        lastSaved = new Date();
        writeCache();
        setSaveStatus(`Saved ${lastSaved.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
        render();
    } catch (e) {
        console.error(e);
        setSaveStatus('Save failed, will retry', true);
        if (e.status === 401 || e.status === 403) {
            toast('GitHub rejected the token. Check Settings.', 5000);
        } else scheduleSave(30000);
    } finally {
        saving = false;
        if (saveAgain || dirty) { saveAgain = false; if (dirty) scheduleSave(3000); }
    }
}

function setSaveStatus(text, bad = false) {
    const el = $('#saveStatus');
    el.textContent = text;
    el.style.color = bad ? '#f87171' : '';
}

function pruneTombstones() {
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const canvasUids = new Set((canvas?.items || []).map(i => i.uid));
    data.tasks = data.tasks.filter(t => !t.deleted || t.updatedAt > cutoff || (t.canvasUid && canvasUids.has(t.canvasUid)));
    data.classes = data.classes.filter(c => !c.deleted || c.updatedAt > cutoff);
}

// ---------- Canvas merge ----------
function guessType(title) {
    const t = title.toLowerCase();
    if (/\b(test|exam|midterm|final)\b/.test(t)) return 'test';
    if (/\bquiz/.test(t)) return 'quiz';
    if (/\bproject|essay|presentation|lab report\b/.test(t)) return 'project';
    if (/\bread(ing)?\b|chapter/.test(t)) return 'reading';
    return 'homework';
}

function classForCourse(course) {
    if (!course) return '';
    const key = course.trim().toLowerCase();
    let c = data.classes.find(x => !x.deleted && ((x.canvasCourse || '').toLowerCase() === key || x.name.toLowerCase() === key));
    if (!c) {
        const used = data.classes.filter(x => !x.deleted).length;
        c = { id: uid(), name: course.trim(), canvasCourse: course.trim(), color: CLASS_COLORS[used % CLASS_COLORS.length], updatedAt: nowIso() };
        data.classes.push(c);
    }
    return c.id;
}

function applyCanvas(items) {
    let added = 0, moved = 0;
    for (const it of items) {
        const t = data.tasks.find(x => x.canvasUid === it.uid);
        if (!t) {
            data.tasks.push({
                id: uid(), title: it.title, classId: classForCourse(it.course), type: it.type || guessType(it.title),
                due: it.due || '', dueTime: it.dueTime || '', status: 'todo', notes: it.description || '', link: it.url || '',
                subtasks: [], source: 'canvas', canvasUid: it.uid, canvasDue: it.due || '', canvasTitle: it.title,
                createdAt: nowIso(), updatedAt: nowIso(), statusAt: nowIso(),
            });
            added++;
        } else if (!t.deleted) {
            // Teacher moved the due date and Roman never changed it by hand: follow Canvas.
            if (it.due && it.due !== t.canvasDue) {
                if (!t.dueOverridden) { t.due = it.due; t.dueTime = it.dueTime || t.dueTime; moved++; }
                t.canvasDue = it.due; t.updatedAt = nowIso();
            }
            if (it.title !== t.canvasTitle) {
                if (t.title === t.canvasTitle) t.title = it.title;
                t.canvasTitle = it.title; t.updatedAt = nowIso();
            }
        }
    }
    if (added || moved) {
        markDirty(`canvas sync (${added} new, ${moved} moved)`);
        if (added) setTimeout(() => toast(`Canvas: ${added} new assignment${added > 1 ? 's' : ''} added to To Do`), 400);
    }
}

// ---------- Task operations ----------
function upsertTask(t, reason) {
    t.updatedAt = nowIso();
    const i = data.tasks.findIndex(x => x.id === t.id);
    if (i >= 0) data.tasks[i] = t; else data.tasks.push(t);
    markDirty(reason);
    render();
}

function setStatus(id, status) {
    const t = data.tasks.find(x => x.id === id);
    if (!t || t.status === status) return;
    t.status = status; t.statusAt = nowIso();
    upsertTask(t, `"${t.title}" → ${STATUSES.find(s => s.id === status).label}`);
}

function setDue(id, due) {
    const t = data.tasks.find(x => x.id === id);
    if (!t || t.due === due) return;
    t.due = due;
    if (t.source === 'canvas') t.dueOverridden = due !== t.canvasDue;
    upsertTask(t, `"${t.title}" due ${due}`);
}

// ---------- Filtering ----------
function visibleTasks({ forCalendar = false } = {}) {
    const q = ui.search.trim().toLowerCase();
    const cutoff = new Date(Date.now() - OLD_TURNED_IN_DAYS * 86400000).toISOString();
    return liveTasks().filter(t => {
        if (ui.type && t.type !== ui.type) return false;
        if (ui.hiddenClasses.includes(t.classId || '_none')) return false;
        if (q && !(`${t.title} ${t.notes} ${classById(t.classId)?.name || ''}`.toLowerCase().includes(q))) return false;
        if (!forCalendar && !ui.showOld && t.status === 'turned_in' && (t.statusAt || t.updatedAt) < cutoff) return false;
        return true;
    });
}

function sortTasks(list) {
    return list.sort((a, b) => (a.due || '9999') .localeCompare(b.due || '9999') || (a.dueTime || '99').localeCompare(b.dueTime || '99') || a.title.localeCompare(b.title));
}

// ---------- Rendering ----------
function dueLabel(t) {
    if (!t.due) return '';
    const diff = daysBetween(todayStr(), t.due);
    const time = t.dueTime ? ' ' + fmtTime(t.dueTime) : '';
    const done = DONE.has(t.status);
    if (diff < 0) return `<span class="${done ? '' : 'due-over'}">${done ? parseYmd(t.due).toLocaleDateString([], { month: 'short', day: 'numeric' }) : `Overdue ${-diff}d`}</span>`;
    if (diff === 0) return `<span class="due-today">Today${time}</span>`;
    if (diff === 1) return `<span class="due-soon">Tomorrow${time}</span>`;
    if (diff < 7) return `<span class="due-soon">${parseYmd(t.due).toLocaleDateString([], { weekday: 'short' })}${time}</span>`;
    return `<span>${parseYmd(t.due).toLocaleDateString([], { month: 'short', day: 'numeric' })}${time}</span>`;
}
function fmtTime(hm) {
    const [h, m] = hm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''}${h < 12 ? 'am' : 'pm'}`;
}

function taskCard(t) {
    const cls = classById(t.classId);
    const subs = t.subtasks || [];
    const doneSubs = subs.filter(s => s.done).length;
    return `<div class="task ${DONE.has(t.status) ? 'done' : ''}" draggable="true" data-id="${t.id}" style="--c:${classColor(t.classId)}">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta">
            <span class="badge ${t.type}">${esc(TYPES.find(x => x.id === t.type)?.label || t.type)}</span>
            ${cls ? `<span>${esc(cls.name)}</span>` : ''}
            ${t.due ? `<span>·</span>${dueLabel(t)}` : ''}
            ${t.source === 'canvas' ? '<span title="From Canvas">🎓</span>' : ''}
            ${t.notes ? '<span title="Has notes">📝</span>' : ''}
            ${subs.length ? `<span class="ml-auto">${doneSubs}/${subs.length}</span>` : ''}
        </div>
        ${subs.length ? `<div class="progress"><div style="width:${Math.round(doneSubs / subs.length * 100)}%"></div></div>` : ''}
    </div>`;
}

function renderStats() {
    const today = todayStr();
    const open = liveTasks().filter(t => !DONE.has(t.status));
    const overdue = open.filter(t => t.due && t.due < today).length;
    const dueToday = open.filter(t => t.due === today).length;
    const week = open.filter(t => t.due && t.due > today && daysBetween(today, t.due) <= 7).length;
    const tests = open.filter(t => (t.type === 'test' || t.type === 'quiz') && t.due && t.due >= today && daysBetween(today, t.due) <= 7).length;
    $('#stats').innerHTML = `
        <span class="stat ${overdue ? 'bad' : ''}"><b>${overdue}</b> overdue</span>
        <span class="stat ${dueToday ? 'warn' : ''}"><b>${dueToday}</b> due today</span>
        <span class="stat"><b>${week}</b> next 7 days</span>
        <span class="stat"><b>${tests}</b> tests/quizzes soon</span>`;
}

function renderFilters() {
    const used = new Set(liveTasks().map(t => t.classId || '_none'));
    const classes = data.classes.filter(c => !c.deleted);
    let html = classes.map(c => `<span class="chip ${ui.hiddenClasses.includes(c.id) ? 'off' : ''}" data-class="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>`).join('');
    if (used.has('_none')) html += `<span class="chip ${ui.hiddenClasses.includes('_none') ? 'off' : ''}" data-class="_none"><span class="dot" style="background:#64748b"></span>No class</span>`;
    $('#classFilters').innerHTML = html;
    $('#typeFilter').value = ui.type;
    $('#search').value = ui.search;
    $('#showOld').checked = ui.showOld;
    $$('#viewTabs button').forEach(b => b.classList.toggle('on', b.dataset.view === ui.view));
}

function renderBoard() {
    const tasks = visibleTasks();
    $('#view-board').innerHTML = `<div class="board">${STATUSES.map(s => {
        const list = sortTasks(tasks.filter(t => t.status === s.id));
        return `<div class="col" data-status="${s.id}">
            <div class="col-head"><span>${s.icon}</span>${s.label}<span class="count">${list.length}</span></div>
            ${list.map(taskCard).join('')}
            <button class="col-quick" data-new-status="${s.id}">+ Add</button>
        </div>`;
    }).join('')}</div>`;
}

function startOfWeek(d) { return addDays(d, -d.getDay()); }

function renderWeek() {
    const start = ui.weekStart ? parseYmd(ui.weekStart) : parseYmd(todayStr()); // rolling: today + next 6 days
    ui.weekStart = ymd(start);
    const tasks = visibleTasks({ forCalendar: true });
    const today = todayStr();
    const end = addDays(start, 6);
    const title = `${start.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString([], { month: start.getMonth() === end.getMonth() ? undefined : 'short', day: 'numeric' })}`;
    let days = '';
    for (let i = 0; i < 7; i++) {
        const d = addDays(start, i), ds = ymd(d);
        const list = sortTasks(tasks.filter(t => t.due === ds));
        days += `<div class="day ${ds === today ? 'today' : ''}" data-date="${ds}">
            <div class="day-label"><span>${d.toLocaleDateString([], { weekday: 'short' })}</span><span class="num">${d.getDate()}</span></div>
            ${list.map(taskCard).join('')}
            <button class="day-add" data-new-date="${ds}">+ Add</button>
        </div>`;
    }
    const undated = visibleTasks().filter(t => !t.due && !DONE.has(t.status));
    $('#view-week').innerHTML = `
        <div class="cal-head">
            <button class="btn-ghost" data-nav="-7">‹</button>
            <button class="btn-ghost" data-nav="today">Today</button>
            <button class="btn-ghost" data-nav="7">›</button>
            <h2>${title}</h2>
        </div>
        <div class="week">${days}</div>
        ${undated.length ? `<div class="mt-4 card"><div class="field mb-2">No due date (drag onto a day)</div><div class="flex flex-wrap gap-2">${undated.map(t => `<div style="width:240px">${taskCard(t)}</div>`).join('')}</div></div>` : ''}`;
}

function renderMonth() {
    const m = ui.month ? parseYmd(ui.month + '-01') : new Date(new Date().getFullYear(), new Date().getMonth(), 1, 12);
    ui.month = `${m.getFullYear()}-${pad(m.getMonth() + 1)}`;
    const first = new Date(m.getFullYear(), m.getMonth(), 1, 12);
    const gridStart = startOfWeek(first);
    const tasks = visibleTasks({ forCalendar: true });
    const today = todayStr();
    let cells = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<div class="dow">${d}</div>`).join('');
    for (let i = 0; i < 42; i++) {
        const d = addDays(gridStart, i), ds = ymd(d);
        if (i === 35 && d.getMonth() !== m.getMonth()) break;
        const list = sortTasks(tasks.filter(t => t.due === ds));
        const shown = list.slice(0, 4);
        cells += `<div class="mcell ${d.getMonth() !== m.getMonth() ? 'other' : ''} ${ds === today ? 'today' : ''}" data-date="${ds}">
            <span class="n">${d.getDate()}</span>
            ${shown.map(t => `<div class="pill ${DONE.has(t.status) ? 'done' : ''}" draggable="true" data-id="${t.id}" style="--c:${classColor(t.classId)}" title="${esc(t.title)}">${esc(t.title)}</div>`).join('')}
            ${list.length > shown.length ? `<div class="more" data-goto-week="${ds}">+${list.length - shown.length} more</div>` : ''}
        </div>`;
    }
    $('#view-month').innerHTML = `
        <div class="cal-head">
            <button class="btn-ghost" data-mnav="-1">‹</button>
            <button class="btn-ghost" data-mnav="0">Today</button>
            <button class="btn-ghost" data-mnav="1">›</button>
            <h2>${m.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2>
        </div>
        <div class="month">${cells}</div>`;
}

function renderBanner() {
    const b = $('#banner');
    if (connected()) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    b.innerHTML = `<div class="banner">🔌 <span>Not connected to GitHub yet, so changes only live in this browser.</span>
        <button class="btn-accent ml-auto" id="bannerConnect">Connect</button></div>`;
    $('#bannerConnect').onclick = openSettings;
}

function render() {
    renderStats();
    renderFilters();
    $$('.view').forEach(v => v.classList.add('hidden'));
    $(`#view-${ui.view}`).classList.remove('hidden');
    if (ui.view === 'board') renderBoard();
    if (ui.view === 'week') renderWeek();
    if (ui.view === 'month') renderMonth();
}

function applyAccent() {
    const a = data.settings.accent || ACCENTS[0];
    document.documentElement.style.setProperty('--accent', a);
    document.documentElement.style.setProperty('--accent-soft', a + '33');
}

// ---------- Task modal ----------
let draft = null;

function openTask(id, preset = {}) {
    const existing = id && data.tasks.find(t => t.id === id);
    draft = existing ? structuredClone(existing) : {
        id: uid(), title: '', classId: ui.lastClass || '', type: 'homework', due: '', dueTime: '', status: 'todo',
        notes: '', link: '', subtasks: [], source: 'manual', createdAt: nowIso(), ...preset,
    };
    const f = $('#taskForm');
    fillClassSelect(f.classId, draft.classId);
    f.type.innerHTML = TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    f.title.value = draft.title;
    f.type.value = draft.type;
    f.due.value = draft.due;
    f.dueTime.value = draft.dueTime;
    f.link.value = draft.link;
    f.notes.value = draft.notes;
    $('#taskDelete').classList.toggle('hidden', !existing);
    $('#taskMeta').textContent = existing
        ? `${draft.source === 'canvas' ? 'From Canvas · ' : ''}Created ${new Date(draft.createdAt).toLocaleDateString()}${draft.dueOverridden ? ' · due date changed from Canvas' : ''}`
        : '';
    renderStatusSeg();
    renderSubtasks();
    $('#taskModal').showModal();
    if (!existing) f.title.focus();
}

function fillClassSelect(sel, value) {
    const classes = data.classes.filter(c => !c.deleted).sort((a, b) => a.name.localeCompare(b.name));
    sel.innerHTML = `<option value="">No class</option>` + classes.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('') + `<option value="__new">+ New class…</option>`;
    sel.value = value || '';
}

function renderStatusSeg() {
    $('#statusSeg').innerHTML = STATUSES.map(s => `<button type="button" data-status="${s.id}" class="${draft.status === s.id ? 'on' : ''}">${s.label}</button>`).join('');
}

function renderSubtasks() {
    const subs = draft.subtasks;
    $('#subtaskList').innerHTML = subs.map(s => `<li class="sub ${s.done ? 'done' : ''}" data-sid="${s.id}">
        <input type="checkbox" ${s.done ? 'checked' : ''}><span>${esc(s.text)}</span><button type="button" title="Remove">✕</button></li>`).join('');
    const d = subs.filter(s => s.done).length;
    $('#subProgress').textContent = subs.length ? `${d} of ${subs.length} done` : '';
}

function addSubtask() {
    const inp = $('#subtaskInput');
    const text = inp.value.trim();
    if (!text) return;
    draft.subtasks.push({ id: uid(), text, done: false });
    inp.value = '';
    renderSubtasks();
}

function saveDraft() {
    const f = $('#taskForm');
    const isNew = !data.tasks.some(t => t.id === draft.id);
    const prev = data.tasks.find(t => t.id === draft.id);
    draft.title = f.title.value.trim() || 'Untitled';
    draft.classId = f.classId.value === '__new' ? '' : f.classId.value;
    draft.type = f.type.value;
    draft.due = f.due.value;
    draft.dueTime = f.dueTime.value;
    draft.link = f.link.value.trim();
    draft.notes = f.notes.value;
    if (prev && prev.status !== draft.status) draft.statusAt = nowIso();
    if (isNew) draft.statusAt = nowIso();
    if (draft.source === 'canvas' && prev && prev.due !== draft.due) draft.dueOverridden = draft.due !== draft.canvasDue;
    ui.lastClass = draft.classId; saveUi();
    upsertTask(draft, `${isNew ? 'add' : 'edit'} "${draft.title}"`);
    $('#taskModal').close();
}

// ---------- Settings ----------
function openSettings() {
    $('#ghOwner').value = gh.owner;
    $('#ghRepo').value = gh.repo;
    $('#ghBranch').value = gh.branch;
    $('#ghPath').value = gh.path;
    $('#ghToken').value = gh.token;
    $('#ghResult').textContent = connected() ? 'Connected' : '';
    $('#icsUrl').value = new URL('./calendar.ics', location.href).href.replace(/\?.*$/, '');
    const ci = canvas;
    $('#canvasInfo').innerHTML = ci?.fetchedAt
        ? `Last Canvas sync: <b>${new Date(ci.fetchedAt).toLocaleString()}</b> · ${ci.items?.length || 0} assignments in feed${ci.error ? ` · <span style="color:#f87171">${esc(ci.error)}</span>` : ''}`
        : 'Canvas is not hooked up yet. Add the <code>CANVAS_ICS_URL</code> repo secret (see planner/README.md).';
    renderAccentPicker();
    renderClassList();
    $('#settingsModal').showModal();
}

function renderAccentPicker() {
    $('#accentPicker').innerHTML = ACCENTS.map(a => `<div class="swatch ${a === data.settings.accent ? 'on' : ''}" data-accent="${a}" style="background:${a}"></div>`).join('')
        + `<input type="color" id="accentCustom" value="${data.settings.accent}" class="swatch" title="Custom">`;
}

function renderClassList() {
    const classes = data.classes.filter(c => !c.deleted);
    $('#classList').innerHTML = classes.length ? classes.map(c => {
        const n = liveTasks().filter(t => t.classId === c.id).length;
        return `<div class="flex items-center gap-2" data-cid="${c.id}">
            <input type="color" value="${c.color}" class="swatch" data-ccolor>
            <input value="${esc(c.name)}" class="input flex-1" data-cname>
            <span class="text-xs text-slate-500 w-16 text-right">${n} task${n === 1 ? '' : 's'}</span>
            <button class="btn-ghost text-xs" data-cdel>Remove</button>
        </div>`;
    }).join('') : '<div class="text-xs text-slate-500">No classes yet. Add one, or they appear automatically from Canvas.</div>';
}

function addClass(name) {
    const used = data.classes.filter(x => !x.deleted).length;
    const c = { id: uid(), name, color: CLASS_COLORS[used % CLASS_COLORS.length], updatedAt: nowIso() };
    data.classes.push(c);
    markDirty(`add class ${name}`);
    return c;
}

// ---------- Drag & drop ----------
function wireDnD() {
    document.addEventListener('dragstart', e => {
        const el = e.target.closest?.('[data-id][draggable]');
        if (!el) return;
        e.dataTransfer.setData('text/plain', el.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
    });
    document.addEventListener('dragend', e => {
        e.target.closest?.('[data-id]')?.classList.remove('dragging');
        $$('.drop').forEach(x => x.classList.remove('drop'));
    });
    document.addEventListener('dragover', e => {
        const zone = e.target.closest?.('.col, .day, .mcell');
        if (!zone) return;
        e.preventDefault();
        $$('.drop').forEach(x => x !== zone && x.classList.remove('drop'));
        zone.classList.add('drop');
    });
    document.addEventListener('drop', e => {
        const zone = e.target.closest?.('.col, .day, .mcell');
        if (!zone) return;
        e.preventDefault();
        const id = e.dataTransfer.getData('text/plain');
        zone.classList.remove('drop');
        if (zone.dataset.status) setStatus(id, zone.dataset.status);
        else if (zone.dataset.date) setDue(id, zone.dataset.date);
    });
}

// ---------- Events ----------
function wire() {
    // header
    $('#btnNew').onclick = () => openTask(null);
    $('#btnSettings').onclick = openSettings;
    $('#viewTabs').onclick = e => { const v = e.target.dataset.view; if (v) { ui.view = v; saveUi(); render(); } };
    $('#search').oninput = e => { ui.search = e.target.value; render(); };
    $('#typeFilter').innerHTML = `<option value="">All types</option>` + TYPES.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    $('#typeFilter').onchange = e => { ui.type = e.target.value; saveUi(); render(); };
    $('#showOld').onchange = e => { ui.showOld = e.target.checked; saveUi(); render(); };
    $('#classFilters').onclick = e => {
        const chip = e.target.closest('[data-class]'); if (!chip) return;
        const id = chip.dataset.class;
        ui.hiddenClasses = ui.hiddenClasses.includes(id) ? ui.hiddenClasses.filter(x => x !== id) : [...ui.hiddenClasses, id];
        saveUi(); render();
    };

    // main area clicks
    $('main').addEventListener('click', e => {
        const nav = e.target.closest('[data-nav]');
        if (nav) {
            const v = nav.dataset.nav;
            ui.weekStart = v === 'today' ? null : ymd(addDays(parseYmd(ui.weekStart), +v));
            return render();
        }
        const mnav = e.target.closest('[data-mnav]');
        if (mnav) {
            const v = +mnav.dataset.mnav;
            if (v === 0) ui.month = null;
            else { const [y, m] = ui.month.split('-').map(Number); const d = new Date(y, m - 1 + v, 1); ui.month = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
            return render();
        }
        const more = e.target.closest('[data-goto-week]');
        if (more) { ui.view = 'week'; ui.weekStart = ymd(startOfWeek(parseYmd(more.dataset.gotoWeek))); return render(); }
        const card = e.target.closest('[data-id]');
        if (card) return openTask(card.dataset.id);
        const ns = e.target.closest('[data-new-status]');
        if (ns) return openTask(null, { status: ns.dataset.newStatus });
        const nd = e.target.closest('[data-new-date]');
        if (nd) return openTask(null, { due: nd.dataset.newDate });
        const cell = e.target.closest('.mcell');
        if (cell) return openTask(null, { due: cell.dataset.date });
    });

    // task modal
    $('#taskForm').addEventListener('submit', e => { e.preventDefault(); saveDraft(); });
    $$('#taskModal [data-close]').forEach(b => b.onclick = () => $('#taskModal').close());
    $('#statusSeg').onclick = e => { const s = e.target.dataset.status; if (s) { draft.status = s; renderStatusSeg(); } };
    $('#subtaskAdd').onclick = addSubtask;
    $('#subtaskInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSubtask(); } });
    $('#subtaskList').onclick = e => {
        const li = e.target.closest('[data-sid]'); if (!li) return;
        const s = draft.subtasks.find(x => x.id === li.dataset.sid);
        if (e.target.tagName === 'BUTTON') draft.subtasks = draft.subtasks.filter(x => x !== s);
        else if (e.target.type === 'checkbox') s.done = e.target.checked;
        else return;
        renderSubtasks();
    };
    $('#taskForm').classId.onchange = e => {
        if (e.target.value !== '__new') return;
        const name = prompt('New class name (e.g. Algebra 1)');
        if (name?.trim()) { const c = addClass(name.trim()); fillClassSelect(e.target, c.id); }
        else e.target.value = draft.classId || '';
    };
    $('#taskDelete').onclick = () => {
        if (!confirm(`Delete "${draft.title}"?`)) return;
        const t = data.tasks.find(x => x.id === draft.id);
        if (t) { t.deleted = true; upsertTask(t, `delete "${t.title}"`); }
        $('#taskModal').close();
    };

    // settings
    $$('#settingsModal [data-close]').forEach(b => b.onclick = () => $('#settingsModal').close());
    $('#settingsModal').addEventListener('close', () => render());
    $('#accentPicker').addEventListener('click', e => {
        const a = e.target.dataset.accent; if (!a) return;
        data.settings.accent = a; data.settings.settingsAt = nowIso();
        applyAccent(); renderAccentPicker(); markDirty('change accent');
    });
    $('#accentPicker').addEventListener('change', e => {
        if (e.target.id !== 'accentCustom') return;
        data.settings.accent = e.target.value; data.settings.settingsAt = nowIso();
        applyAccent(); renderAccentPicker(); markDirty('change accent');
    });
    $('#classAdd').onclick = () => { const n = prompt('Class name'); if (n?.trim()) { addClass(n.trim()); renderClassList(); } };
    $('#classList').addEventListener('change', e => {
        const row = e.target.closest('[data-cid]'); if (!row) return;
        const c = data.classes.find(x => x.id === row.dataset.cid);
        if (e.target.matches('[data-ccolor]')) c.color = e.target.value;
        if (e.target.matches('[data-cname]')) c.name = e.target.value.trim() || c.name;
        c.updatedAt = nowIso();
        markDirty(`edit class ${c.name}`);
    });
    $('#classList').addEventListener('click', e => {
        if (!e.target.matches('[data-cdel]')) return;
        const c = data.classes.find(x => x.id === e.target.closest('[data-cid]').dataset.cid);
        if (!confirm(`Remove class "${c.name}"? Its tasks stay, just without a class.`)) return;
        c.deleted = true; c.updatedAt = nowIso();
        liveTasks().filter(t => t.classId === c.id).forEach(t => { t.classId = ''; t.updatedAt = nowIso(); });
        markDirty(`remove class ${c.name}`);
        renderClassList();
    });

    $('#ghConnect').onclick = async () => {
        gh = {
            owner: $('#ghOwner').value.trim() || DEFAULT_GH.owner,
            repo: $('#ghRepo').value.trim() || DEFAULT_GH.repo,
            branch: $('#ghBranch').value.trim() || DEFAULT_GH.branch,
            path: $('#ghPath').value.trim() || DEFAULT_GH.path,
            token: $('#ghToken').value.trim(),
        };
        $('#ghResult').textContent = 'Checking…';
        try {
            const res = await fetch(apiBase(), { headers: headers() });
            if (!res.ok) throw new Error(`GitHub said ${res.status}. Check the token and repo name.`);
            const repo = await res.json();
            if (repo.permissions && !repo.permissions.push) throw new Error('Token can read but not write. Give it Contents: Read and write.');
            lsSet(LS.gh, gh);
            $('#ghResult').textContent = 'Connected. Loading…';
            await load();
            if (dirty) await save();
            $('#ghResult').textContent = 'Connected ✓';
        } catch (e) {
            $('#ghResult').innerHTML = `<span style="color:#f87171">${esc(e.message)}</span>`;
        }
    };
    $('#ghForget').onclick = () => { gh.token = ''; lsSet(LS.gh, gh); $('#ghToken').value = ''; $('#ghResult').textContent = 'Token removed from this browser.'; renderBanner(); };

    $('#canvasSync').onclick = async () => {
        if (!connected()) return toast('Connect GitHub first.');
        const res = await fetch(`${apiBase()}/actions/workflows/planner-sync.yml/dispatches`, { method: 'POST', headers: headers(), body: JSON.stringify({ ref: gh.branch }) });
        if (res.status === 204) {
            toast('Canvas sync started. New items show up in about 1 to 2 minutes.', 4000);
            setTimeout(async () => { await loadCanvas(); render(); }, 90000);
        } else {
            const why = res.status === 403 ? 'Token needs Actions: Read and write.'
                : res.status === 404 ? 'Workflow not found. Is .github/workflows/planner-sync.yml pushed?'
                : res.status === 422 ? 'Workflow file is missing its manual trigger or is invalid.'
                : 'Check the Actions tab on GitHub.';
            toast(`Could not start sync (${res.status}). ${why}`, 6000);
        }
    };
    $('#icsCopy').onclick = async () => { try { await navigator.clipboard.writeText($('#icsUrl').value); toast('Calendar link copied'); } catch { $('#icsUrl').select(); } };

    $('#exportBtn').onclick = () => {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `planner-backup-${todayStr()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    };
    $('#importFile').onchange = async e => {
        const file = e.target.files[0]; if (!file) return;
        try {
            const incoming = normalize(JSON.parse(await file.text()));
            if (!confirm(`Merge ${incoming.tasks.length} tasks from this backup into the planner?`)) return;
            data = normalize(mergeData(data, incoming));
            markDirty('import backup'); applyAccent(); render(); toast('Backup merged');
        } catch { toast('That file did not look like a planner backup.'); }
        e.target.value = '';
    };

    // keyboard: n = new task
    document.addEventListener('keydown', e => {
        if (e.key === 'n' && !e.target.closest('input, textarea, select, dialog')) { e.preventDefault(); openTask(null); }
    });

    // save before leaving
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && dirty) save({ keepalive: true }); });
    window.addEventListener('beforeunload', e => { if (dirty && connected()) { save({ keepalive: true }); e.preventDefault(); } });

    // re-check for other devices' edits when coming back to the tab
    window.addEventListener('focus', () => {
        if (connected() && !dirty && !saving && Date.now() - (wire._lastPull || 0) > 60000) { wire._lastPull = Date.now(); load(); }
    });
}

wire();
wireDnD();
load();
})();
