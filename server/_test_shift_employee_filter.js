// Shift Management employee filter tests (works together with the Day / Week / Month view). No database,
// no network, no browser, nothing production:
//   - the pure helpers in client/src/utils/shiftViews.js are imported and run for real;
//   - the REAL shift controller runs against an in-memory fake pool (MOCKED -- it models what the controller
//     asks the database, not PostgreSQL) to prove the server-side ?userId= filtering for day/week/month;
//   - AdminShiftManagement.jsx is read statically to pin how the filter is wired.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const page = read('client/src/pages/Admin/AdminShiftManagement.jsx');
const css = read('client/src/pages/Admin/AdminShiftManagement.css');

let helperPromise;
const helper = () => (helperPromise ||= import(pathToFileURL(path.join(ROOT, 'client/src/utils/shiftViews.js')).href));
const d = (iso) => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); };

const ROWS = [
    { userId: 1, fullName: 'Admin User' },
    { userId: 2, fullName: 'Asha Rao' },
    { userId: 3, fullName: 'Bilal Khan' },
];

test('no employee selected = every row, untouched (clearing the filter shows everyone again)', async () => {
    const { filterRowsByEmployee } = await helper();
    for (const none of [null, undefined, '']) assert.equal(filterRowsByEmployee(ROWS, none), ROWS);
});

test('an employee selected = only that employee, whatever the id type', async () => {
    const { filterRowsByEmployee } = await helper();
    assert.deepEqual(filterRowsByEmployee(ROWS, 2).map((r) => r.userId), [2]);
    assert.deepEqual(filterRowsByEmployee(ROWS, '3').map((r) => r.userId), [3]);
    assert.deepEqual(filterRowsByEmployee(ROWS, 99), [], 'unknown id -> nothing, never everyone');
});

test('query for the existing API: range + userId only when an employee is selected, for Day, Week and Month', async () => {
    const { buildShiftQuery, getViewRange } = await helper();
    const anchor = d('2026-10-23');
    const expected = { day: ['2026-10-23', '2026-10-23'], week: ['2026-10-19', '2026-10-25'], month: ['2026-10-01', '2026-10-31'] };
    for (const view of ['day', 'week', 'month']) {
        const range = getViewRange(view, anchor);
        const withEmployee = buildShiftQuery(range, 2);
        assert.deepEqual([withEmployee.startDate, withEmployee.endDate], expected[view], view);
        assert.deepEqual(withEmployee.extraParams, { userId: 2 }, `${view}: server-side filter`);
        const everyone = buildShiftQuery(range, null);
        assert.deepEqual([everyone.startDate, everyone.endDate], expected[view], view);
        assert.deepEqual(everyone.extraParams, {}, `${view}: filter cleared -> no userId sent`);
    }
});

test('switching views keeps the employee filter: only the range changes, the userId stays', async () => {
    const { buildShiftQuery, getViewRange, anchorForView } = await helper();
    const today = d('2026-10-23');
    let view = 'week';
    let anchor = today;
    const employeeId = 2; // selected once, independent of the view
    const seen = [];
    for (const next of ['day', 'month', 'week', 'month', 'day']) {
        anchor = anchorForView(next, anchor, getViewRange(view, anchor), today);
        view = next;
        const q = buildShiftQuery(getViewRange(view, anchor), employeeId);
        seen.push({ view, start: q.startDate, end: q.endDate, userId: q.extraParams.userId });
    }
    assert.ok(seen.every((s) => s.userId === 2), 'userId present in every view');
    assert.deepEqual(seen.map((s) => s.view), ['day', 'month', 'week', 'month', 'day']);
    assert.deepEqual(seen.map((s) => [s.start, s.end]), [
        ['2026-10-23', '2026-10-23'], ['2026-10-01', '2026-10-31'], ['2026-10-19', '2026-10-25'], ['2026-10-01', '2026-10-31'], ['2026-10-23', '2026-10-23'],
    ]);
});

test('Previous/Next keeps the employee and moves the range (day, week, month, across a year)', async () => {
    const { buildShiftQuery, getViewRange, shiftAnchor } = await helper();
    const step = (view, from, dir) => {
        const a = shiftAnchor(view, d(from), dir);
        const q = buildShiftQuery(getViewRange(view, a), 5);
        return [q.startDate, q.endDate, q.extraParams.userId];
    };
    assert.deepEqual(step('day', '2026-12-31', 1), ['2027-01-01', '2027-01-01', 5]);
    assert.deepEqual(step('week', '2026-12-30', 1), ['2027-01-04', '2027-01-10', 5]);
    assert.deepEqual(step('month', '2026-12-15', 1), ['2027-01-01', '2027-01-31', 5]);
    assert.deepEqual(step('month', '2026-01-15', -1), ['2025-12-01', '2025-12-31', 5]);
});

