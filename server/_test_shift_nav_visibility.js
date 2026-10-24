// Shift navigation / access tests. No database, no network, no browser, nothing production:
//   - the client helper (client/src/utils/shiftAccess.js) is imported and run for real;
//   - the sidebar menu arrays are evaluated from source with that real helper;
//   - the route guard decision is run for real;
//   - the REAL shift controller runs against in-memory fake pools (MOCKED -- they model what the
//     controller asks the database, not PostgreSQL itself);
//   - everything else is a static read of source files.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const employeeSidebar = read('client/src/components/Layout/EmployeeSidebar.jsx');
const adminSidebar = read('client/src/components/Layout/AdminSidebar.jsx');
const appSource = read('client/src/App.jsx');

let helperPromise;
const helper = () => (helperPromise ||= import(pathToFileURL(path.join(ROOT, 'client/src/utils/shiftAccess.js')).href));

// ---- access matrix used by several tests: every role/system_access value x several designations ----
const SYSTEM_ACCESS = [undefined, 'employee', 'team_lead', 'department_head', 'hr', 'executive', 'manager', 'admin', 'super_admin'];
const ROLES = ['employee', 'admin'];
const DESIGNATIONS = ['Founder', 'Chairman', 'CEO', 'CTO', 'Software Engineer', 'Intern', undefined];
const users = [];
for (const role of ROLES) for (const systemAccess of SYSTEM_ACCESS) for (const designation of DESIGNATIONS) users.push({ role, systemAccess, designation });
const expectedTier = (u) => (u.role === 'admin' || ['admin', 'super_admin'].includes(u.systemAccess) ? 'admin' : u.systemAccess === 'manager' ? 'manager' : 'employee');

// Evaluate one `const <name> = [ ... ];` menu array from the sidebar source with real inputs.
function menu(name, user, basePath = '/employee', flags = {}) {
  const match = employeeSidebar.match(new RegExp(`const ${name} = \\[\\n([\\s\\S]*?)\\n  \\];`));
  assert.ok(match, `${name} not found in EmployeeSidebar.jsx`);
  const body = match[1].replace(/icon:\s*<(\w+)\s*\/>/g, 'icon: "$1"');
  const build = new Function('basePath', 'showProjectsNavItem', 'hasTeamVisibility', 'shiftNav', `return [${body}];`);
  return helper().then(({ getShiftNavItem }) => build(basePath, Boolean(flags.projects), Boolean(flags.team), getShiftNavItem(user, basePath)));
}
const names = (items) => items.map((i) => i.name);
const SHIFT = new Set(['Shift Schedule', 'Shift Management']);
const shiftItem = (items) => {
  const found = items.filter((i) => SHIFT.has(i.name));
  assert.equal(found.length, 1, 'exactly one Shift entry');
  return { ...found[0] };
};

test('tier is decided by role/system_access only, and matches the backend rule for every combination', async () => {
  const { getShiftTier } = await helper();
  const server = require('./utils/shiftDefaults');
  for (const u of users) {
    assert.equal(getShiftTier(u), expectedTier(u), JSON.stringify(u));
    assert.equal(getShiftTier(u) === 'admin', server.isAdminTierUser(u), `admin parity ${JSON.stringify(u)}`);
    assert.equal(getShiftTier(u) === 'manager', server.isManagerTierUser(u), `manager parity ${JSON.stringify(u)}`);
  }
  assert.equal(getShiftTier(null), 'employee');
  assert.equal(getShiftTier({}), 'employee');
});

test('Shift entry per access level: admin tier -> Shift Management, everyone else -> Shift Schedule', async () => {
  const { getShiftNavItem } = await helper();
  const admin = { name: 'Shift Management', path: '/employee/shift-management' };
  const schedule = { name: 'Shift Schedule', path: '/employee/shift-schedule' };
  assert.deepEqual(getShiftNavItem({ role: 'admin' }, '/employee'), admin);
  assert.deepEqual(getShiftNavItem({ role: 'employee', systemAccess: 'admin' }, '/employee'), admin);
  assert.deepEqual(getShiftNavItem({ role: 'employee', systemAccess: 'super_admin' }, '/employee'), admin);
  assert.deepEqual(getShiftNavItem({ role: 'employee', systemAccess: 'manager' }, '/employee'), schedule);
  for (const sa of [undefined, 'employee', 'team_lead', 'department_head', 'hr', 'executive']) {
    assert.deepEqual(getShiftNavItem({ role: 'employee', systemAccess: sa }, '/employee'), schedule, String(sa));
  }
  // company-prefixed portal
  assert.deepEqual(getShiftNavItem({ role: 'employee', systemAccess: 'super_admin' }, '/acme/employee'),
    { name: 'Shift Management', path: '/acme/employee/shift-management' });
  assert.deepEqual(getShiftNavItem({ role: 'employee', systemAccess: 'employee' }, '/acme/employee'),
    { name: 'Shift Schedule', path: '/acme/employee/shift-schedule' });
});

