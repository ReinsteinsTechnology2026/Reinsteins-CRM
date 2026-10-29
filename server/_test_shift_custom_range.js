// Shift Management: Custom range + month/year picker logic. The 92-day maximum is enforced by the client UI only;
// the shift API has no maximum range (it rejects only impossible dates and a start date after the end date).
// No database, no network, nothing production:
//   - client/src/utils/shiftViews.js and shiftScheduleState.js are imported and run for real (the time-zone checks
//     run in child processes, because TZ is fixed at process start);
//   - GET /api/shifts is driven through the real controller with pool.query replaced by a counter, so a rejected
//     range is shown to reach no query at all;
//   - AdminShiftManagement.jsx is read statically only to pin wiring that cannot be seen from pure functions
//     (the rendered behaviour is covered in _test_shift_page_rendered.js).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const db = require('./config/db');
const { isRealCalendarDate } = require('./utils/shiftDefaults');
const shiftController = require('./controllers/shiftScheduleController');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const VIEWS_PATH = path.join(ROOT, 'client/src/utils/shiftViews.js');
const STATE_PATH = path.join(ROOT, 'client/src/utils/shiftScheduleState.js');
const page = read('client/src/pages/Admin/AdminShiftManagement.jsx');

const views = () => import(pathToFileURL(VIEWS_PATH).href);
const state = () => import(pathToFileURL(STATE_PATH).href);
const d = (iso) => { const [y, m, day] = iso.split('-').map(Number); return new Date(y, m - 1, day); };

// ---------------------------------------------------------------- range validation
test('Custom range limit: exactly 92 days (both ends included) is valid, 93 is not -- leap years and month/year boundaries', async () => {
    const { validateCustomRange, inclusiveDayCount, MAX_CUSTOM_RANGE_DAYS } = await views();
    assert.equal(MAX_CUSTOM_RANGE_DAYS, 92);
    const cases = [
        ['2026-01-01', '2026-04-02', true, 92],   // 31 + 28 + 31 + 2
        ['2026-01-01', '2026-04-03', false, 93],
        ['2028-01-01', '2028-04-01', true, 92],   // leap year: 31 + 29 + 31 + 1
        ['2028-01-01', '2028-04-02', false, 93],
        ['2026-03-01', '2026-05-31', true, 92],   // March + April + May
        ['2026-03-01', '2026-06-01', false, 93],
        ['2026-10-23', '2026-10-23', true, 1],    // a single day
        ['2026-12-20', '2027-01-10', true, 22],   // across the year
        ['2028-02-27', '2028-03-02', true, 5],    // across 29 February
        ['2026-02-27', '2026-03-02', true, 4],    // no 29 February
    ];
    for (const [start, end, valid, days] of cases) {
        assert.equal(inclusiveDayCount(start, end), days, `${start}..${end}`);
        const result = validateCustomRange(start, end);
        assert.equal(result.valid, valid, `${start}..${end}`);
        if (valid) assert.equal(result.days, days);
        else assert.equal(result.code, 'too_long');
    }
});