test('live updates: merged only inside the visible range and, with a filter, only for the selected employee', async () => {
    const { shouldMergeLiveUpdate } = await helper();
    const dates = ['2026-10-19', '2026-10-20'];
    assert.equal(shouldMergeLiveUpdate({ shiftDate: '2026-10-19', userId: 2 }, dates, null), true, 'no filter: anyone in range');
    assert.equal(shouldMergeLiveUpdate({ shiftDate: '2026-10-19', userId: 3 }, dates, 2), false, 'other employee ignored');
    assert.equal(shouldMergeLiveUpdate({ shiftDate: '2026-10-19', userId: 2 }, dates, 2), true);
    assert.equal(shouldMergeLiveUpdate({ shiftDate: '2026-10-19', userId: '2' }, dates, 2), true, 'id type tolerant');
    assert.equal(shouldMergeLiveUpdate({ shiftDate: '2026-11-01', userId: 2 }, dates, 2), false, 'outside range');
    assert.equal(shouldMergeLiveUpdate(null, dates, null), false);
});

// ---- the REAL controller, MOCKED pool: the server filters by ?userId= for every range size ----
function loadController(allShifts, user) {
    const modPath = path.join(ROOT, 'server/controllers/shiftScheduleController.js');
    const dbPath = require.resolve(path.join(ROOT, 'server/config/db.js'));
    delete require.cache[modPath];
    const calls = [];
    const pool = {
        async query(sql, params = []) {
            calls.push({ sql, params });
            if (/FROM users/i.test(sql) && /role|system_access|employment_status/i.test(sql) && !/shift_schedules/i.test(sql)) {
                return [[{ role: user.role, system_access: user.systemAccess, employment_status: 'active' }]];
            }
            if (/FROM shift_schedules/i.test(sql)) {
                const [start, end, ...rest] = params;
                const wantUser = /AND s\.user_id = \?/.test(sql) ? Number(rest[0]) : null;
                return [allShifts.filter((s) => s.shift_date >= start && s.shift_date <= end && (wantUser === null || s.user_id === wantUser))
                    .map((s) => ({ ...s, full_name: `U${s.user_id}` }))];
            }
            return [[]];
        },
    };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
    const controller = require(modPath);
    return { controller, calls };
}

async function callGetShifts(controller, user, query) {
    let status = 200;
    let body;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    // req.userAccess is what requireAccess/requireActiveUser sets from a fresh DB read
    await controller.getShifts({ query, user: { id: user.id }, userAccess: { role: user.role, systemAccess: user.systemAccess } }, res);
    return { status, body };
}

test('MOCKED server filtering: admin tier + userId returns only that employee for a day, a week and a month; no userId returns everyone', async () => {
    const shifts = [];
    let id = 1;
    for (const uid of [1, 2, 3]) for (let day = 1; day <= 31; day++) shifts.push({ id: id++, user_id: uid, shift_date: `2026-10-${String(day).padStart(2, '0')}`, status: 'working', start_time: '09:00', end_time: '18:00', notes: null });
    const admin = { id: 1, role: 'employee', systemAccess: 'super_admin' };
    const { controller } = loadController(shifts, admin);

    const ranges = { day: ['2026-10-23', '2026-10-23', 1], week: ['2026-10-19', '2026-10-25', 7], month: ['2026-10-01', '2026-10-31', 31] };
    for (const [name, [startDate, endDate, days]] of Object.entries(ranges)) {
        const filtered = await callGetShifts(controller, admin, { startDate, endDate, userId: '2' });
        assert.equal(filtered.status, 200, name);
        assert.ok(filtered.body.shifts.every((s) => s.user_id === 2), `${name}: only employee 2`);
        assert.equal(filtered.body.shifts.length, days, `${name}: every day of the range for that employee`);

        const everyone = await callGetShifts(controller, admin, { startDate, endDate });
        assert.equal(everyone.body.shifts.length, days * 3, `${name}: filter cleared -> all employees`);
        assert.deepEqual([...new Set(everyone.body.shifts.map((s) => s.user_id))].sort(), [1, 2, 3], name);
    }
});