test('designation never changes the Shift entry: identical access => identical entry, in BOTH menus', async () => {
  const { getShiftNavItem } = await helper();
  const byAccess = new Map();
  for (const u of users) {
    const key = `${u.role}|${u.systemAccess}`;
    const item = JSON.stringify(getShiftNavItem(u, '/employee'));
    if (byAccess.has(key)) assert.equal(item, byAccess.get(key), `designation changed the entry for ${key}: ${u.designation}`);
    else byAccess.set(key, item);
    // both menus, regardless of which one this user's designation selects
    const exec = shiftItem(await menu('executiveMenuItems', u));
    const standard = shiftItem(await menu('standardMenuItems', u));
    assert.equal(JSON.stringify({ name: exec.name, path: exec.path }), item);
    assert.equal(JSON.stringify({ name: standard.name, path: standard.path }), item);
    assert.equal(exec.icon, 'FaCalendarWeek');
    assert.equal(standard.icon, 'FaCalendarWeek');
  }
});

test('a Founder/Chairman with employee-level access gets NO elevated Shift entry; with admin access gets the admin entry', async () => {
  const { getShiftNavItem } = await helper();
  for (const designation of ['Founder', 'Chairman']) {
    for (const systemAccess of [undefined, 'employee', 'executive', 'hr', 'manager']) {
      assert.equal(getShiftNavItem({ role: 'employee', systemAccess, designation }, '/employee').name, 'Shift Schedule', `${designation}/${systemAccess}`);
    }
    for (const systemAccess of ['admin', 'super_admin']) {
      assert.equal(getShiftNavItem({ role: 'employee', systemAccess, designation }, '/employee').name, 'Shift Management', `${designation}/${systemAccess}`);
    }
  }
});

test('menus: only the Shift entry changed; position, other items and the designation-based menu selection are unchanged', async () => {
  const plain = { role: 'employee', systemAccess: 'employee' };
  assert.deepEqual(names(await menu('executiveMenuItems', plain)), [
    'Dashboard', 'Projects', 'Organization', 'Hierarchy', 'Reports', 'Approvals', 'Shift Schedule',
    'Chat', 'Email', 'Meetings', 'SOPs', 'My Profile', 'Settings']);
  assert.deepEqual(names(await menu('standardMenuItems', plain)), [
    'Dashboard', 'Attendance', 'Shift Schedule', 'My Tasks', 'My Leave', 'My Reporting Manager', 'Hierarchy',
    'My Profile', 'Chat', 'Email', 'Meetings', 'SOPs', 'Settings']);
  assert.deepEqual(names(await menu('standardMenuItems', plain, '/employee', { projects: true, team: true })), [
    'Dashboard', 'Attendance', 'Shift Schedule', 'My Tasks', 'Projects', 'My Leave', 'My Reporting Manager', 'Hierarchy',
    'My Team', 'Team Leave Approvals', 'My Profile', 'Chat', 'Email', 'Meetings', 'SOPs', 'Settings']);
  // admin tier: same lists, only the Shift label differs
  const admin = { role: 'employee', systemAccess: 'super_admin' };
  assert.deepEqual(names(await menu('executiveMenuItems', admin)).map((n) => (n === 'Shift Management' ? 'Shift Schedule' : n)),
    names(await menu('executiveMenuItems', plain)));
  assert.deepEqual(names(await menu('standardMenuItems', admin)).map((n) => (n === 'Shift Management' ? 'Shift Schedule' : n)),
    names(await menu('standardMenuItems', plain)));
  // executive-menu selection is still the existing designation check (explicitly unchanged in this task)
  assert.match(employeeSidebar, /const isExecutive = isExecutiveDashboardUser\(currentUser\);/);
  assert.match(employeeSidebar, /const menuItems = isExecutive\s*\? executiveMenuItems\s*: standardMenuItems;/);
  // ...and the Shift entry itself never consults it
  assert.match(employeeSidebar, /const shiftNav = getShiftNavItem\(currentUser, basePath\);/);
  assert.equal((employeeSidebar.match(/\.\.\.shiftNav/g) || []).length, 2);
  const helperCode = read('client/src/utils/shiftAccess.js').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(helperCode, /designation|isExecutive|Founder|Chairman/i, 'helper code must not read designation');
});