test('Custom range validation: missing, reversed, unreal and oversized dates each give their own code and message', async () => {
    const { validateCustomRange } = await views();
    const codeOf = (start, end) => { const r = validateCustomRange(start, end); return r.valid ? 'ok' : r.code; };
    for (const [start, end] of [[undefined, undefined], [null, null], ['', '']]) assert.equal(codeOf(start, end), 'missing_both');
    assert.equal(codeOf('', '2026-10-01'), 'missing_start');
    assert.equal(codeOf(undefined, '2026-10-01'), 'missing_start');
    assert.equal(codeOf('2026-10-01', ''), 'missing_end');
    assert.equal(codeOf('2026-10-01', null), 'missing_end');
    assert.equal(codeOf('2026-02-02', '2026-02-01'), 'end_before_start');
    assert.equal(codeOf('2027-01-01', '2026-12-31'), 'end_before_start');
    for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', 'abc', '2026-1-1', '26-01-01', '2026/01/01', '0001-01-01', 20260101]) {
        assert.equal(codeOf(bad, '2026-12-31'), 'invalid_date', String(bad));
        assert.equal(codeOf('2026-01-01', bad), 'invalid_date', String(bad));
    }
    assert.equal(codeOf('2026-02-29', '2026-03-01'), 'invalid_date', '2026 is not a leap year');
    assert.equal(codeOf('2028-02-29', '2028-03-01'), 'ok', '2028 is');

    assert.equal(validateCustomRange('', '').message, 'Choose a start date and an end date.');
    assert.equal(validateCustomRange('', '2026-10-01').message, 'Choose a start date.');
    assert.equal(validateCustomRange('2026-10-01', '').message, 'Choose an end date.');
    assert.equal(validateCustomRange('2026-02-02', '2026-02-01').message, 'The start date cannot be after the end date.');
    assert.equal(validateCustomRange('2026-01-01', '2026-04-03').message, 'That range is 93 days. Choose at most 92 days (about 3 months).');
    assert.equal(validateCustomRange('2026-01-01', '2026-01-10', 5).code, 'too_long', 'the limit is a parameter');
});

