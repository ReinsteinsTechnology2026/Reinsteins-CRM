// Shift Management: employee search, selected employee and the date picker all follow the selected
// Day / Week / Month view. No database, no network, no browser, nothing production:
//   - the pure helpers in client/src/utils/shiftViews.js are run for real, including in several time
//     zones (India/IST first) each in its own child process, because TZ is fixed at process start;
//   - AdminShiftManagement.jsx is read statically to pin the wiring and the unchanged API/permissions.
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

let helperPromise;
const helper = () => (helperPromise ||= import(pathToFileURL(HELPER_PATH).href));
const asha = { userId: 2, fullName: 'Asha Rao', employeeId: 'EMP002' };

test('date picker value -> local date: valid values accepted, empty/invalid values never move the range', async () => {
    const { anchorFromPickerValue, toIsoDate } = await helper();
    assert.equal(toIsoDate(anchorFromPickerValue('2026-10-21')), '2026-10-21');
    assert.equal(toIsoDate(anchorFromPickerValue('2028-02-29')), '2028-02-29');
    for (const bad of ['', null, undefined, 'abc', '2026-10', '2026-02-30', '2026-13-01', '21-10-2026']) {
        assert.equal(anchorFromPickerValue(bad), null, String(bad));
    }
});

test('the picker controls the range of the SELECTED view: Day = that day, Week = its Mon-Sun week, Month = its month', async () => {
    const { anchorFromPickerValue, getViewRange, buildShiftQuery } = await helper();
    const expect = (view, value) => { const r = getViewRange(view, anchorFromPickerValue(value)); return [r.start, r.end]; };

    assert.deepEqual(expect('day', '2026-10-21'), ['2026-10-21', '2026-10-21']);
    // any date in the week selects the same Monday-Sunday week (Mon, Wed, Sun)
    for (const v of ['2026-10-19', '2026-10-21', '2026-10-25']) assert.deepEqual(expect('week', v), ['2026-10-19', '2026-10-25'], v);
    // any date in the month selects the whole month (1st, middle, last; leap February)
    for (const v of ['2026-10-01', '2026-10-17', '2026-10-31']) assert.deepEqual(expect('month', v), ['2026-10-01', '2026-10-31'], v);
    assert.deepEqual(expect('month', '2028-02-10'), ['2028-02-01', '2028-02-29']);

    // and the employee filter rides along with exactly that range
    for (const view of ['day', 'week', 'month']) {
        const range = getViewRange(view, anchorFromPickerValue('2026-10-21'));
        const q = buildShiftQuery(range, asha.userId);
        assert.deepEqual([q.startDate, q.endDate], [range.start, range.end], view);
        assert.deepEqual(q.extraParams, { userId: 2 }, view);
    }
});

test('search results show per-day detail only in the Day view (the search API answers for one date)', async () => {
    const { searchShowsDayDetail } = await helper();
    assert.equal(searchShowsDayDetail('day'), true);
    assert.equal(searchShowsDayDetail('week'), false);
    assert.equal(searchShowsDayDetail('month'), false);
});

test('what is on screen is spelled out: view + range + employee (or everyone) for Day, Week and Month', async () => {
    const { filterSummary, anchorFromPickerValue, VIEW_LABELS, PICKER_LABELS } = await helper();
    const anchor = anchorFromPickerValue('2026-10-21');
    assert.match(filterSummary('day', anchor, asha), /^Day .*Wednesday.*21 Oct 2026: Asha Rao \(EMP002\)$/);
    assert.match(filterSummary('week', anchor, asha), /^Week 19 Oct - 25 Oct: Asha Rao \(EMP002\)$/);
    assert.match(filterSummary('month', anchor, asha), /^Month October 2026: Asha Rao \(EMP002\)$/);
    assert.match(filterSummary('week', anchor, null), /^Week 19 Oct - 25 Oct: all employees$/);
    assert.match(filterSummary('month', anchor, { fullName: 'No Id' }), /: No Id$/);
    assert.deepEqual(VIEW_LABELS, { day: 'Day', week: 'Week', month: 'Month' });
    assert.equal(PICKER_LABELS.week, 'Any date in the week');
    assert.equal(PICKER_LABELS.month, 'Any date in the month');
});