test('route guard: admin tier may open shift-management, everyone else is redirected to shift-schedule (access only, slug-aware)', async () => {
  const { resolveShiftManagementAccess } = await helper();
  for (const u of users) {
    const decision = resolveShiftManagementAccess(u, '/employee/shift-management');
    if (expectedTier(u) === 'admin') assert.deepEqual(decision, { allow: true }, JSON.stringify(u));
    else assert.deepEqual(decision, { allow: false, redirectTo: '/employee/shift-schedule' }, JSON.stringify(u));
  }
  assert.deepEqual(resolveShiftManagementAccess({ role: 'employee', systemAccess: 'employee', designation: 'Founder' }, '/acme/employee/shift-management'),
    { allow: false, redirectTo: '/acme/employee/shift-schedule' });
  assert.deepEqual(resolveShiftManagementAccess({ role: 'employee', systemAccess: 'manager' }, '/acme/employee/shift-management/'),
    { allow: false, redirectTo: '/acme/employee/shift-schedule' });
  assert.deepEqual(resolveShiftManagementAccess(null, '/employee/shift-management'), { allow: false, redirectTo: '/employee/shift-schedule' });
  assert.deepEqual(resolveShiftManagementAccess({ role: 'employee', systemAccess: 'admin', designation: 'Intern' }, '/acme/employee/shift-management'), { allow: true });
  // case variants and repeated trailing slashes: the redirect must always change the URL, keeping the prefix as typed
  const emp = { role: 'employee', systemAccess: 'employee', designation: 'Founder' };
  for (const [from, to] of [
    ['/employee/Shift-Management', '/employee/shift-schedule'],
    ['/employee/SHIFT-MANAGEMENT/', '/employee/shift-schedule'],
    ['/employee/shift-management//', '/employee/shift-schedule'],
    ['/Acme/employee/Shift-Management', '/Acme/employee/shift-schedule'],
    ['/acme/employee/shift-management///', '/acme/employee/shift-schedule'],
  ]) {
    assert.deepEqual(resolveShiftManagementAccess(emp, from), { allow: false, redirectTo: to }, from);
  }
  assert.equal(resolveShiftManagementAccess({ role: 'employee', systemAccess: 'super_admin' }, '/employee/Shift-Management').allow, true);
});

