// MOCKED backend used only by the rendered Shift Management page test. It is an in-memory model of what the
// shift/employee endpoints return -- NOT PostgreSQL and NOT the real controller (the real controller is
// covered separately in _test_shift_employee_filter.js). Everything the page sends is recorded in `calls`.
const DEFAULT_EMPLOYEES = [
    { id: 1, full_name: 'Admin User', designation: 'Founder', employment_status: 'active', employee_id: 'RS001' },
    { id: 2, full_name: 'Asha Rao', designation: 'Engineer', employment_status: 'active', employee_id: 'RS002' },
    { id: 3, full_name: 'Bilal Khan', designation: 'Designer', employment_status: 'active', employee_id: 'RS003' },
    { id: 4, full_name: 'Chitra Nair', designation: 'Analyst', employment_status: 'active', employee_id: 'RS004' },
];
// GET /employees lists role='employee' accounts only, while search finds any active user
const EXTRA_SEARCHABLE = [
    { id: 9, full_name: 'Shafiq Mohammad', designation: 'Director', employment_status: 'active', employee_id: 'RS005' },
];
const shift = (id, user_id, shift_date, start_time = '09:00', end_time = '18:00', status = 'working') =>
    ({ id, user_id, shift_date, status, start_time, end_time, notes: null });

export function makeBackend() {
    return {
        employees: DEFAULT_EMPLOYEES.map((e) => ({ ...e })),
        searchable: [...DEFAULT_EMPLOYEES, ...EXTRA_SEARCHABLE].map((e) => ({ ...e })),
        store: [
            shift(1, 1, '2026-10-23'),
            shift(11, 2, '2026-10-21'),
            shift(12, 2, '2026-10-27'),
            shift(22, 3, '2026-10-21', '10:00', '19:00'),
            shift(23, 3, '2026-10-05', '10:00', '19:00'),
        ],
        calls: [],
        // [{ match(call) -> boolean, delay: ms, status?: string }]
        rules: [],
        failNext: 0,
        nextId: 100,
    };
}

export const backend = () => globalThis.__backend;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = (call) => backend().rules.find((r) => r.match(call));

export async function getShifts(startDate, endDate, extra = {}) {
    const call = { type: 'getShifts', startDate, endDate, userId: extra.userId };
    backend().calls.push(call);
    const r = rule(call);
    if (r && r.delay) await sleep(r.delay);
    if (backend().failNext > 0) { backend().failNext -= 1; throw { response: { data: { message: 'boom' } } }; }
    const rows = backend().store
        .filter((s) => s.shift_date >= startDate && s.shift_date <= endDate)
        .filter((s) => extra.userId === undefined || Number(s.user_id) === Number(extra.userId))
        .map((s) => {
            const who = backend().searchable.find((e) => e.id === s.user_id);
            return { ...s, status: (r && r.status) || s.status, full_name: who?.full_name, designation: who?.designation };
        });
    return { success: true, shifts: rows, defaultOffDates: [] };
}

export async function searchShiftEmployees(q, date) {
    const call = { type: 'search', q, date };
    backend().calls.push(call);
    const r = rule(call);
    if (r && r.delay) await sleep(r.delay);
    const needle = q.toLowerCase();
    const results = backend().searchable
        .filter((e) => e.full_name.toLowerCase().includes(needle) || e.employee_id.toLowerCase().includes(needle))
        .map((e) => ({
            userId: e.id, fullName: e.full_name, employeeId: e.employee_id, designation: e.designation,
            departmentName: 'Ops', shiftDate: date, status: 'working', startTime: '09:00', endTime: '18:00', isDefaultOff: false,
        }));
    return { success: true, date, results };
}

export async function createShift(payload) {
    backend().calls.push({ type: 'create', ...payload });
    const duplicate = backend().store.some((s) => Number(s.user_id) === Number(payload.userId) && s.shift_date === payload.shiftDate);
    if (duplicate) throw { response: { status: 409, data: { message: 'A shift already exists for this employee and date.' } } };
    const row = shift(backend().nextId++, Number(payload.userId), payload.shiftDate, payload.startTime, payload.endTime, payload.status);
    backend().store.push(row);
    return { success: true, shift: row };
}

export async function updateShift(id, changes) {
    backend().calls.push({ type: 'update', id, ...changes });
    return { success: true };
}

export async function deleteShift(id) {
    backend().calls.push({ type: 'delete', id });
    return { success: true };
}

export async function bulkSaveShifts(entries) {
    backend().calls.push({ type: 'bulk', count: entries.length });
    return { success: true, message: 'ok' };
}

export const employeesResponse = () => ({ data: { employees: backend().employees } });

// Reports panel: records the request and returns a tiny stand-in file (the real workbook is covered by
// _test_shift_report.js against the real service/controller).
export async function exportShiftReport(period, employee = 'all') {
    backend().calls.push({ type: 'export', period, employee });
    if (backend().exportFails) throw { response: { data: new Blob([JSON.stringify({ message: 'Only Admin/Super Admin can export shift reports.' })]) } };
    return { blob: new Blob(['xlsx']), filename: `Employee_Shift_Report_${{ day: 'Daily', week: 'Weekly', month: 'Monthly' }[period]}${employee === 'all' ? '' : '_EMP' + employee}.xlsx` };
}