test('MOCKED validation unchanged: a non-numeric userId is rejected and filtering never writes', async () => {
    const admin = { id: 1, role: 'employee', systemAccess: 'admin' };
    const a = loadController([], admin);
    const bad = await callGetShifts(a.controller, admin, { startDate: '2026-10-01', endDate: '2026-10-31', userId: 'abc' });
    assert.equal(bad.status, 400);
    assert.ok(a.calls.every((c) => !/INSERT|UPDATE|DELETE/i.test(c.sql)), 'filtering never writes');
});

// ---- page wiring (static) ----
test('page wiring: the filter is state independent of the view; search, picker, chip and table are all tied to it', () => {
    assert.match(page, /const \[selectedEmployee, setSelectedEmployee\] = useState\(null\)/);
    assert.match(page, /const selectedEmployeeId = selectedEmployee \? selectedEmployee\.userId : null/);
    // view switching must not touch the filter
    const viewHandler = page.slice(page.indexOf('const handleViewChange'), page.indexOf('const loadSchedule'));
    assert.ok(!/setSelectedEmployee|clearEmployeeFilter/.test(viewHandler), 'switching view preserves the employee filter');
    // server-side filter through the existing API, refetched when the employee changes
    assert.match(page, /buildShiftQuery\(range, selectedEmployeeId\)/);
    assert.match(page, /getShifts\(range\.start, range\.end, extraParams\)/);
    assert.match(page, /\[range\.start, range\.end, selectedEmployeeId\]/);
    // rows, live merge
    assert.match(page, /return filterRowsByEmployee\(rows, selectedEmployeeId\)/);
    assert.match(page, /shouldMergeLiveUpdate\(payload, weekDates, selectedEmployeeId\)/);
    // search by name or employee ID (existing endpoint) selects exactly-one matches; several matches get a button
    assert.match(page, /Search by name or employee ID/);
    assert.match(page, /if \(results\.length === 1\) selectEmployee\(results\[0\]\)/);
    assert.match(page, /onClick=\{\(\) => selectEmployee\(result\)\}/);
    assert.match(page, /View schedule/);
    // clearing: the Clear button and an empty search both remove the filter
    assert.match(page, /onClick=\{clearEmployeeFilter\}/);
    assert.match(page, /if \(!query\) \{[\s\S]*?clearEmployeeFilter\(\);/);
    // date picker == the same anchor that drives the range; search results follow the date
    assert.match(page, /const searchDate = toIsoDate\(anchor\)/);
    assert.match(page, /if \(event\.target\.value\) setAnchor\(parseIsoDate\(event\.target\.value\)\)/);
    assert.match(page, /if \(submittedQuery\) runSearch\(submittedQuery, searchDate\);/);
    assert.ok(!/setSearchDate/.test(page), 'no second, independent date state');
    // chip
    assert.match(page, /Showing schedule for/);
    assert.match(page, /Clear filter/);
    assert.match(css, /\.shift-filter-chip\{/);
});

test('permissions, self-service and override are untouched by the filter', () => {
    assert.ok(!/systemAccess|system_access|\.role\b|isAdmin/.test(page), 'no access decisions in the page');
    const endpoints = [...page.matchAll(/api\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(endpoints, ['get /employees'], 'no new endpoints');
    assert.match(page, /onClick=\{row\.isSelf \? \(\) => \(entry \? openSelfEdit\(entry\) : openSelfAdd\(date\)\) : undefined\}/, 'only MY row is editable');
    assert.match(page, /onClick=\{openOverrideCreate\}/);
    assert.match(page, /onClick=\{handleCopyPreviousWeekAllEmployees\}/);
    assert.match(page, /recorded in the audit history/);
    // Copy Previous Week stays an all-employees action: its fetch must not carry the filter
    const copy = page.slice(page.indexOf('const handleCopyPreviousWeekAllEmployees'), page.indexOf('return (\n        <div className="admin-page-content">'));
    assert.match(copy, /await getShifts\(toIsoDate\(previousMonday\), toIsoDate\(previousSunday\)\)/);
    assert.ok(!/selectedEmployee/.test(copy), 'copy-previous-week ignores the filter');
    // with a filter active the override starts on that employee and picks up their existing entry
    assert.match(page, /userId: selectedEmployeeId \? String\(selectedEmployeeId\) : ""/);
    assert.match(page, /Number\(s\.user_id\) === Number\(selectedEmployeeId\) && s\.shift_date === weekDates\[0\]/);
    // the compact panel is still in the header
    assert.match(page, /shift-override-panel shift-override-panel-compact/);
    assert.ok(page.indexOf('shift-override-panel-compact') < page.indexOf('className="shift-search-panel"'));
});