test('getViewRange for a custom range: every date from start to end, or no dates and a reason', async () => {
    const { getViewRange } = await views();
    const anchor = d('2026-10-23');

    const wide = getViewRange('range', anchor, { start: '2026-12-29', end: '2027-01-03' });
    assert.deepEqual(wide.dates, ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
    assert.deepEqual([wide.start, wide.end, wide.valid], ['2026-12-29', '2027-01-03', true]);

    const leap = getViewRange('range', anchor, { start: '2028-02-27', end: '2028-03-01' });
    assert.deepEqual(leap.dates, ['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);

    const max = getViewRange('range', anchor, { start: '2026-01-01', end: '2026-04-02' });
    assert.equal(max.dates.length, 92);
    assert.equal(max.dates[0], '2026-01-01'); assert.equal(max.dates[91], '2026-04-02');
    assert.equal(new Set(max.dates).size, 92, 'no date twice');

    for (const custom of [undefined, {}, { start: '', end: '' }, { start: '2026-01-01', end: '' }, { start: '2026-05-01', end: '2026-04-01' }, { start: '2026-01-01', end: '2026-04-03' }]) {
        const r = getViewRange('range', anchor, custom);
        assert.equal(r.valid, false, JSON.stringify(custom));
        assert.deepEqual([r.dates, r.start, r.end], [[], null, null], 'an invalid range has no dates and nothing to request');
        assert.ok(r.error && r.code);
    }

    // the other views are unchanged and always valid
    for (const view of ['day', 'week', 'month']) assert.equal(getViewRange(view, anchor).valid, true, view);
    assert.deepEqual(getViewRange('month', d('2028-02-10')).dates.length, 29);
});

test('labels for a custom range: dates with the year, a single day once, and a clear empty state', async () => {
    const { formatRangeLabel, formatCustomRangeLabel, filterSummary, VIEW_LABELS, NAV_LABELS, VIEW_RANGE } = await views();
    assert.equal(VIEW_RANGE, 'range');
    assert.match(formatCustomRangeLabel('2026-10-19', '2026-12-25'), /^19 Oct 2026 - 25 Dec 2026$/);
    assert.match(formatCustomRangeLabel('2026-10-19', '2026-10-19'), /^19 Oct 2026$/);
    assert.match(formatRangeLabel('range', d('2026-10-23'), 'en-IN', { start: '2026-05-01', end: '2026-05-10' }), /^1 May 2026 - 10 May 2026$/);
    // the caption never says "No dates selected" when dates ARE there: only the cause differs
    const label = (start, end) => formatRangeLabel('range', d('2026-10-23'), 'en-IN', { start, end });
    assert.equal(label('', ''), 'No dates selected');
    assert.equal(label(undefined, undefined), 'No dates selected');
    assert.equal(label('2026-05-01', ''), 'Choose both dates', 'only the start date is there');
    assert.equal(label('', '2026-05-10'), 'Choose both dates', 'only the end date is there');
    assert.equal(label('2026-05-01', '2026-04-01'), 'Dates not valid', 'reversed');
    assert.equal(label('2026-01-01', '2026-04-03'), 'Dates not valid', '93 days');
    assert.equal(label('2026-02-31', '2026-03-05'), 'Dates not valid', 'a date that does not exist');
    assert.equal(label('abc', '2026-03-05'), 'Dates not valid');
    const { invalidCustomRangeLabel } = await views();
    assert.deepEqual(['missing_both', 'missing_start', 'missing_end', 'end_before_start', 'too_long', 'invalid_date', 'anything-else'].map(invalidCustomRangeLabel),
        ['No dates selected', 'Choose both dates', 'Choose both dates', 'Dates not valid', 'Dates not valid', 'Dates not valid', 'Dates not valid']);
    assert.match(filterSummary('range', d('2026-10-23'), { fullName: 'Asha Rao', employeeId: 'EMP002' }, { start: '2026-05-01', end: '2026-05-10' }), /^Custom range 1 May 2026 - 10 May 2026: Asha Rao \(EMP002\)$/);
    assert.equal(VIEW_LABELS.range, 'Custom range');
    assert.deepEqual(Object.keys(NAV_LABELS).sort(), ['day', 'month', 'week'], 'a custom range has no Previous/Next');
});

// ---------------------------------------------------------------- month / year picker + reducer
test('month picker helpers: twelve labels in calendar order and the supported year span', async () => {
    const { monthShortLabels, MIN_PICKER_YEAR, MAX_PICKER_YEAR } = await views();
    const labels = monthShortLabels();
    assert.equal(labels.length, 12);
    assert.equal(new Set(labels).size, 12);
    assert.match(labels[0], /^Jan/); assert.match(labels[9], /^Oct/); assert.match(labels[11], /^Dec/);
    assert.deepEqual([MIN_PICKER_YEAR, MAX_PICKER_YEAR], [2000, 2100]);
});

test('choosing a month: Month view, the whole month (28/29/30/31 days), and the employee filter untouched', async () => {
    const { initialScheduleState, scheduleReducer } = await state();
    const { getViewRange } = await views();
    const asha = { userId: 2, fullName: 'Asha Rao', employeeId: 'EMP002' };
    let s = scheduleReducer(initialScheduleState(d('2026-10-23')), { type: 'selectEmployee', employee: asha });
    const rangeOf = () => { const r = getViewRange(s.view, s.anchor, s.custom); return [r.start, r.end, r.dates.length]; };

    s = scheduleReducer(s, { type: 'pickMonth', year: 2028, month: 1 });
    assert.equal(s.view, 'month'); assert.deepEqual(rangeOf(), ['2028-02-01', '2028-02-29', 29], 'leap February');
    s = scheduleReducer(s, { type: 'pickMonth', year: 2027, month: 1 });
    assert.deepEqual(rangeOf(), ['2027-02-01', '2027-02-28', 28], 'ordinary February');
    s = scheduleReducer(s, { type: 'pickMonth', year: 2026, month: 3 });
    assert.deepEqual(rangeOf(), ['2026-04-01', '2026-04-30', 30]);
    s = scheduleReducer(s, { type: 'pickMonth', year: 2026, month: 11 });
    assert.deepEqual(rangeOf(), ['2026-12-01', '2026-12-31', 31]);
    s = scheduleReducer(s, { type: 'step', direction: 1 });
    assert.deepEqual(rangeOf(), ['2027-01-01', '2027-01-31', 31], 'Next month crosses the year');
    s = scheduleReducer(s, { type: 'step', direction: -1 }); s = scheduleReducer(s, { type: 'step', direction: -1 });
    assert.deepEqual(rangeOf(), ['2026-11-01', '2026-11-30', 30], 'Previous month crosses back');
    assert.deepEqual(s.employee, asha, 'the employee filter survived every pick');

    // the first and the last supported month work; anything outside is ignored
    s = scheduleReducer(s, { type: 'pickMonth', year: 2000, month: 0 }); assert.deepEqual(rangeOf().slice(0, 2), ['2000-01-01', '2000-01-31']);
    s = scheduleReducer(s, { type: 'pickMonth', year: 2100, month: 11 }); assert.deepEqual(rangeOf().slice(0, 2), ['2100-12-01', '2100-12-31']);
    const before = s;
    for (const bad of [{ year: 1999, month: 0 }, { year: 2101, month: 0 }, { year: 2026, month: -1 }, { year: 2026, month: 12 }, { year: 2026.5, month: 3 }, { year: 'x', month: 3 }, { year: 2026, month: undefined }, {}]) {
        assert.equal(scheduleReducer(before, { type: 'pickMonth', ...bad }), before, JSON.stringify(bad));
    }
});

test('Custom range state: prefilled from what is on screen, kept across views, partial edits, bad values ignored', async () => {
    const { initialScheduleState, scheduleReducer } = await state();
    const { getViewRange } = await views();
    const asha = { userId: 2, fullName: 'Asha Rao', employeeId: 'EMP002' };
    const today = d('2026-10-23');
    let s = scheduleReducer(initialScheduleState(today), { type: 'selectEmployee', employee: asha });

    assert.deepEqual(s.custom, { start: '', end: '' });
    // first time: starts from the visible week, so the dates are never blank
    s = scheduleReducer(s, { type: 'setView', view: 'range', today });
    assert.equal(s.view, 'range'); assert.deepEqual(s.custom, { start: '2026-10-19', end: '2026-10-25' });
    assert.deepEqual(s.employee, asha, 'switching to Custom range keeps the employee');

    // partial edits
    s = scheduleReducer(s, { type: 'setCustomRange', start: '2026-09-01' });
    assert.deepEqual(s.custom, { start: '2026-09-01', end: '2026-10-25' });
    s = scheduleReducer(s, { type: 'setCustomRange', end: '2026-11-30' });
    assert.deepEqual(s.custom, { start: '2026-09-01', end: '2026-11-30' });
    s = scheduleReducer(s, { type: 'setCustomRange', end: '' });
    assert.deepEqual(s.custom, { start: '2026-09-01', end: '' });
    s = scheduleReducer(s, { type: 'setCustomRange', end: undefined, start: 20260101 });
    assert.deepEqual(s.custom, { start: '', end: '' }, 'anything that is not a string counts as not chosen');
    s = scheduleReducer(s, { type: 'step', direction: 1 });
    assert.equal(s.view, 'range'); assert.deepEqual(s.custom, { start: '', end: '' }, 'step is a no-op for a custom range');

    // leaving Custom range with a valid range: Week/Month show where it STARTS, Day its first day (or today when inside)
    const custom = (start, end) => ({ ...s, view: 'range', custom: { start, end } });
    const rangeOf = (st) => { const r = getViewRange(st.view, st.anchor, st.custom); return [r.start, r.end]; };
    assert.deepEqual(rangeOf(scheduleReducer(custom('2026-05-01', '2026-05-10'), { type: 'setView', view: 'month', today })), ['2026-05-01', '2026-05-31']);
    assert.deepEqual(rangeOf(scheduleReducer(custom('2026-05-06', '2026-05-30'), { type: 'setView', view: 'week', today })), ['2026-05-04', '2026-05-10']);
    assert.deepEqual(rangeOf(scheduleReducer(custom('2026-05-06', '2026-05-30'), { type: 'setView', view: 'day', today })), ['2026-05-06', '2026-05-06']);
    assert.deepEqual(rangeOf(scheduleReducer(custom('2026-10-01', '2026-10-31'), { type: 'setView', view: 'day', today })), ['2026-10-23', '2026-10-23'], 'today is inside the range');
    // an incomplete range keeps the old anchor instead of inventing one
    const half = scheduleReducer({ ...s, view: 'range', anchor: d('2026-03-15'), custom: { start: '2026-05-01', end: '' } }, { type: 'setView', view: 'month', today });
    assert.deepEqual(rangeOf(half), ['2026-03-01', '2026-03-31']);
    // and the custom dates are still there when coming back
    const back = scheduleReducer(scheduleReducer(custom('2026-05-01', '2026-05-10'), { type: 'setView', view: 'week', today }), { type: 'setView', view: 'range', today });
    assert.deepEqual(back.custom, { start: '2026-05-01', end: '2026-05-10' });
    assert.deepEqual(back.employee, asha);
});

test('the request for a custom range is exactly its dates, plus the employee when one is selected', async () => {
    const { getViewRange, buildShiftQuery } = await views();
    const range = getViewRange('range', d('2026-10-23'), { start: '2026-09-01', end: '2026-11-30' });
    assert.deepEqual(buildShiftQuery(range, null), { startDate: '2026-09-01', endDate: '2026-11-30', extraParams: {} });
    assert.deepEqual(buildShiftQuery(range, 2), { startDate: '2026-09-01', endDate: '2026-11-30', extraParams: { userId: 2 } });
});

// ---------------------------------------------------------------- time zones
test('custom ranges, month picks and day counts are identical in every time zone, across daylight-saving changes', () => {
    const script = `
        Promise.all([import(${JSON.stringify(pathToFileURL(VIEWS_PATH).href)}), import(${JSON.stringify(pathToFileURL(STATE_PATH).href)})]).then(([v, st]) => {
            const r = (start, end) => { const x = v.getViewRange('range', new Date(), { start, end }); return [x.valid, x.dates.length, x.dates[0], x.dates[x.dates.length - 1]]; };
            let s = st.scheduleReducer(st.initialScheduleState(new Date(2026, 9, 23)), { type: 'pickMonth', year: 2028, month: 1 });
            const feb = v.getViewRange(s.view, s.anchor);
            console.log(JSON.stringify({
                tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
                usDst: r('2026-03-07', '2026-03-09'), euDst: r('2026-03-28', '2026-03-30'), nzDst: r('2026-04-04', '2026-04-06'), nzSpring: r('2026-09-26', '2026-09-28'),
                max: r('2026-01-01', '2026-04-02'), over: r('2026-01-01', '2026-04-03'), leap: r('2028-02-28', '2028-03-01'),
                days: [v.inclusiveDayCount('2026-03-08', '2026-03-08'), v.inclusiveDayCount('2026-03-01', '2026-03-31'), v.inclusiveDayCount('2026-09-20', '2026-09-30'), v.inclusiveDayCount('2026-01-01', '2026-04-02')],
                feb: [feb.start, feb.end, feb.dates.length],
                label: v.formatCustomRangeLabel('2026-10-01', '2026-12-31'),
            }));
        });`;
    const names = { 'Asia/Kolkata': ['Asia/Kolkata', 'Asia/Calcutta'], UTC: ['UTC', 'Etc/UTC'], 'Pacific/Auckland': ['Pacific/Auckland'], 'America/Los_Angeles': ['America/Los_Angeles'], 'Europe/London': ['Europe/London'] };
    for (const tz of Object.keys(names)) {
        const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: tz }, encoding: 'utf8' }).trim().split('\n').pop());
        assert.ok(names[tz].includes(out.tz), `ran in ${tz} (reported ${out.tz})`);
        assert.deepEqual(out.usDst, [true, 3, '2026-03-07', '2026-03-09'], `${tz}: US clocks change on 8 March`);
        assert.deepEqual(out.euDst, [true, 3, '2026-03-28', '2026-03-30'], `${tz}: Europe changes on 29 March`);
        assert.deepEqual(out.nzDst, [true, 3, '2026-04-04', '2026-04-06'], `${tz}: New Zealand changes on 5 April`);
        assert.deepEqual(out.nzSpring, [true, 3, '2026-09-26', '2026-09-28'], `${tz}: New Zealand changes on 27 September`);
        assert.deepEqual(out.max, [true, 92, '2026-01-01', '2026-04-02'], tz);
        assert.deepEqual(out.over, [false, 0, null, null], `${tz}: 93 days is not a range (no dates; JSON shows the missing ones as null)`);
        assert.deepEqual(out.leap, [true, 3, '2028-02-28', '2028-03-01'], tz);
        assert.deepEqual(out.days, [1, 31, 11, 92], tz);
        assert.deepEqual(out.feb, ['2028-02-01', '2028-02-29', 29], tz);
        assert.match(out.label, /^1 Oct 2026 - 31 Dec 2026$/, tz);
    }
});

