// Shift Management Day / Week / Month view tests. No database, no network, no browser, nothing production:
//   - client/src/utils/shiftViews.js is imported and run for real (also in several time zones, each in its
//     own child process because TZ is fixed at process start);
//   - AdminShiftManagement.jsx / .css are read statically to pin the wiring, the compact override panel and
//     the unchanged permission/API surface.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const HELPER_PATH = path.join(ROOT, 'client/src/utils/shiftViews.js');
const page = read('client/src/pages/Admin/AdminShiftManagement.jsx');
const css = read('client/src/pages/Admin/AdminShiftManagement.css');
const helperSource = read('client/src/utils/shiftViews.js');

let helperPromise;
const helper = () => (helperPromise ||= import(pathToFileURL(HELPER_PATH).href));
const d = (iso) => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); };

test('Day view: exactly the selected day (today by default)', async () => {
    const { getViewRange, toIsoDate } = await helper();
    const today = new Date();
    const r = getViewRange('day', today);
    assert.deepEqual(r.dates, [toIsoDate(today)]);
    assert.equal(r.start, r.end);
});

test('Week view: Monday..Sunday containing the anchor, for every weekday, incl. a Sunday', async () => {
    const { getViewRange } = await helper();
    // 2026-10-19 is a Monday .. 2026-10-25 Sunday
    for (let day = 19; day <= 25; day++) {
        const r = getViewRange('week', d(`2026-10-${day}`));
        assert.equal(r.start, '2026-10-19', `anchor ${day}`);
        assert.equal(r.end, '2026-10-25', `anchor ${day}`);
        assert.equal(r.dates.length, 7);
    }
});