test('routes: employee portal gets a guarded shift-management route; admin portal route and Admin menu are unchanged', () => {
  const employeeRoutes = appSource.match(/const EMPLOYEE_ROUTES = \[([\s\S]*?)\n\];/)[1];
  assert.match(employeeRoutes, /path: "shift-schedule", Component: EmployeeShiftSchedule/);
  assert.match(employeeRoutes, /path: "shift-management", Component: ShiftManagementRoute/);
  assert.doesNotMatch(employeeRoutes, /Component: AdminShiftManagement/, 'never the unguarded page in the employee portal');
  assert.match(appSource, /import ShiftManagementRoute from "\.\/routes\/ShiftManagementRoute";/);
  const adminRoutes = appSource.match(/const ADMIN_ROUTES = \[([\s\S]*?)\n\];/)[1];
  assert.match(adminRoutes, /path: "shift-management", Component: AdminShiftManagement/);
  assert.match(appSource, /buildRoleRoutes\("\/employee", EmployeeHome, EMPLOYEE_ROUTES, "employee", EmployeeLayout\)/);
  assert.match(appSource, /buildRoleRoutes\("\/:companySlug\/employee", EmployeeHome, EMPLOYEE_ROUTES, "employee", EmployeeLayout\)/);
  // the guard component decides with the shared helper and renders the existing page
  const guard = read('client/src/routes/ShiftManagementRoute.jsx');
  assert.match(guard, /resolveShiftManagementAccess\(readSessionUser\(\), pathname\)/);
  assert.match(guard, /<Navigate to=\{access\.redirectTo\} replace \/>/);
  assert.match(guard, /<AdminShiftManagement \/>/);
  const guardCode = guard.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(guardCode, /designation|Founder|Chairman/i);
  // Admin menu keeps its unconditional Shift Management entry
  const block = adminSidebar.slice(adminSidebar.indexOf('{/* SHIFT MANAGEMENT */}'), adminSidebar.indexOf('{/* SOP LIBRARY */}'));
  assert.match(block, /`\$\{basePath\}\/shift-management`/);
  assert.match(block, /Shift Management/);
  assert.doesNotMatch(block, /\bisExecutive\b|\bdesignation\b|\bsystemAccess\b|\?\s*\(/, 'not wrapped in any condition');
});

test('AdminShiftManagement is safe to host in the employee layout: self-contained, and its only endpoints are the shift API plus GET /employees', () => {
  const page = read('client/src/pages/Admin/AdminShiftManagement.jsx');
  const calls = [...page.matchAll(/api\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(calls, ['get /employees'], 'direct api calls');
  const service = read('client/src/services/shiftScheduleService.js');
  assert.deepEqual([...service.matchAll(/api\.(get|post|patch|delete)\(\s*[`"]([^`"?]+)/g)].map((m) => `${m[1]} ${m[2].replace(/\$\{id\}/, ':id')}`).sort(),
    ['delete /shifts/:id', 'get /shifts', 'get /shifts/report/export', 'get /shifts/search', 'patch /shifts/:id', 'post /shifts', 'post /shifts/bulk']);
  assert.doesNotMatch(page, /useOutletContext|useNavigate|useParams|<Link\b|["'`]\/admin/, 'no layout/router coupling');
  const css = read('client/src/pages/Admin/AdminShiftManagement.css');
  assert.doesNotMatch(css, /admin-layout|admin-main|admin-page-content|admin-sidebar/, 'no admin-layout ancestor selectors');
  assert.match(read('client/src/main.jsx'), /import "\.\/styles\/theme\.css";/, 'theme variables are global');
  assert.match(read('client/src/styles/theme.css'), /^:root\s*\{/m);
});

test('backend assumptions: every shift route needs only an active user; authorization functions use role/system_access, never designation', () => {
  const routes = read('server/routes/shiftScheduleRoutes.js');
  for (const verb of ['get("/"', 'get("/search"', 'post("/"', 'post("/bulk"', 'patch("/:id"', 'delete("/:id"']) {
    assert.match(routes, new RegExp(`router\\.${verb.replace(/[()/"]/g, '\\$&')}, protect, requireActiveUser, `), verb);
  }
  assert.doesNotMatch(routes, /designation|isExecutive|Founder|Chairman/i);
  const controller = read('server/controllers/shiftScheduleController.js');
  assert.match(controller, /function isAdminTier\(req\) \{\s*return req\.userAccess\?\.role === "admin" \|\| \["admin", "super_admin"\]\.includes\(req\.userAccess\?\.systemAccess\);\s*\}/);
  const authorization = controller.slice(controller.indexOf('function isAdminTier'), controller.indexOf('// REAL-TIME BROADCAST'));
  assert.ok(authorization.length > 200);
  assert.doesNotMatch(authorization, /designation|Founder|Chairman|isExecutive/i);
  assert.doesNotMatch(read('server/utils/shiftDefaults.js'), /Founder|Chairman|isExecutive/);
});

test('backend assumptions: GET /api/employees (used by the Shift Management page) admits admin tier and is not designation based', () => {
  const routes = read('server/routes/employeeRoutes.js');
  assert.match(routes, /const manageEmployees = requireAccess\("super_admin", "admin", "hr"\);/);
  assert.match(routes, /router\.get\(\s*"\/",\s*protect,\s*manageEmployees,\s*getEmployees\s*\)/);
  const access = read('server/middleware/accessMiddleware.js');
  assert.match(access, /role='admin' always passes every requireAccess\(\)/);
  // requireAccess (what guards GET /api/employees) must not read designation. The same file also holds the
  // separate Projects-area middleware, which legitimately has a designation default - not touched here.
  const start = access.indexOf('function requireAccess(');
  const end = access.indexOf('const requireActiveUser');
  const requireAccessCode = access.slice(start, end > 0 ? end : undefined).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(end > start && requireAccessCode.length > 300, 'found requireAccess');
  assert.doesNotMatch(requireAccessCode, /designation|Founder|Chairman/i);
});

test('no plan, subscription or feature-flag gating exists on the shift pages or routes', () => {
  for (const file of ['server/routes/shiftScheduleRoutes.js', 'server/controllers/shiftScheduleController.js',
    'client/src/pages/Employee/EmployeeShiftSchedule.jsx', 'client/src/pages/Admin/AdminShiftManagement.jsx',
    'client/src/routes/ShiftManagementRoute.jsx', 'client/src/utils/shiftAccess.js']) {
    assert.doesNotMatch(read(file), /featureFlag|feature_flag|requireFeature|planFeature|subscription|plan_id|access_type/i, file);
  }
});

// ---- the REAL shift controller against in-memory fake tenant pools (MOCKED database) ----
const db = require('./config/db');
const shiftController = require('./controllers/shiftScheduleController');

function fakeTenant(label, { reports = [] } = {}) {
  const calls = [];
  const shiftRow = { id: 1, user_id: 77, full_name: `Someone-${label}`, shift_date: '2026-10-19', status: 'working' };
  return {
    label, calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/reporting_manager_id/.test(sql)) return [reports];
      if (/FROM shift_schedules s/.test(sql) && /JOIN users u/.test(sql)) return [[shiftRow]];
      if (/FROM shift_schedules WHERE id/.test(sql) || /FROM shift_schedules\s+WHERE id/.test(sql)) return [[{ id: 5, user_id: 99, status: 'working' }]];
      return [[]];
    },
  };
}
const run = (tenant, fn) => db.__runWithTenantContext({ tenantPool: tenant, companySlug: tenant.label }, fn);
const res = () => ({ code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });
const reqFor = (userAccess, over = {}) => ({ user: { id: 10 }, userAccess, query: { startDate: '2026-10-19', endDate: '2026-10-25' }, params: {}, body: {}, app: { get: () => null }, ...over });
const shiftQuery = (tenant) => tenant.calls.find((c) => /FROM shift_schedules s/.test(c.sql));

test('MOCKED getShifts: admin tier sees everyone (no user filter) - role admin, system_access admin and super_admin alike', async () => {
  for (const access of [{ role: 'admin', systemAccess: 'employee' }, { role: 'employee', systemAccess: 'admin' }, { role: 'employee', systemAccess: 'super_admin' }]) {
    const t = fakeTenant('acme');
    const r = res();
    await run(t, () => shiftController.getShifts(reqFor(access), r));
    assert.equal(r.code, 200, JSON.stringify(access));
    const q = shiftQuery(t);
    assert.doesNotMatch(q.sql, /AND s\.user_id/, 'no per-user restriction for admin tier');
    assert.deepEqual(q.params, ['2026-10-19', '2026-10-25']);
  }
});

test('MOCKED getShifts: manager sees self + direct reports only, and cannot read another team by id', async () => {
  const t = fakeTenant('acme', { reports: [{ id: 21 }, { id: 22 }] });
  const r = res();
  await run(t, () => shiftController.getShifts(reqFor({ role: 'employee', systemAccess: 'manager' }), r));
  assert.equal(r.code, 200);
  assert.match(shiftQuery(t).sql, /s\.user_id IN \(\?,\?,\?\)/);
  assert.deepEqual(shiftQuery(t).params, ['2026-10-19', '2026-10-25', 10, 21, 22]);
  const t2 = fakeTenant('acme', { reports: [{ id: 21 }] });
  const r2 = res();
  await run(t2, () => shiftController.getShifts(reqFor({ role: 'employee', systemAccess: 'manager' }, { query: { startDate: '2026-10-19', endDate: '2026-10-25', userId: '999' } }), r2));
  assert.equal(r2.code, 403);
  assert.equal(shiftQuery(t2), undefined, 'no shift query ran');
});

test('MOCKED getShifts: every other access level (incl. executive/hr, whatever the designation) sees only its own shifts by default', async () => {
  for (const systemAccess of [undefined, 'employee', 'team_lead', 'department_head', 'hr', 'executive']) {
    const t = fakeTenant('acme');
    const r = res();
    // designation is deliberately present on the user object: the controller must not read it
    await run(t, () => shiftController.getShifts(reqFor({ role: 'employee', systemAccess }, { user: { id: 10, designation: 'Founder' } }), r));
    assert.equal(r.code, 200, String(systemAccess));
    assert.match(shiftQuery(t).sql, /s\.user_id = \?/);
    assert.deepEqual(shiftQuery(t).params, ['2026-10-19', '2026-10-25', 10]);
  }
});

test('MOCKED getShifts: department filter is admin tier only', async () => {
  const q = { startDate: '2026-10-19', endDate: '2026-10-25', departmentId: '3' };
  const denied = res();
  await run(fakeTenant('acme'), () => shiftController.getShifts(reqFor({ role: 'employee', systemAccess: 'executive' }, { query: q }), denied));
  assert.equal(denied.code, 403);
  const allowed = res();
  await run(fakeTenant('acme'), () => shiftController.getShifts(reqFor({ role: 'employee', systemAccess: 'super_admin' }, { query: q }), allowed));
  assert.equal(allowed.code, 200);
});

test('MOCKED tenant isolation: an admin-tier request only ever queries its own tenant\'s database', async () => {
  const a = fakeTenant('tenant_a');
  const b = fakeTenant('tenant_b');
  const [ra, rb] = [res(), res()];
  await Promise.all([
    run(a, () => shiftController.getShifts(reqFor({ role: 'employee', systemAccess: 'super_admin' }), ra)),
    run(b, () => shiftController.getShifts(reqFor({ role: 'admin', systemAccess: 'employee' }), rb)),
  ]);
  assert.equal(ra.body.shifts[0].full_name, 'Someone-tenant_a');
  assert.equal(rb.body.shifts[0].full_name, 'Someone-tenant_b');
  assert.equal(a.calls.length, 1);
  assert.equal(b.calls.length, 1);
});

test('MOCKED writes: creating, editing or deleting someone else\'s shift is refused below admin tier (even for a Founder-designated user)', async () => {
  const noAdmin = { role: 'employee', systemAccess: 'executive' };
  const create = res();
  await run(fakeTenant('acme'), () => shiftController.createShift(reqFor(noAdmin, { body: { userId: 99, shiftDate: '2026-10-20', status: 'off' }, user: { id: 10, designation: 'Founder' } }), create));
  assert.equal(create.code, 403);
  const update = res();
  await run(fakeTenant('acme'), () => shiftController.updateShift(reqFor(noAdmin, { params: { id: '5' }, body: { status: 'off' } }), update));
  assert.equal(update.code, 403);
  const del = res();
  await run(fakeTenant('acme'), () => shiftController.deleteShift(reqFor(noAdmin, { params: { id: '5' } }), del));
  assert.equal(del.code, 403);
  const manager = res();
  await run(fakeTenant('acme'), () => shiftController.deleteShift(reqFor({ role: 'employee', systemAccess: 'manager' }, { params: { id: '5' } }), manager));
  assert.equal(manager.code, 403, 'manager visibility never grants write access');
  // admin tier is not refused at the authorization step
  const admin = res();
  await run(fakeTenant('acme'), () => shiftController.deleteShift(reqFor({ role: 'employee', systemAccess: 'super_admin' }, { params: { id: '5' } }), admin));
  assert.notEqual(admin.code, 403);
});

// ---- EXECUTED route-guard render test ----------------------------------------------------------
// Renders the REAL client/src/routes/ShiftManagementRoute.jsx and the REAL client/src/utils/shiftAccess.js
// inside a real React Router MemoryRouter in jsdom. Only AdminShiftManagement is replaced by a stub that
// counts renders/mounts (the real page needs the API); everything else is the project's own code, copied
// into a temp directory outside the project and bundled with the client's own Vite. The renders run in a
// CHILD Node process (React's scheduler keeps message ports open, so an in-process run would never exit,
// and jsdom globals stay out of this test process). No database, no network, nothing is written inside
// the project, no dependency is installed.
// Needs the client's dev dependencies (vite, react, react-dom, react-router-dom) and jsdom (a dev
// transitive dependency of maildev). If they are not installed the tests are SKIPPED with a message.
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { describe, before, after } = require('node:test');

function candidateModuleDirs() {
  const dirs = [];
  let dir = ROOT;
  for (;;) {
    dirs.push(path.join(dir, 'client', 'node_modules'), path.join(dir, 'node_modules'));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return dirs.filter((d) => fs.existsSync(d));
}
const hasPkg = (dir, name) => fs.existsSync(path.join(dir, name, 'package.json'));
function guardPrerequisites() {
  const clientModules = candidateModuleDirs().find((d) => path.basename(path.dirname(d)) === 'client'
    && ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'react-router-dom'].every((p) => hasPkg(d, p)));
  const jsdomParent = candidateModuleDirs().find((d) => hasPkg(d, 'jsdom'));
  const missing = [];
  if (!clientModules) missing.push('client dev dependencies (vite, @vitejs/plugin-react, react, react-dom, react-router-dom)');
  if (!jsdomParent) missing.push('jsdom');
  return { clientModules, jsdomDir: jsdomParent && path.join(jsdomParent, 'jsdom'), skip: missing.length ? `not installed: ${missing.join(', ')}` : false };
}
const prerequisites = guardPrerequisites();

const GUARD_ENTRY = `
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";
import ShiftManagementRoute from "./routes/ShiftManagementRoute.jsx";

function Probe({ log }) { log.push(useLocation().pathname); return null; }

export async function renderGuard({ user, rawUser, startPath, base = "/employee" }) {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.__adminRenders = 0;
  globalThis.__adminMounts = 0;
  if (rawUser !== undefined) sessionStorage.setItem("user", rawUser);
  else if (user === undefined) sessionStorage.removeItem("user");
  else sessionStorage.setItem("user", JSON.stringify(user));
  const log = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const errors = [];
  const original = console.error;
  console.error = (...a) => errors.push(a.join(" ").slice(0, 200));
  try {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[startPath]}>
          <Probe log={log} />
          <Routes>
            <Route path={base + "/shift-management"} element={<ShiftManagementRoute />} />
            <Route path={base + "/shift-schedule"} element={<div>EMPLOYEE-SCHEDULE-PAGE</div>} />
            <Route path="*" element={<div>NO-MATCH</div>} />
          </Routes>
        </MemoryRouter>
      );
    });
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  } finally { console.error = original; }
  const result = {
    finalPath: log[log.length - 1], locationChanges: log.length, text: host.textContent,
    adminRenders: globalThis.__adminRenders, adminMounts: globalThis.__adminMounts, errors,
  };
  await act(async () => root.unmount());
  host.remove();
  return result;
}
`;
const ADMIN_STUB = `
import { useEffect } from "react";
export default function AdminShiftManagementStub() {
  globalThis.__adminRenders = (globalThis.__adminRenders || 0) + 1;
  useEffect(() => { globalThis.__adminMounts = (globalThis.__adminMounts || 0) + 1; }, []);
  return <div>ADMIN-SHIFT-MANAGEMENT-PAGE</div>;
}
`;
// Runs in the child process: jsdom globals, then every case through the real guard, then exits explicitly.
const CHILD_RUNNER = `
const { JSDOM } = require(process.env.JSDOM_DIR);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define("window", dom.window); define("document", dom.window.document); define("sessionStorage", dom.window.sessionStorage);
define("navigator", dom.window.navigator); define("HTMLElement", dom.window.HTMLElement);
define("requestAnimationFrame", (cb) => setTimeout(cb, 0));
const { renderGuard } = require("./dist/guard.cjs");
const cases = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
(async () => {
  const results = [];
  for (const c of cases) results.push(await renderGuard(c));
  process.stdout.write("RESULTS:" + JSON.stringify(results) + "\\n");
  process.exit(0);
})().catch((e) => { console.error("RENDER HARNESS ERROR", e); process.exit(2); });
`;

const ADMIN_PAGE = 'ADMIN-SHIFT-MANAGEMENT-PAGE';
const SCHEDULE_PAGE = 'EMPLOYEE-SCHEDULE-PAGE';
const URL_ = '/employee/shift-management';
const ACME = { base: '/acme/employee' };
const EMPLOYEE = { role: 'employee', systemAccess: 'employee', designation: 'Founder' };
const GUARD_CASES = {
  admins: [
    { user: { role: 'employee', systemAccess: 'admin', designation: 'CTO' }, startPath: URL_ },
    { user: { role: 'employee', systemAccess: 'super_admin', designation: 'Founder' }, startPath: URL_ },
    { user: { role: 'admin' }, startPath: URL_ },
  ],
  nonAdmins: [
    { user: { role: 'employee', systemAccess: 'manager', designation: 'Manager' }, startPath: URL_ },
    { user: { role: 'employee', systemAccess: 'employee', designation: 'Intern' }, startPath: URL_ },
    { user: { role: 'employee', systemAccess: 'executive', designation: 'Founder' }, startPath: URL_ },
    { user: { role: 'employee', systemAccess: 'employee', designation: 'Chairman' }, startPath: URL_ },
    { user: { role: 'employee', systemAccess: 'hr' }, startPath: URL_ },
  ],
  invalid: [
    { user: undefined, startPath: URL_ },
    { rawUser: '{not json', startPath: URL_ },
    { rawUser: 'null', startPath: URL_ },
    { rawUser: '"admin"', startPath: URL_ },
    { user: { role: 'employee', systemAccess: ['admin'] }, startPath: URL_ },
    { user: { role: 'employee', systemAccess: 'SUPER_ADMIN' }, startPath: URL_ },
    { user: { role: 'Admin' }, startPath: URL_ },
    { user: { systemAccess: 'super-admin' }, startPath: URL_ },
  ],
  caseNonAdmin: ['/employee/Shift-Management', '/employee/SHIFT-MANAGEMENT', '/employee/shift-management/', '/employee/shift-management//']
    .map((startPath) => ({ user: EMPLOYEE, startPath })),
  caseAdmin: ['/employee/Shift-Management', '/employee/SHIFT-MANAGEMENT/']
    .map((startPath) => ({ user: { role: 'employee', systemAccess: 'super_admin' }, startPath })),
  prefixedNonAdmin: ['/acme/employee/shift-management', '/acme/employee/Shift-Management']
    .map((startPath) => ({ ...ACME, user: { role: 'employee', systemAccess: 'employee' }, startPath })),
  prefixedAdmin: [{ ...ACME, user: { role: 'employee', systemAccess: 'admin' }, startPath: '/acme/employee/Shift-Management' }],
};

describe('route guard render (real ShiftManagementRoute + real router, jsdom, child process)', { skip: prerequisites.skip }, () => {
  const results = {};
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-guard-'));
    for (const [rel, content] of [
      ['src/entry.jsx', GUARD_ENTRY],
      ['src/pages/Admin/AdminShiftManagement.jsx', ADMIN_STUB],
      ['package.json', '{ "type": "module" }'],
      ['run.cjs', CHILD_RUNNER],
    ]) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, rel), content);
    }
    // the project's own code under test (copied, not modified)
    for (const rel of ['src/routes/ShiftManagementRoute.jsx', 'src/utils/shiftAccess.js']) {
      fs.mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, 'client', rel), path.join(tmpDir, rel));
    }
    fs.symlinkSync(prerequisites.clientModules, path.join(tmpDir, 'node_modules'), 'junction');

    const vite = await import(pathToFileURL(path.join(prerequisites.clientModules, 'vite', 'dist', 'node', 'index.js')).href);
    const react = (await import(pathToFileURL(path.join(prerequisites.clientModules, '@vitejs', 'plugin-react', 'dist', 'index.js')).href)).default;
    await vite.build({
      root: tmpDir, configFile: false, logLevel: 'silent', cacheDir: path.join(tmpDir, '.cache'),
      plugins: [react()],
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      build: {
        outDir: path.join(tmpDir, 'dist'), emptyOutDir: true, minify: false,
        lib: { entry: path.join(tmpDir, 'src', 'entry.jsx'), formats: ['cjs'], fileName: () => 'guard.cjs' },
      },
    });

    const flat = Object.entries(GUARD_CASES).flatMap(([group, list]) => list.map((c, index) => ({ group, index, ...c })));
    const casesFile = path.join(tmpDir, 'cases.json');
    fs.writeFileSync(casesFile, JSON.stringify(flat.map(({ group, index, ...c }) => c)));
    const stdout = execFileSync(process.execPath, [path.join(tmpDir, 'run.cjs'), casesFile], {
      cwd: tmpDir, encoding: 'utf8', timeout: 90000, env: { ...process.env, JSDOM_DIR: prerequisites.jsdomDir },
    });
    const line = stdout.split('\n').find((l) => l.startsWith('RESULTS:'));
    assert.ok(line, 'render harness produced results');
    const rendered = JSON.parse(line.slice('RESULTS:'.length));
    flat.forEach((c, i) => { (results[c.group] ||= []).push({ ...rendered[i], startPath: c.startPath, args: c }); });
  });

  after(() => {
    if (!tmpDir) return;
    const link = path.join(tmpDir, 'node_modules');
    try { fs.rmdirSync(link); } catch { /* link already gone */ }
    // only delete the temp tree once the junction to the client's node_modules is certainly gone
    if (!fs.existsSync(link)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('admin tiers (system_access admin, super_admin, role admin) get the management page, mounted exactly once, no redirect', () => {
    assert.equal(results.admins.length, 3);
    for (const r of results.admins) {
      assert.equal(r.finalPath, URL_, JSON.stringify(r.args));
      assert.ok(r.text.includes(ADMIN_PAGE));
      assert.equal(r.adminMounts, 1, 'mounted once');
      assert.equal(r.locationChanges, 1, 'no navigation happened');
      assert.deepEqual(r.errors, []);
    }
  });

  test('manager, employee, Founder/Chairman with employee-level access and hr are redirected and NEVER render or mount the admin page', () => {
    assert.equal(results.nonAdmins.length, 5);
    for (const r of results.nonAdmins) {
      assert.equal(r.finalPath, '/employee/shift-schedule', JSON.stringify(r.args));
      assert.ok(r.text.includes(SCHEDULE_PAGE));
      assert.equal(r.text.includes(ADMIN_PAGE), false);
      assert.equal(r.adminRenders, 0, 'admin page never rendered');
      assert.equal(r.adminMounts, 0, 'admin page never mounted');
      assert.ok(r.locationChanges <= 3, 'no redirect loop');
      assert.deepEqual(r.errors, []);
    }
  });

  test('missing, malformed or invalid session/permission data fails closed (redirect, nothing mounted)', () => {
    assert.equal(results.invalid.length, 8);
    for (const r of results.invalid) {
      assert.equal(r.finalPath, '/employee/shift-schedule', JSON.stringify(r.args));
      assert.equal(r.adminRenders + r.adminMounts, 0, JSON.stringify(r.args));
      assert.ok(r.text.includes(SCHEDULE_PAGE));
    }
  });

  test('case-variant and trailing-slash paths: non-admin users are redirected to shift-schedule (no blank page), admin tier still gets the page', () => {
    assert.equal(results.caseNonAdmin.length, 4);
    for (const r of results.caseNonAdmin) {
      assert.ok(/^\/employee\/shift-schedule$/i.test(r.finalPath) && r.finalPath !== r.startPath, `${r.startPath} -> ${r.finalPath}`);
      assert.ok(r.text.includes(SCHEDULE_PAGE), `${r.startPath}: schedule page shown, not a blank page`);
      assert.equal(r.adminRenders + r.adminMounts, 0, r.startPath);
      assert.ok(r.locationChanges <= 3, `${r.startPath}: no redirect loop`);
    }
    assert.equal(results.caseAdmin.length, 2);
    for (const r of results.caseAdmin) {
      assert.ok(r.text.includes(ADMIN_PAGE), r.startPath);
      assert.equal(r.adminMounts, 1, r.startPath);
    }
  });

  test('company-prefixed portal: the redirect keeps the prefix (also for case variants); admin tier is allowed', () => {
    assert.equal(results.prefixedNonAdmin.length, 2);
    for (const r of results.prefixedNonAdmin) {
      assert.equal(r.finalPath, '/acme/employee/shift-schedule', r.startPath);
      assert.ok(r.text.includes(SCHEDULE_PAGE));
      assert.equal(r.adminRenders + r.adminMounts, 0);
    }
    const [admin] = results.prefixedAdmin;
    assert.ok(admin.text.includes(ADMIN_PAGE));
    assert.equal(admin.adminMounts, 1);
  });
});