// ---------------------------------------------------------------- the API limit (server)
test('the 92-day limit is a CLIENT rule only: the shift API has no maximum range', async () => {
    const { MAX_CUSTOM_RANGE_DAYS } = await views();
    assert.equal(MAX_CUSTOM_RANGE_DAYS, 92, 'the page still limits its own Custom range');
    const controller = read('server/controllers/shiftScheduleController.js');
    const defaults = read('server/utils/shiftDefaults.js');
    assert.ok(!/MAX_SHIFT_RANGE_DAYS|inclusiveRangeDays|too long|at most \d+ days/i.test(controller + defaults), 'no maximum, constant or message left on the server');
});

test('isRealCalendarDate: dates that exist (including 29 February in leap years) and dates that only look like dates', () => {
    for (const good of ['2026-10-23', '2026-01-01', '2026-12-31', '2028-02-29', '2000-02-29', '2026-04-30', '2026-03-08']) assert.equal(isRealCalendarDate(good), true, good);
    for (const bad of ['2026-02-31', '2026-02-29', '2100-02-29', '2026-13-01', '2026-00-01', '2026-04-31', '2026-06-31', '2026-01-00', '2026-01-32']) assert.equal(isRealCalendarDate(bad), false, bad);
});

function callGetShifts(query, access = { role: 'admin', systemAccess: 'super_admin' }) {
    let queries = 0;
    db.query = async () => { queries += 1; return [[]]; };

    const res = { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
    const req = { user: { id: 1 }, userAccess: access, query, params: {}, body: {}, app: { get: () => null } };

    return shiftController.getShifts(req, res).then(() => ({ status: res.statusCode, body: res.body, queries }));
}

test('GET /api/shifts: a range of ANY length is still answered (no server-side maximum -- other consumers are unknown); impossible dates are a 400 with no query', async () => {
    for (const [startDate, endDate, days] of [
        ['2026-10-23', '2026-10-23', 1], ['2026-10-19', '2026-10-25', 7], ['2026-10-01', '2026-10-31', 31], ['2028-02-01', '2028-02-29', 29],
        ['2026-01-01', '2026-04-02', 92], ['2026-01-01', '2026-04-03', 93], ['2026-01-01', '2026-12-31', 365], ['2026-01-01', '2027-12-31', 730],
    ]) {
        const r = await callGetShifts({ startDate, endDate });
        assert.equal(r.status, 200, `${startDate}..${endDate} (${days} days) must NOT be rejected`);
        assert.deepEqual([r.body.startDate, r.body.endDate], [startDate, endDate]);
        assert.equal(r.queries, 1);
    }

    for (const [startDate, endDate] of [['2026-02-31', '2026-03-05'], ['2026-03-01', '2026-04-31'], ['2026-13-01', '2026-13-02'], ['2026-02-29', '2026-03-02']]) {
        const r = await callGetShifts({ startDate, endDate });
        assert.equal(r.status, 400, `${startDate}..${endDate}`);
        assert.equal(r.body.message, 'Invalid date range. Use YYYY-MM-DD for startDate and endDate.');
        assert.equal(r.queries, 0);
    }
});

test('GET /api/shifts: the existing validation and the default week are unchanged', async () => {
    let r = await callGetShifts({ startDate: '2026-10-25', endDate: '2026-10-19' });
    assert.equal(r.status, 400); assert.equal(r.body.message, 'startDate must not be after endDate.'); assert.equal(r.queries, 0);

    r = await callGetShifts({ startDate: '2026/10/19', endDate: '2026-10-25' });
    assert.equal(r.status, 400); assert.equal(r.body.message, 'Invalid date range. Use YYYY-MM-DD for startDate and endDate.');

    r = await callGetShifts({});
    assert.equal(r.status, 200, 'no dates = the current week');
    const utc = (iso) => Date.UTC(...iso.split('-').map((n, i) => (i === 1 ? Number(n) - 1 : Number(n))));
    assert.equal((utc(r.body.endDate) - utc(r.body.startDate)) / 86400000 + 1, 7);

    // role-based visibility is decided after the date checks and is not touched by them
    r = await callGetShifts({ startDate: '2026-10-01', endDate: '2026-10-31' }, { role: 'employee', systemAccess: 'employee' });
    assert.equal(r.status, 200);
    r = await callGetShifts({ startDate: '2026-01-01', endDate: '2026-12-31' }, { role: 'employee', systemAccess: 'employee' });
    assert.equal(r.status, 200, 'a long range is no more rejected for a plain employee than for an admin');
    r = await callGetShifts({ startDate: '2026-02-31', endDate: '2026-03-05' }, { role: 'employee', systemAccess: 'employee' });
    assert.equal(r.status, 400, 'an impossible date is rejected for every role alike');
});

// ---------------------------------------------------------------- page wiring (static; behaviour is in the rendered tests)
test('page wiring: an invalid range is never requested, Copy Previous Week is disabled for it, and no new endpoint appears', () => {
    assert.match(page, /if \(!wanted\.valid\) return;/, 'loadSchedule refuses an invalid range (also for a socket reconnect or a reload after a save)');
    assert.match(page, /if \(!range\.valid\) \{[\s\S]*scheduleGuardRef\.current\.cancelAll\(\);[\s\S]*setShifts\(\[\]\);/, 'an invalid range drops whatever was in flight and shows no stale rows');
    assert.match(page, /disabled=\{copying \|\| isCustomRange\}/);
    assert.match(page, /if \(view === VIEW_RANGE\) return;/, 'the copy handler itself also refuses');
    assert.match(page, /Copy Previous Week works on one week at a time\. Switch to Day, Week or Month view to use it\./);
    assert.match(page, /name="rangeStart"/); assert.match(page, /name="rangeEnd"/);
    assert.match(page, /Up to \{MAX_CUSTOM_RANGE_DAYS\} days/);
    assert.match(page, /import MonthYearPicker from "\.\.\/\.\.\/components\/MonthYearPicker"/);
    assert.match(page, /onClick=\{\(\) => handleViewButton\(option\.value\)\}/, 'the Month button opens the picker');
    const endpoints = [...page.matchAll(/api\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => `${m[1]} ${m[2]}`);
    assert.deepEqual(endpoints, ['get /employees'], 'no new endpoint');
    assert.ok(!/\.toISOString\(/.test(page) && !/\.toISOString\(/.test(read('client/src/utils/shiftViews.js')), 'no UTC date building');
    assert.ok(!/^import .*EmployeeShiftSchedule/m.test(page), 'the employee page is not involved');
});

test('scope: the employee page and the Excel export are untouched', () => {
    const service = read('client/src/services/shiftScheduleService.js');
    assert.match(service, /export const exportShiftReport = async \(period, employee = "all"\)/, 'export still takes only a period and an employee');
    assert.ok(!/shiftViews|MonthYearPicker/.test(read('client/src/pages/Employee/EmployeeShiftSchedule.jsx')));
    assert.ok(!/MAX_SHIFT_RANGE_DAYS|inclusiveRangeDays/.test(read('server/controllers/shiftReportController.js')));
    assert.match(page, /Excel report for this week \(Mon-Sun\)/, 'the reports panel keeps its fixed periods');
});
