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
    const state = read('client/src/utils/shiftScheduleState.js');
    assert.match(page, /const \{ view, anchor, custom, employee: selectedEmployee, searchOpen \} = schedule/);
    assert.match(page, /const selectedEmployeeId = selectedEmployee \? selectedEmployee\.userId : null/);
    // view switching must not touch the filter (reducer: setView keeps `employee`)
    const setView = state.slice(state.indexOf('case "setView"'), state.indexOf('case "step"'));
    assert.ok(!/employee/.test(setView), 'switching view preserves the employee filter');
    // server-side filter through the existing API, refetched when the employee changes
    assert.match(page, /buildShiftQuery\(wanted, wantedEmployeeId\)/);
    assert.match(page, /getShifts\(wanted\.start, wanted\.end, extraParams\)/);
    assert.match(page, /\[range\.valid, range\.start, range\.end, selectedEmployeeId\]/);
    // rows, live merge
    assert.match(page, /buildScheduleRows\(\{ employees, shifts, currentUserId: currentUser\?\.id, selectedEmployee \}\)/);
    assert.match(page, /shouldMergeLiveUpdate\(payload, weekDates, selectedEmployeeId\)/);
    // search by name or employee ID (existing endpoint) selects exactly-one matches; several matches are a list
    assert.match(page, /Search by name or employee ID/);
    assert.match(page, /if \(results && results\.length === 1\) selectEmployee\(results\[0\]\)/);
    assert.match(page, /onClick=\{\(\) => selectEmployee\(result\)\}/);
    // clearing: the chip's x clears; an empty search only clears the results
    assert.match(page, /onClick=\{clearEmployeeFilter\}/);
    // date picker == the shared anchor; Day-view results follow the date
    assert.match(page, /dispatch\(\{ type: "pickDate", value: event\.target\.value \}\)/);
    assert.match(page, /\[anchor, view\]\);/);
    // chip
    assert.match(page, /filterChipText\(selectedEmployee\)/);
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
    const copy = page.slice(page.indexOf('const handleCopyPreviousWeekAllEmployees'), page.indexOf('const rangeLabel = formatRangeLabel'));
    assert.match(copy, /await getShifts\(toIsoDate\(previousMonday\), toIsoDate\(previousSunday\)\)/);
    assert.ok(!/selectedEmployee/.test(copy), 'copy-previous-week ignores the filter');
    // with a filter active the override starts on that employee and picks up their existing entry
    assert.match(page, /userId: selectedEmployeeId \? String\(selectedEmployeeId\) : ""/);
    assert.match(page, /Number\(s\.user_id\) === Number\(selectedEmployeeId\) && s\.shift_date === weekDates\[0\]/);
    // the Reports panel (which replaced the override box) is still in the header
    assert.match(page, /<section className="shift-reports-panel"/);
    assert.ok(page.indexOf('shift-reports-panel') < page.indexOf('<section className="shift-toolbar"'));
});

// ---- REGRESSION: administrative override target while an employee filter hides other employees ----
const RANGE = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
const shiftRow = (id, userId, date) => ({ id, user_id: userId, shift_date: date, status: 'working', start_time: '10:00', end_time: '19:00', notes: 'n' });

test('override regression: filtered to employee 2, picking employee 3 who ALREADY has an entry finds it (no duplicate-entry create)', async () => {
    const { resolveOverrideTarget, overrideFormFromShift } = await helper();
    // the page only loaded employee 2 (server-side ?userId=2); employee 3's entry exists on the server
    const loaded = [shiftRow(11, 2, '2026-10-21')];
    const server = [shiftRow(11, 2, '2026-10-21'), shiftRow(22, 3, '2026-10-21')];
    const calls = [];
    const fetchDay = async (date, userId) => { calls.push([date, userId]); return { shifts: server.filter((s) => s.shift_date === date && s.user_id === Number(userId)) }; };

    // what the OLD local-only lookup did: nothing found -> create -> 409
    assert.equal(loaded.find((s) => s.user_id === 3 && s.shift_date === '2026-10-21'), undefined, 'old behaviour missed the entry');

    const { shift, lookupFailed } = await resolveOverrideTarget({ userId: '3', shiftDate: '2026-10-21', shifts: loaded, selectedEmployeeId: 2, rangeDates: RANGE, fetchDay });
    assert.equal(lookupFailed, false);
    assert.equal(shift.id, 22, 'existing entry of the OTHER employee is found');
    assert.deepEqual(calls, [['2026-10-21', '3']], 'one single-day, single-employee request to the existing API');
    const form = overrideFormFromShift(shift);
    assert.equal(form.id, 22, 'form edits in place (update), it does not create');
    assert.equal(form.userId, '3');
    assert.equal(form.shiftDate, '2026-10-21');
    assert.equal(form.startTime, '10:00');
});

test('override regression: filtered to 2, picking employee 3 with NO entry -> null (a genuine create is allowed), still one lookup', async () => {
    const { resolveOverrideTarget } = await helper();
    const calls = [];
    const fetchDay = async (date, userId) => { calls.push([date, userId]); return { shifts: [] }; };
    const r = await resolveOverrideTarget({ userId: '3', shiftDate: '2026-10-22', shifts: [], selectedEmployeeId: 2, rangeDates: RANGE, fetchDay });
    assert.deepEqual(r, { shift: null, lookupFailed: false });
    assert.equal(calls.length, 1);
});