// ---- the whole interaction as a state machine over the REAL helpers: employee must survive everything ----
async function session() {
    const h = await helper();
    const today = h.anchorFromPickerValue('2026-10-23');
    const st = { view: 'week', anchor: today, employee: null, log: [] };
    const query = () => { const q = h.buildShiftQuery(h.getViewRange(st.view, st.anchor), st.employee && st.employee.userId); st.log.push([st.view, q.startDate, q.endDate, q.extraParams.userId ?? null]); return q; };
    return {
        st,
        query,
        view: (v) => { st.anchor = h.anchorForView(v, st.anchor, h.getViewRange(st.view, st.anchor), today); st.view = v; return query(); },
        pick: (value) => { const a = h.anchorFromPickerValue(value); if (a) st.anchor = a; return query(); },
        step: (dir) => { st.anchor = h.shiftAnchor(st.view, st.anchor, dir); return query(); },
        select: (e) => { st.employee = e; return query(); },
        clear: () => { st.employee = null; return query(); },
    };
}

test('search -> select -> Day/Week/Month -> picker -> Previous/Next: the selected employee is preserved throughout', async () => {
    const s = await session();
    s.select(asha);
    const steps = [
        s.view('day'), s.view('week'), s.view('month'),
        s.pick('2026-12-15'), s.step(1), s.step(1), s.step(-1),
        s.view('week'), s.pick('2027-01-02'), s.step(-1), s.view('day'), s.step(1),
    ];
    assert.ok(steps.every((q) => q.extraParams.userId === 2), 'userId on every request');
    // the ranges themselves are right at the interesting spots
    assert.deepEqual(s.st.log.map((l) => l.slice(0, 3).join('|')).slice(1, 6), [
        'day|2026-10-23|2026-10-23', 'week|2026-10-19|2026-10-25', 'month|2026-10-01|2026-10-31',
        'month|2026-12-01|2026-12-31', 'month|2027-01-01|2027-01-31',
    ]);
});

test('Clear filter restores all employees for the SAME view and range', async () => {
    const s = await session();
    s.select(asha); s.view('month'); s.pick('2026-09-09');
    const filtered = s.query();
    const cleared = s.clear();
    assert.equal(filtered.extraParams.userId, 2);
    assert.deepEqual(cleared.extraParams, {}, 'no userId = everyone');
    assert.deepEqual([cleared.startDate, cleared.endDate], [filtered.startDate, filtered.endDate], 'same month, not reset');
    assert.deepEqual([cleared.startDate, cleared.endDate], ['2026-09-01', '2026-09-30']);
});

test('India/IST (and other zones): picker dates, ranges and the whole flow stay on the local calendar date (no UTC shift)', () => {
    const script = `
        import(${JSON.stringify(pathToFileURL(HELPER_PATH).href)}).then((h) => {
            const pick = (v) => h.anchorFromPickerValue(v);
            const range = (view, v) => { const r = h.getViewRange(view, pick(v)); return [r.start, r.end]; };
            let anchor = pick('2026-10-19'); // a Monday -- local midnight in IST is the previous UTC day
            const walk = [];
            for (const view of ['week', 'month', 'day']) {
                walk.push([view, ...(() => { const r = h.getViewRange(view, anchor); return [r.start, r.end]; })(), h.buildShiftQuery(h.getViewRange(view, anchor), 2).extraParams.userId]);
                anchor = h.shiftAnchor(view, anchor, 1);
            }
            console.log(JSON.stringify({
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                picked: h.toIsoDate(pick('2026-10-19')),
                day: range('day', '2026-10-19'), week: range('week', '2026-10-19'), sunday: range('week', '2026-10-25'),
                month: range('month', '2026-10-31'), newYear: range('week', '2026-01-01'), walk,
                summary: h.filterSummary('week', pick('2026-10-19'), { fullName: 'Asha Rao', employeeId: 'EMP002' }),
            }));
        });`;
    const names = { 'Asia/Kolkata': ['Asia/Kolkata', 'Asia/Calcutta'], UTC: ['UTC', 'Etc/UTC'], 'Pacific/Auckland': ['Pacific/Auckland'], 'America/Los_Angeles': ['America/Los_Angeles'] };
    for (const tz of Object.keys(names)) {
        const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim().split('\n').pop());
        assert.ok(names[tz].includes(out.tz), `ran in ${tz} (reported ${out.tz})`);
        assert.equal(out.picked, '2026-10-19', `${tz}: picked Monday stays Monday`);
        assert.deepEqual(out.day, ['2026-10-19', '2026-10-19'], tz);
        assert.deepEqual(out.week, ['2026-10-19', '2026-10-25'], tz);
        assert.deepEqual(out.sunday, ['2026-10-19', '2026-10-25'], tz);
        assert.deepEqual(out.month, ['2026-10-01', '2026-10-31'], tz);
        assert.deepEqual(out.newYear, ['2025-12-29', '2026-01-04'], tz);
        assert.deepEqual(out.walk, [['week', '2026-10-19', '2026-10-25', 2], ['month', '2026-10-01', '2026-10-31', 2], ['day', '2026-11-01', '2026-11-01', 2]], tz);
        assert.match(out.summary, /^Week 19 Oct - 25 Oct: Asha Rao \(EMP002\)$/, tz);
    }
});

