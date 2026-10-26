// Planner sync, run by .github/workflows/planner-sync.yml (Node 20, no dependencies).
//  1. If CANVAS_ICS_URL is set, pull the Canvas calendar feed and write planner/data/canvas.json
//  2. Build planner/calendar.ics from planner.json so Google/Apple Calendar can subscribe to it
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const TZ = process.env.PLANNER_TZ || 'America/New_York';
mkdirSync(DATA, { recursive: true });

const readJson = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
const writeIfChanged = (p, text) => {
    if (existsSync(p) && readFileSync(p, 'utf8') === text) return false;
    writeFileSync(p, text); return true;
};

// ---------- ICS parsing ----------
function parseIcs(text) {
    const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
    const events = []; let cur = null;
    for (const line of lines) {
        if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
        if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
        if (!cur) continue;
        const i = line.indexOf(':'); if (i < 0) continue;
        const [name, ...params] = line.slice(0, i).split(';');
        cur[name] = { value: unescapeIcs(line.slice(i + 1)), params };
    }
    return events;
}
const unescapeIcs = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

function localParts(date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
        .formatToParts(date).map(x => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function icsDate(prop) {
    if (!prop) return { due: '', dueTime: '' };
    const v = prop.value;
    if (/^\d{8}$/.test(v)) return { due: `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, dueTime: '' };
    const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
    if (!m) return { due: '', dueTime: '' };
    if (m[7] === 'Z') {
        const { day, time } = localParts(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
        // Canvas uses 11:59pm for "end of day"; keep it but hide the noise of 23:59
        return { due: day, dueTime: time === '23:59' ? '' : time };
    }
    return { due: `${m[1]}-${m[2]}-${m[3]}`, dueTime: `${m[4]}:${m[5]}` };
}

function guessType(title) {
    const t = title.toLowerCase();
    if (/summative/.test(t)) return 'summative';
    if (/formative/.test(t)) return 'formative';
    if (/participation/.test(t)) return 'participation';
    if (/classwork|\bcw\s*#?\d/.test(t)) return 'classwork';
    if (/\b(test|exam|midterm|final)\b/.test(t)) return 'test';
    if (/\bquiz/.test(t)) return 'quiz';
    if (/\bproject|essay|presentation|lab report\b/.test(t)) return 'project';
    if (/\bread(ing)?\b|chapter/.test(t)) return 'reading';
    return 'homework';
}

async function syncCanvas() {
    const url = process.env.CANVAS_ICS_URL;
    const out = join(DATA, 'canvas.json');
    if (!url) { console.log('CANVAS_ICS_URL not set, skipping Canvas.'); return; }
    const prev = readJson(out, { items: [] });
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Canvas feed returned ${res.status}`);
        const events = parseIcs(await res.text());
        const items = events
            .filter(e => /assignment/i.test(e.UID?.value || '') || /assignment/i.test(e.URL?.value || ''))
            .map(e => {
                const raw = e.SUMMARY?.value || 'Untitled';
                const m = raw.match(/^(.*)\s\[([^\]]+)\]\s*$/); // "Title [Course Name]"
                const title = (m ? m[1] : raw).trim();
                const { due, dueTime } = icsDate(e.DTSTART);
                return {
                    uid: e.UID.value, title, course: m ? m[2].trim() : '', due, dueTime,
                    type: guessType(title), url: e.URL?.value || '',
                    description: (e.DESCRIPTION?.value || '').slice(0, 1000),
                };
            })
            .sort((a, b) => (a.due || '').localeCompare(b.due || '') || a.uid.localeCompare(b.uid));
        const sameItems = JSON.stringify(items) === JSON.stringify(prev.items);
        // Only bump fetchedAt when something changed (or every ~day) to avoid a commit per run.
        const stale = !prev.fetchedAt || Date.now() - Date.parse(prev.fetchedAt) > 20 * 3600e3;
        if (sameItems && stale === false && !prev.error) { console.log('Canvas: no changes.'); return; }
        writeIfChanged(out, JSON.stringify({ fetchedAt: new Date().toISOString(), items }, null, 2) + '\n');
        console.log(`Canvas: ${items.length} assignments.`);
    } catch (e) {
        console.error('Canvas sync failed:', e.message);
        writeIfChanged(out, JSON.stringify({ ...prev, error: e.message }, null, 2) + '\n');
    }
}

// ---------- ICS output ----------
const icsEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
const fold = (line) => { const out = []; while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); } out.push(line); return out.join('\r\n'); };
const LABEL = { homework: 'HW', quiz: 'Quiz', test: 'TEST', project: 'Project', reading: 'Reading', formative: 'Formative', summative: 'SUMMATIVE', classwork: 'Classwork', participation: 'Participation', other: 'Task' };
const STATUS = { todo: '', doing: '◐ ', review: '◎ ', complete: '● ', turned_in: '✓ ' };