test('Week view crossing a year boundary stays contiguous (Mon 2025-12-29 .. Sun 2026-01-04)', async () => {
    const { getViewRange } = await helper();
    const r = getViewRange('week', d('2026-01-01'));
    assert.deepEqual(r.dates, ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
});

test('Month view: the whole calendar month, including leap-year and 28/30/31-day months', async () => {
    const { getViewRange } = await helper();
    const cases = [
        ['2024-02-10', '2024-02-01', '2024-02-29', 29],
        ['2025-02-10', '2025-02-01', '2025-02-28', 28],
        ['2026-04-30', '2026-04-01', '2026-04-30', 30],
        ['2026-10-23', '2026-10-01', '2026-10-31', 31],
        ['2026-12-31', '2026-12-01', '2026-12-31', 31],
        ['2026-01-01', '2026-01-01', '2026-01-31', 31],
    ];
    for (const [anchor, start, end, n] of cases) {
        const r = getViewRange('month', d(anchor));
        assert.equal(r.start, start, anchor);
        assert.equal(r.end, end, anchor);
        assert.equal(r.dates.length, n, anchor);
        assert.equal(new Set(r.dates).size, n, `${anchor}: no duplicate dates (DST-safe)`);
    }
});

test('navigation: day, week and month go back/forward, across month and year boundaries', async () => {
    const { shiftAnchor, getViewRange, toIsoDate } = await helper();
    const start = (view, a, dir) => getViewRange(view, shiftAnchor(view, d(a), dir)).start;

    assert.equal(toIsoDate(shiftAnchor('day', d('2026-10-31'), 1)), '2026-11-01');
    assert.equal(toIsoDate(shiftAnchor('day', d('2026-01-01'), -1)), '2025-12-31');
    assert.equal(toIsoDate(shiftAnchor('day', d('2028-02-28'), 1)), '2028-02-29');

    assert.equal(start('week', '2026-10-23', -1), '2026-10-12');
    assert.equal(start('week', '2026-10-23', 1), '2026-10-26');
    assert.equal(start('week', '2025-12-31', 1), '2026-01-05');

    assert.equal(start('month', '2026-12-15', 1), '2027-01-01');
    assert.equal(start('month', '2026-01-15', -1), '2025-12-01');
    // day-of-month overflow must not skip a month
    assert.equal(start('month', '2026-01-31', 1), '2026-02-01');
    assert.equal(start('month', '2026-03-31', -1), '2026-02-01');
    assert.equal(start('month', '2024-03-31', -1), '2024-02-01');
    // 12 steps forward == same month next year
    const { addMonths } = await helper();
    let a = d('2026-01-31');
    for (let i = 0; i < 12; i++) a = addMonths(a, 1);
    assert.equal(toIsoDate(a), '2027-01-01');
});

test('switching view keeps your place: Week/Month keep the anchor; Day lands on today only if today is in view', async () => {
    const { anchorForView, getViewRange, toIsoDate } = await helper();
    const today = d('2026-10-23');

    const thisWeek = getViewRange('week', d('2026-10-20'));
    assert.equal(toIsoDate(anchorForView('day', d('2026-10-20'), thisWeek, today)), '2026-10-23');

    const otherWeek = getViewRange('week', d('2026-09-01'));
    assert.equal(toIsoDate(anchorForView('day', d('2026-09-01'), otherWeek, today)), otherWeek.start);

    const otherMonth = getViewRange('month', d('2026-03-15'));
    assert.equal(toIsoDate(anchorForView('day', d('2026-03-15'), otherMonth, today)), '2026-03-01');

    const keep = d('2026-09-09');
    assert.equal(anchorForView('week', keep, otherWeek, today), keep);
    assert.equal(anchorForView('month', keep, otherWeek, today), keep);
});

test('labels: month name, full day, week range (with year only when it straddles a year)', async () => {
    const { formatRangeLabel, weekdayLabel, NAV_LABELS } = await helper();
    assert.match(formatRangeLabel('month', d('2026-10-23')), /October 2026/);
    assert.match(formatRangeLabel('day', d('2026-10-23')), /Friday/);
    assert.match(formatRangeLabel('week', d('2026-10-23')), /19 Oct.*25 Oct/);
    assert.match(formatRangeLabel('week', d('2026-01-01')), /29 Dec 2025.*4 Jan 2026/);
    assert.equal(weekdayLabel(d('2026-10-19')), 'Mon');
    assert.equal(weekdayLabel(d('2026-10-25')), 'Sun');
    assert.deepEqual(Object.keys(NAV_LABELS).sort(), ['day', 'month', 'week']);
    assert.equal(NAV_LABELS.week.prev, 'Previous Week');
    assert.equal(NAV_LABELS.week.next, 'Next Week');
    assert.equal(NAV_LABELS.month.prev, 'Previous Month');
    assert.equal(NAV_LABELS.month.next, 'Next Month');
});

test('timezone safety: identical local dates in UTC, IST, Auckland and Los Angeles (each in its own process)', () => {
    const script = `
        import(${JSON.stringify(pathToFileURL(HELPER_PATH).href)}).then((h) => {
            const p = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
            const out = {
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                // local midnight must serialise to the SAME calendar date (toISOString would shift it east of UTC)
                roundTrip: ['2026-10-19', '2026-03-29', '2026-11-01', '2026-01-01'].map((s) => h.toIsoDate(p(s)) === s),
                week: h.getViewRange('week', p('2026-10-23')).dates,
                month: h.getViewRange('month', p('2026-10-23')).dates.length,
                // DST months (Auckland changes in Sep/Apr, LA in Mar/Nov) must still have one entry per day
                dst: ['2026-03', '2026-04', '2026-09', '2026-11'].map((ym) => { const r = h.getViewRange('month', p(ym + '-15')); return r.dates.length + ':' + new Set(r.dates).size; }),
            };
            console.log(JSON.stringify(out));
        });`;
    // ICU may report a canonical alias (Asia/Calcutta for Asia/Kolkata)
    const names = { UTC: ['UTC', 'Etc/UTC'], 'Asia/Kolkata': ['Asia/Kolkata', 'Asia/Calcutta'], 'Pacific/Auckland': ['Pacific/Auckland'], 'America/Los_Angeles': ['America/Los_Angeles'] };
    for (const tz of Object.keys(names)) {
        const stdout = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
        const out = JSON.parse(stdout.trim().split('\n').pop());
        assert.ok(names[tz].includes(out.tz), `child really ran in ${tz} (reported ${out.tz})`);
        assert.deepEqual(out.roundTrip, [true, true, true, true], tz);
        assert.deepEqual(out.week, ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'], tz);
        assert.equal(out.month, 31, tz);
        assert.deepEqual(out.dst, ['31:31', '30:30', '30:30', '30:30'], tz);
    }
});

test('helper and page never build dates via toISOString (UTC shift) or hard-code schedule data', () => {
    assert.ok(!/\.toISOString\(/.test(helperSource), 'helper');
    assert.ok(!/\.toISOString\(/.test(page), 'page');
    assert.ok(!/shifts\s*=\s*\[\s*\{/.test(page) && !/useState\(\s*\[\s*\{/.test(page), 'no inline mock rows');
    assert.ok(!/mock/i.test(page), 'no mock data in the page');
});

test('page wiring: segmented Day/Week/Month control drives the fetch range, columns and live merge', () => {
    assert.match(page, /const \[schedule, dispatch\] = useReducer\(scheduleReducer, undefined, \(\) => initialScheduleState\(\)\)/, 'one reducer owns view, date, employee and search state');
    assert.match(read('client/src/utils/shiftScheduleState.js'), /view: VIEW_WEEK,/, 'Week is the default view');
    for (const label of ['Day', 'Week', 'Month']) assert.ok(page.includes(`label: "${label}"`), label);
    assert.match(page, /aria-pressed=\{view === option\.value\}/);
    assert.match(page, /className="shift-view-toggle"/);
    assert.match(page, /const range = useMemo\(\(\) => getViewRange\(view, anchor\), \[view, anchor\]\)/);
    assert.match(page, /await getShifts\(wanted\.start, wanted\.end, extraParams\)/, 'existing API, range-driven');
    assert.match(page, /\}, \[range\.start, range\.end, selectedEmployeeId\]\);/, 'schedule reloads when the range or the employee filter changes');
    assert.match(page, /NAV_LABELS\[view\]\.prev/);
    assert.match(page, /NAV_LABELS\[view\]\.next/);
    assert.match(page, /dispatch\(\{ type: "step", direction: -1 \}\)/);
    assert.match(page, /dispatch\(\{ type: "step", direction: 1 \}\)/);
    assert.match(page, /shouldMergeLiveUpdate\(payload, weekDates, selectedEmployeeId\)/, 'live updates are still merged only inside the visible range');
    assert.match(page, /weekDates\.map\(\(date\) => \{/, 'one column per visible date');
    assert.match(page, /shift-table-month/);
    // the old single-week state is gone
    assert.ok(!/setWeekStart|\bweekStart,\s*setWeekStart/.test(page));
});

test('existing features are preserved: employee search + date picker, self-service rows, override handlers, audit wording', () => {
    assert.match(page, /onSubmit=\{handleSearch\}/);
    assert.match(page, /searchShiftEmployees\(query, date\)/);
    assert.match(page, /type="date"\s+className="shift-date-input"/);
    assert.match(page, /onClick=\{row\.isSelf \? \(\) => \(entry \? openSelfEdit\(entry\) : openSelfAdd\(date\)\) : undefined\}/, 'only MY row is editable');
    assert.match(page, /onClick=\{handleCopyPreviousWeekAllEmployees\}/);
    assert.match(page, /onClick=\{openOverrideCreate\}/);
    assert.match(page, /Copy Previous Week \(All Employees\)/);
    assert.match(page, /Manage Employee Schedule/);
    assert.match(page, /recorded in the audit history/);
    assert.match(page, /const handleOverrideSubmit/);
    assert.match(page, /bulkSaveShifts\(shiftedEntries\)/);
    // copy-previous-week is still week-based and now timezone-safe
    assert.match(page, /const weekStart = getMondayOf\(anchor\)/);
    assert.match(page, /addDays\(weekStart, -7\)/);
    assert.match(page, /openOverrideCreate = \(\) => \{[\s\S]*shiftDate: weekDates\[0\]/);
});

test('Reports panel replaces the Administrative Override box: one panel, top-right in the header, before the controls and the table', () => {
    assert.ok(!/Administrative Override"|shift-override-panel/.test(page), 'the override box is gone');
    assert.ok(!/shift-override-panel|shift-override-button/.test(css), 'and so are its styles');
    assert.equal((page.match(/<section className="shift-reports-panel"/g) || []).length, 1, 'exactly one panel');
    const header = page.indexOf('<header className="shift-page-header">');
    const panel = page.indexOf('<section className="shift-reports-panel"');
    const controls = page.indexOf('<section className="shift-toolbar"');
    const card = page.indexOf('<section className="shift-schedule-card">');
    assert.ok(header > 0 && panel > header && controls > panel && card > controls, 'order: header(panel) -> controls -> table');
    const headerBlock = page.slice(header, controls);
    assert.ok(headerBlock.includes('shift-management-title') && headerBlock.includes('shift-reports-panel'));
    assert.match(css, /\.shift-reports-panel\{[^}]*flex:0 1 560px;/);
    assert.match(css, /\.shift-reports-panel\{[^}]*max-width:100%;/);
    assert.match(css, /\.shift-reports-panel\{[^}]*background:var\(--card\);/, 'portal card colours, not the old orange');
    assert.match(css, /\.shift-reports-download\{[^}]*background:var\(--primary\);/);
    assert.match(css, /\.shift-page-header\{[^}]*flex-wrap:wrap;/, 'wraps instead of overlapping');
    const mobile = css.slice(css.indexOf('@media (max-width: 768px)'));
    assert.match(mobile, /\.shift-toolbar-row\{\s*flex-direction:column;/, 'controls stack on small screens');
    assert.match(mobile, /\.shift-page-header\{\s*flex-direction:column;/, 'header (and panel) stack on small screens');
    assert.match(mobile, /\.shift-reports-download\{\s*flex:1 1 100%;/, 'download button is full width on phones');
    // only the three period options, no date input inside the panel
    const panelBlock = page.slice(panel, page.indexOf('</section>', panel));
    assert.match(page, /const REPORT_PERIODS = \[\s*\{ value: "day", label: "Day" \},\s*\{ value: "week", label: "Week" \},\s*\{ value: "month", label: "Month" \},\s*\];/);
    assert.ok(!/type="date"|<input/.test(panelBlock), 'no date picker or free-text input in the Reports panel');
    // the two former override actions are kept, as toolbar buttons
    const toolbarBlock = page.slice(controls, card);
    assert.ok(toolbarBlock.includes('shift-toolbar-admin-actions') && toolbarBlock.includes('handleCopyPreviousWeekAllEmployees') && toolbarBlock.includes('openOverrideCreate'));
});

test('access control unchanged: no new role logic, same API surface, route still guarded, server untouched by this feature', () => {
    // authorisation stays server-side + the route guard; the page adds no role/access checks of its own
    assert.ok(!/systemAccess|system_access|\.role\b|isAdmin/.test(page), 'page has no access decisions');
    assert.ok(!/systemAccess|system_access|\.role\b/.test(helperSource), 'view helper has no access decisions');
    const endpoints = [...page.matchAll(/api\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(endpoints, ['get /employees'], 'only the existing GET /employees call; everything else goes through shiftScheduleService');
    const imported = page.match(/import \{([^}]+)\} from "\.\.\/\.\.\/services\/shiftScheduleService"/)[1].split(',').map((s) => s.trim()).filter(Boolean);
    assert.deepEqual(imported.sort(), ['bulkSaveShifts', 'createShift', 'deleteShift', 'exportShiftReport', 'getShifts', 'searchShiftEmployees', 'updateShift']);
    assert.match(read('client/src/routes/ShiftManagementRoute.jsx'), /resolveShiftManagementAccess/);
    assert.match(read('client/src/App.jsx'), /path: "shift-management", Component: ShiftManagementRoute/);
    // the shift API already takes an arbitrary startDate/endDate and enforces scope per request (a month needs no new endpoint)
    const controller = read('server/controllers/shiftScheduleController.js');
    assert.match(controller, /startDate > endDate/);
    assert.ok(!/MAX_RANGE|maxRange|too large a range/i.test(controller), 'no range cap that would reject a month');
});