// ---- page wiring (static) ----
test('page: ONE date picker in the toolbar that sets the shared date; no independent single-day search state', () => {
    assert.equal((page.match(/type="date"/g) || []).length, 2, 'toolbar picker + the override form date');
    assert.match(page, /type="date"\s+className="shift-date-input"\s+value=\{toIsoDate\(anchor\)\}\s+onChange=\{\(event\) => dispatch\(\{ type: "pickDate", value: event\.target\.value \}\)\}/);
    assert.ok(!/setSearchDate|searchDate/.test(page), 'no second date state');
    assert.match(page, /<span>\{PICKER_LABELS\[view\]\}<\/span>/, 'the picker is labelled for the selected view');
    assert.match(css, /\.shift-date-field\{/);
    assert.ok(!/shift-search-scope|shift-search-date-label/.test(css + page), 'the duplicate scope heading is gone');
});

test('page: search results adapt to the view, the chip names the employee, clearing restores everyone for the same range', () => {
    assert.match(page, /\{showsDayDetail\(view\) && \(\s*<span className="shift-finder-day">/, 'day-only detail in results');
    assert.ok(!/<th>Date<\/th>/.test(page.slice(page.indexOf('shift-finder'), page.indexOf('shift-schedule-card'))), 'no single-day result columns');
    assert.match(page, /if \(searchOpen && submittedQuery && showsDayDetail\(view\)\) runSearch\(submittedQuery, toIsoDate\(anchor\)\);/);
    assert.match(page, /\}, \[anchor, view\]\);/);
    assert.match(page, /data-testid="shift-filter-summary">\{filterChipText\(selectedEmployee\)\}/);
    assert.match(page, /const clearEmployeeFilter = \(\) => dispatch\(\{ type: "clearEmployee" \}\);/);
    assert.match(page, /onClick=\{clearEmployeeFilter\}/);
    // the schedule itself still follows the range + employee through the existing API
    assert.match(page, /buildShiftQuery\(wanted, wantedEmployeeId\)/);
    assert.match(page, /getShifts\(wanted\.start, wanted\.end, extraParams\)/);
    assert.match(page, /\[range\.start, range\.end, selectedEmployeeId\]/);
});

test('unchanged: existing API only, no access logic, override + duplicate protections, audit wording, self-service', () => {
    const endpoints = [...page.matchAll(/api\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(endpoints, ['get /employees'], 'no new endpoint');
    assert.match(page, /searchShiftEmployees\(query, date\)/, 'the existing search endpoint, one date');
    assert.ok(!/systemAccess|system_access|\.role\b|isAdmin/.test(page));
    assert.match(page, /findOverrideTarget\(overrideForm\.userId, overrideForm\.shiftDate\)/, 'duplicate-entry pre-check kept');
    assert.match(page, /needsServerLookup\(\{ userId: next\.userId/);
    assert.match(page, /overrideLookupRef\.current/);
    assert.match(page, /recorded in the audit history/);
    assert.match(page, /onClick=\{row\.isSelf \? \(\) => \(entry \? openSelfEdit\(entry\) : openSelfAdd\(date\)\) : undefined\}/);
    assert.match(page, /<section className="shift-reports-panel"/);
    assert.match(page, /Copy Previous Week \(All Employees\)/);
    assert.ok(!/\.toISOString\(/.test(page) && !/\.toISOString\(/.test(read('client/src/utils/shiftViews.js')), 'no UTC date building');
});
