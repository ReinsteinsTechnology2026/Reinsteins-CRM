// Unit tests for client/src/utils/shiftScheduleState.js: the reducer that owns view + date + employee + search
// panel state, the latest-request-wins guard, and the table row builder. Pure functions run for real: no
// database, no network, no browser, nothing production. (The same behaviour is also exercised through the
// real rendered page in _test_shift_page_rendered.js.)
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const load = (rel) => import(pathToFileURL(path.join(ROOT, 'client/src/utils', rel)).href);
const d = (iso) => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); };
const ymd = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const asha = { userId: 2, fullName: 'Asha Rao', employeeId: 'RS002', designation: 'Engineer' };

async function machine() {
    const { initialScheduleState, scheduleReducer } = await load('shiftScheduleState.js');
    const { getViewRange } = await load('shiftViews.js');
    const today = d('2026-10-23');
    let state = initialScheduleState(today);
    const send = (action) => { state = scheduleReducer(state, { today, ...action }); return state; };
    const range = () => { const r = getViewRange(state.view, state.anchor); return [r.start, r.end]; };
    return { send, range, get state() { return state; } };
}

test('initial state: Week of today, everyone, search closed', async () => {
    const m = await machine();
    assert.equal(m.state.view, 'week');
    assert.deepEqual(m.range(), ['2026-10-19', '2026-10-25']);
    assert.equal(m.state.employee, null);
    assert.equal(m.state.searchOpen, false);
});

test('selecting an employee closes the search panel and does NOT touch the view or the date range', async () => {
    const m = await machine();
    m.send({ type: 'setView', view: 'month' });
    m.send({ type: 'pickDate', value: '2026-02-14' });
    m.send({ type: 'openSearch' });
    const before = { view: m.state.view, range: m.range() };
    m.send({ type: 'selectEmployee', employee: asha });
    assert.equal(m.state.searchOpen, false, 'results panel dismissed');
    assert.equal(m.state.employee.userId, 2);
    assert.deepEqual({ view: m.state.view, range: m.range() }, before);
    assert.deepEqual(m.range(), ['2026-02-01', '2026-02-28']);
});

test('clearing the employee restores everyone for the SAME view and range', async () => {
    const m = await machine();
    m.send({ type: 'selectEmployee', employee: asha });
    m.send({ type: 'setView', view: 'month' });
    m.send({ type: 'step', direction: 1 });
    const before = { view: m.state.view, range: m.range() };
    m.send({ type: 'clearEmployee' });
    assert.equal(m.state.employee, null);
    assert.deepEqual({ view: m.state.view, range: m.range() }, before);
    assert.deepEqual(m.range(), ['2026-11-01', '2026-11-30']);
});

test('the employee survives every view change, Previous/Next and date-picker move', async () => {
    const m = await machine();
    m.send({ type: 'selectEmployee', employee: asha });
    const moves = [
        { type: 'setView', view: 'day' }, { type: 'setView', view: 'week' }, { type: 'setView', view: 'month' },
        { type: 'step', direction: 1 }, { type: 'step', direction: -1 }, { type: 'step', direction: -1 },
        { type: 'pickDate', value: '2026-12-31' }, { type: 'step', direction: 1 }, { type: 'setView', view: 'week' },
        { type: 'pickDate', value: '2028-02-29' }, { type: 'setView', view: 'day' }, { type: 'step', direction: -1 },
        { type: 'openSearch' }, { type: 'closeSearch' },
    ];
    for (const move of moves) { m.send(move); assert.equal(m.state.employee.userId, 2, JSON.stringify(move)); }
});

test('Day, Week and Month ranges follow the shared date through navigation, leap years and the new year', async () => {
    const m = await machine();
    m.send({ type: 'setView', view: 'day' });
    assert.deepEqual(m.range(), ['2026-10-23', '2026-10-23'], 'Day lands on today');
    m.send({ type: 'pickDate', value: '2026-12-31' }); m.send({ type: 'step', direction: 1 });
    assert.deepEqual(m.range(), ['2027-01-01', '2027-01-01']);
    m.send({ type: 'setView', view: 'week' });
    assert.deepEqual(m.range(), ['2026-12-28', '2027-01-03'], 'Monday-Sunday week across the new year');
    m.send({ type: 'pickDate', value: '2028-02-10' }); m.send({ type: 'setView', view: 'month' });
    assert.deepEqual(m.range(), ['2028-02-01', '2028-02-29'], 'leap February');
    m.send({ type: 'pickDate', value: '2026-01-31' }); m.send({ type: 'step', direction: 1 });
    assert.deepEqual(m.range(), ['2026-02-01', '2026-02-28'], 'Jan 31 + 1 month is February');
});