function buildCalendar() {
    const data = readJson(join(DATA, 'planner.json'), { tasks: [], classes: [] });
    const classes = Object.fromEntries((data.classes || []).filter(c => !c.deleted).map(c => [c.id, c.name]));
    const stamp = (data.updatedAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+/, '');
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//roman.talaiver.com//Planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
        "X-WR-CALNAME:Roman's Planner", `X-WR-TIMEZONE:${TZ}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
    for (const t of (data.tasks || []).filter(t => !t.deleted && t.due)) {
        const d = t.due.replace(/-/g, '');
        const next = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1)).toISOString().slice(0, 10).replace(/-/g, '');
        const cls = classes[t.classId];
        const subs = t.subtasks || [];
        const desc = [
            `Status: ${t.status}`, typeof t.progress === 'number' && !['complete', 'turned_in'].includes(t.status) ? `${t.progress}% done` : '', t.dueTime ? `Due at ${t.dueTime}` : '', cls ? `Class: ${cls}` : '',
            subs.length ? `Steps: ${subs.filter(s => s.done).length}/${subs.length} done` : '', t.notes || '', t.link || '',
        ].filter(Boolean).join('\n');
        lines.push('BEGIN:VEVENT', `UID:${t.id}@roman.talaiver.com`, `DTSTAMP:${stamp}`,
            `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, 'TRANSP:TRANSPARENT',
            fold(`SUMMARY:${icsEscape(`${STATUS[t.status] || ''}${LABEL[t.type] || 'Task'}: ${t.title}${cls ? ` (${cls})` : ''}`)}`),
            fold(`DESCRIPTION:${icsEscape(desc)}`));
        if (t.link) lines.push(fold(`URL:${t.link}`));
        lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    const changed = writeIfChanged(join(ROOT, 'calendar.ics'), lines.join('\r\n') + '\r\n');
    console.log(`calendar.ics ${changed ? 'updated' : 'unchanged'}.`);
}

// ---------- App version ----------
// Semantic version built from the commits that changed the app itself (task saves, Canvas syncs,
// the calendar feed, README and Hermes notes don't count). Commit message prefix decides the bump:
//   "major: ..." or "feat!: ..."  -> major  (x.0.0)
//   "feat: ..."                   -> minor  (0.x.0, patch resets)
//   anything else ("fix: ...")    -> patch  (0.0.x)
const APP_PATHS = ['planner/index.html', 'planner/app.js', 'planner/planner.css', 'planner/manifest.webmanifest', 'planner/icons', 'planner/scripts'];
// Features committed before the prefix convention existed.
const LEGACY_FEATURES = ['90687df', 'c221aac', '3592193', 'ee4db1b', '76e6169'];
const bumpFor = (sha, subject) =>
    /^(major|feat!)(\(.*\))?:/i.test(subject) || /BREAKING CHANGE/.test(subject) ? 'major'
    : /^feat(\(.*\))?:/i.test(subject) || LEGACY_FEATURES.some(x => sha.startsWith(x)) ? 'minor'
    : 'patch';
function writeVersion() {
    try {
        const repo = join(ROOT, '..');
        const out = execSync(`git log --reverse --no-merges --format=%H%x09%cI%x09%s -- ${APP_PATHS.join(' ')}`, { cwd: repo, encoding: 'utf8' }).trim();
        if (!out) return;
        let [maj, min, pat] = [0, 0, 0], last, lastBump;
        for (const line of out.split('\n')) {
            const [sha, iso, ...rest] = line.split('\t');
            const subject = rest.join('\t');
            const bump = bumpFor(sha, subject);
            if (bump === 'major') [maj, min, pat] = [maj + 1, 0, 0];
            else if (bump === 'minor') [min, pat] = [min + 1, 0];
            else pat++;
            last = { sha: sha.slice(0, 7), iso, subject }; lastBump = bump;
        }
        const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(last.iso));
        const info = { version: `${maj}.${min}.${pat}`, bump: lastBump, date: day, committedAt: last.iso, sha: last.sha, message: last.subject };
        const changed = writeIfChanged(join(ROOT, 'version.json'), JSON.stringify(info, null, 2) + '\n');
        console.log(`version v${info.version} (${lastBump}, ${day}) ${changed ? 'updated' : 'unchanged'}.`);
    } catch (e) { console.error('Version stamp skipped:', e.message); }
}

await syncCanvas();
buildCalendar();
writeVersion();