test('override regression: changing the target repeatedly while filtering always re-resolves from the server, never reuses a stale answer', async () => {
    const { resolveOverrideTarget } = await helper();
    const server = [shiftRow(31, 3, '2026-10-20'), shiftRow(41, 4, '2026-10-20')];
    const fetchDay = async (date, userId) => ({ shifts: server.filter((s) => s.shift_date === date && s.user_id === Number(userId)) });
    const base = { shifts: [], selectedEmployeeId: 2, rangeDates: RANGE, fetchDay };
    assert.equal((await resolveOverrideTarget({ ...base, userId: '3', shiftDate: '2026-10-20' })).shift.id, 31);
    assert.equal((await resolveOverrideTarget({ ...base, userId: '4', shiftDate: '2026-10-20' })).shift.id, 41);
    assert.equal((await resolveOverrideTarget({ ...base, userId: '3', shiftDate: '2026-10-21' })).shift, null);
});

test('override: no needless requests -- loaded entry, same employee as the filter, or no filter inside the range', async () => {
    const { resolveOverrideTarget, needsServerLookup } = await helper();
    let fetched = 0;
    const fetchDay = async () => { fetched++; return { shifts: [] }; };
    const loaded = [shiftRow(11, 2, '2026-10-21'), shiftRow(22, 3, '2026-10-21')];

    // loaded entry wins, even for another employee (no filter)
    assert.equal((await resolveOverrideTarget({ userId: '3', shiftDate: '2026-10-21', shifts: loaded, selectedEmployeeId: null, rangeDates: RANGE, fetchDay })).shift.id, 22);
    // filtered employee's own day: everything for them is loaded -> no request
    assert.equal((await resolveOverrideTarget({ userId: '2', shiftDate: '2026-10-22', shifts: loaded, selectedEmployeeId: 2, rangeDates: RANGE, fetchDay })).shift, null);
    // no filter, date inside the (complete) loaded range -> no request
    assert.equal((await resolveOverrideTarget({ userId: '4', shiftDate: '2026-10-22', shifts: loaded, selectedEmployeeId: null, rangeDates: RANGE, fetchDay })).shift, null);
    assert.equal(fetched, 0);

    assert.equal(needsServerLookup({ userId: '3', shiftDate: '2026-10-22', selectedEmployeeId: 2, rangeDates: RANGE }), true);
    assert.equal(needsServerLookup({ userId: '2', shiftDate: '2026-10-22', selectedEmployeeId: 2, rangeDates: RANGE }), false);
    assert.equal(needsServerLookup({ userId: '3', shiftDate: '2026-10-22', selectedEmployeeId: null, rangeDates: RANGE }), false);
    assert.equal(needsServerLookup({ userId: '3', shiftDate: '2026-12-01', selectedEmployeeId: null, rangeDates: RANGE }), true, 'a date outside the loaded range was a pre-existing gap too');
});

test('override: a failed lookup never throws and never fabricates an entry; the server duplicate check stays the safety net', async () => {
    const { resolveOverrideTarget } = await helper();
    const r = await resolveOverrideTarget({ userId: '3', shiftDate: '2026-10-21', shifts: [], selectedEmployeeId: 2, rangeDates: RANGE, fetchDay: async () => { throw new Error('network'); } });
    assert.deepEqual(r, { shift: null, lookupFailed: true });
    // ignores rows of a different employee/date in the answer
    const wrong = await resolveOverrideTarget({ userId: '3', shiftDate: '2026-10-21', shifts: [], selectedEmployeeId: 2, rangeDates: RANGE, fetchDay: async () => ({ shifts: [shiftRow(1, 9, '2026-10-21'), shiftRow(2, 3, '2026-10-20')] }) });
    assert.equal(wrong.shift, null);
});

test('override wiring: lookup on target change, stale answers dropped, pre-submit check, existing API only, permissions untouched', () => {
    const change = page.slice(page.indexOf('const handleOverrideFieldChange'), page.indexOf('const handleOverrideSubmit'));
    assert.match(change, /needsServerLookup\(\{ userId: next\.userId, shiftDate: next\.shiftDate, selectedEmployeeId, rangeDates: weekDates \}\)/);
    assert.match(change, /lookupId !== overrideLookupRef\.current\) return;/, 'stale lookup results are dropped');
    assert.match(change, /setOverrideForm\(\{ \.\.\.next, id: null \}\)/, 'a previously-populated id never lingers');
    assert.match(page, /fetchDay: \(date, id\) => getShifts\(date, date, \{ userId: id \}\)/, 'existing shift API, one day, one employee');
    const submit = page.slice(page.indexOf('const handleOverrideSubmit'), page.indexOf('const handleOverrideDelete'));
    assert.match(submit, /if \(!overrideForm\.id\) \{[\s\S]*?findOverrideTarget\(overrideForm\.userId, overrideForm\.shiftDate\)/, 'create re-checks for an existing entry first');
    assert.match(submit, /overrideSubmittingRef\.current = false;\s*return;/, 'the submit lock is released when the review path returns');
    assert.match(submit, /await createShift\(payload\)/, 'the real create/update calls are unchanged');
    assert.match(submit, /await updateShift\(overrideForm\.id, payload\)/);
    // filtering, date navigation and live updates are not touched by the override form
    assert.match(page, /shouldMergeLiveUpdate\(payload, weekDates, selectedEmployeeId\)/);
    assert.match(page, /buildShiftQuery\(wanted, wantedEmployeeId\)/);
    assert.ok(!/selectEmployee|clearEmployee/.test(change + submit), 'changing the override target never changes the schedule filter');
    // no new endpoints, no access decisions
    const endpoints = [...page.matchAll(/api\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(endpoints, ['get /employees']);
    assert.ok(!/systemAccess|system_access|\.role\b|isAdmin/.test(page));
});