test('empty or invalid picker values and unknown actions change nothing', async () => {
    const m = await machine();
    const before = m.state;
    for (const value of ['', null, undefined, 'nope', '2026-02-30']) assert.equal(m.send({ type: 'pickDate', value }), before, String(value));
    assert.equal(m.send({ type: 'whatever' }), before);
    assert.equal(m.send({ type: 'setView', view: 'week' }), before, 'same view is a no-op');
});

test('request guard: only the latest request may apply its answer; cancelAll invalidates everything in flight', async () => {
    const { createRequestGuard } = await load('shiftScheduleState.js');
    const guard = createRequestGuard();
    const first = guard.begin();
    const second = guard.begin();
    assert.equal(guard.isCurrent(first), false, 'the older request is stale');
    assert.equal(guard.isCurrent(second), true);
    guard.cancelAll();
    assert.equal(guard.isCurrent(second), false, 'cancelAll drops what was in flight');
    assert.equal(guard.isCurrent(guard.begin()), true);

    // out-of-order answers: the slow first answer must not overwrite the fast second one
    const g = createRequestGuard();
    let shown = null;
    const request = (label, ms) => { const id = g.begin(); return new Promise((r) => setTimeout(r, ms)).then(() => { if (g.isCurrent(id)) shown = label; }); };
    await Promise.all([request('slow-first', 40), request('fast-second', 5)]);
    assert.equal(shown, 'fast-second');
});

test('rows: everyone with my row first; a filtered employee ALWAYS gets a row, even when GET /employees did not return them', async () => {
    const { buildScheduleRows } = await load('shiftScheduleState.js');
    const employees = [
        { id: 3, full_name: 'Bilal Khan', designation: 'Designer' },
        { id: 1, full_name: 'Admin User', designation: 'Founder' },
        { id: 2, full_name: 'Asha Rao', designation: 'Engineer' },
    ];
    const shifts = [{ id: 11, user_id: 2, full_name: 'Asha Rao', shift_date: '2026-10-21', status: 'working' }];
    const all = buildScheduleRows({ employees, shifts, currentUserId: 1, selectedEmployee: null });
    assert.deepEqual(all.map((r) => r.fullName), ['Admin User', 'Asha Rao', 'Bilal Khan']);
    assert.equal(all[0].isSelf, true);
    assert.equal(all[1].days['2026-10-21'].id, 11);

    const filtered = buildScheduleRows({ employees, shifts, currentUserId: 1, selectedEmployee: asha });
    assert.deepEqual(filtered.map((r) => r.userId), [2], 'only the selected employee');

    const shafiq = { userId: 9, fullName: 'Shafiq Mohammad', employeeId: 'RS005', designation: 'Director' };
    const notListed = buildScheduleRows({ employees, shifts: [], currentUserId: 1, selectedEmployee: shafiq });
    assert.equal(notListed.length, 1, 'never an empty table for a valid employee');
    assert.equal(notListed[0].fullName, 'Shafiq Mohammad');
    assert.equal(notListed[0].designation, 'Director');

    // a live update for an employee not in the list arrives without a name: the selection supplies it
    const bare = buildScheduleRows({ employees: [], shifts: [{ id: 5, user_id: 9, shift_date: '2026-10-22' }], currentUserId: 1, selectedEmployee: shafiq });
    assert.equal(bare[0].fullName, 'Shafiq Mohammad');
    assert.equal(bare[0].days['2026-10-22'].id, 5);
});

test('chip text and search-result mapping', async () => {
    const { filterChipText, employeeLabel, employeeFromSearchResult, showsDayDetail } = await load('shiftScheduleState.js');
    assert.equal(filterChipText({ fullName: 'Shafiq Mohammad', employeeId: 'RS005' }), 'Filtered: Shafiq Mohammad (RS005)');
    assert.equal(employeeLabel({ fullName: 'No Id' }), 'No Id');
    assert.deepEqual(employeeFromSearchResult({ userId: 9, fullName: 'Shafiq', employeeId: 'RS005', designation: 'Director', status: 'off', departmentName: 'X' }),
        { userId: 9, fullName: 'Shafiq', employeeId: 'RS005', designation: 'Director' });
    assert.equal(showsDayDetail('day'), true);
    assert.equal(showsDayDetail('week'), false);
    assert.equal(showsDayDetail('month'), false);
    assert.ok(ymd(d('2026-10-23')) === '2026-10-23');
});
