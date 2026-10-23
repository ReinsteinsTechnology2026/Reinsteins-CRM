// RENDERED tests of the real Shift Management page (client/src/pages/Admin/AdminShiftManagement.jsx).
//
// What is real:   the page, its CSS imports, the shared helpers (shiftViews.js, shiftScheduleState.js,
//                 timeFormat.js), EmployeeNameplate / TimeInput12h, React, react-icons, jsdom DOM events.
// What is MOCKED: the network layer only -- api, shiftScheduleService, socket.io and react-toastify are
//                 replaced by server/_test_shift_page_harness/stubs/* (an in-memory model of the shift and
//                 employee endpoints, recording every request the page makes). This is NOT PostgreSQL and
//                 NOT the real controller; the real controller is covered in _test_shift_employee_filter.js.
//
// The page sources are copied into an OS temp directory and bundled with the client's own Vite; the
// scenarios run in CHILD Node processes, one per time zone (TZ is fixed at process start): Asia/Kolkata,
// UTC, Pacific/Auckland and America/Los_Angeles, with "today" pinned to Friday 2026-10-23. Nothing is
// written inside the project, no dependency is installed, nothing touches a database or the network.
// Needs the client's dev dependencies and jsdom (a transitive dev dependency of maildev); if they are not
// installed the tests are SKIPPED with a message instead of failing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { describe, before, after, test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, '_test_shift_page_harness');

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
function prerequisites() {
  const clientModules = candidateModuleDirs().find((d) => path.basename(path.dirname(d)) === 'client'
    && ['vite', '@vitejs/plugin-react', 'react', 'react-dom', 'react-icons'].every((p) => hasPkg(d, p)));
  const jsdomParent = candidateModuleDirs().find((d) => hasPkg(d, 'jsdom'));
  const missing = [];
  if (!clientModules) missing.push('client dev dependencies (vite, @vitejs/plugin-react, react, react-dom, react-icons)');
  if (!jsdomParent) missing.push('jsdom');
  return { clientModules, jsdomDir: jsdomParent && path.join(jsdomParent, 'jsdom'), skip: missing.length ? `not installed: ${missing.join(', ')}` : false };
}
const pre = prerequisites();

const ZONES = [
  { tz: 'Asia/Kolkata', names: ['Asia/Kolkata', 'Asia/Calcutta'] },
  { tz: 'UTC', names: ['UTC', 'Etc/UTC'] },
  { tz: 'Pacific/Auckland', names: ['Pacific/Auckland'] },
  { tz: 'America/Los_Angeles', names: ['America/Los_Angeles'] },
];

describe('rendered Shift Management page (real page + real helpers, mocked network, jsdom, child process per time zone)', { skip: pre.skip }, () => {
  let tmpDir;
  const byZone = {};

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shift-page-'));
    const copy = (from, to) => { fs.mkdirSync(path.dirname(path.join(tmpDir, to)), { recursive: true }); fs.copyFileSync(from, path.join(tmpDir, to)); };
    const client = (rel) => path.join(ROOT, 'client', 'src', rel);

    // the project's own code under test (copied, not modified)
    for (const rel of [
      'pages/Admin/AdminShiftManagement.jsx', 'pages/Admin/AdminShiftManagement.css',
      'components/EmployeeNameplate.jsx', 'components/EmployeeNameplate.css', 'components/TimeInput12h.jsx',
      'utils/timeFormat.js', 'utils/shiftViews.js', 'utils/shiftScheduleState.js',
    ]) copy(client(rel), `src/${rel}`);

    // harness + network stubs
    copy(path.join(HARNESS, 'entry.jsx'), 'src/entry.jsx');
    copy(path.join(HARNESS, 'child.cjs'), 'child.cjs');
    for (const f of ['backend.js', 'api.js', 'socket.js', 'toastify.js']) copy(path.join(HARNESS, 'stubs', f), `src/services/${f}`);
    fs.writeFileSync(path.join(tmpDir, 'src/services/shiftScheduleService.js'),
      'export { getShifts, createShift, updateShift, deleteShift, bulkSaveShifts, searchShiftEmployees } from "./backend.js";\n');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{ "type": "module" }');
    fs.symlinkSync(pre.clientModules, path.join(tmpDir, 'node_modules'), 'junction');

    const vite = await import(pathToFileURL(path.join(pre.clientModules, 'vite', 'dist', 'node', 'index.js')).href);
    const react = (await import(pathToFileURL(path.join(pre.clientModules, '@vitejs', 'plugin-react', 'dist', 'index.js')).href)).default;
    await vite.build({
      root: tmpDir, configFile: false, logLevel: 'silent', cacheDir: path.join(tmpDir, '.cache'),
      plugins: [react()],
      resolve: { alias: { 'react-toastify': path.join(tmpDir, 'src/services/toastify.js') } },
      define: { 'process.env.NODE_ENV': JSON.stringify('development') },
      build: {
        outDir: path.join(tmpDir, 'dist'), emptyOutDir: true, minify: false,
        lib: { entry: path.join(tmpDir, 'src', 'entry.jsx'), formats: ['cjs'], fileName: () => 'harness.cjs', cssFileName: 'harness' },
      },
    });

    const runZone = (zone) => new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(tmpDir, 'child.cjs')], {
        cwd: tmpDir, encoding: 'utf8', timeout: 120000, env: { ...process.env, TZ: zone.tz, JSDOM_DIR: pre.jsdomDir },
      }, (error, stdout, stderr) => {
        if (error) return reject(new Error(`render harness failed in ${zone.tz}: ${String(stderr || error.message).slice(0, 1500)}`));
        const line = stdout.split('\n').find((l) => l.startsWith('RESULTS:'));
        if (!line) return reject(new Error(`render harness produced no results in ${zone.tz}`));
        const parsed = JSON.parse(line.slice('RESULTS:'.length));
        if (!zone.names.includes(parsed.tz)) return reject(new Error(`child did not run in ${zone.tz} (reported ${parsed.tz})`));
        resolve([zone.tz, parsed.results]);
      });
    });
    // each zone is its own process (TZ is fixed at process start); run them side by side
    for (const [tz, results] of await Promise.all(ZONES.map(runZone))) byZone[tz] = results;
  });

  after(() => {
    if (!tmpDir) return;
    const link = path.join(tmpDir, 'node_modules');
    try { fs.rmdirSync(link); } catch { /* link already gone */ }
    // only delete the temp tree once the junction to the client's node_modules is certainly gone
    if (!fs.existsSync(link)) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const everyZone = (fn) => { for (const zone of ZONES) fn(byZone[zone.tz], zone.tz); };
  const WEEK = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'];
  const ALL_ROWS = ['Admin User (You)Founder', 'Asha RaoEngineer', 'Bilal KhanDesigner', 'Chitra NairAnalyst'];

  test('a. overall schedule: Day, Week and Month for everyone, Previous/Next and the date picker, in every time zone', () => {
    everyZone(({ overall: o }, tz) => {
      assert.equal(o.initial.activeView, 'Week', tz);
      assert.deepEqual(o.initial.headerDates, WEEK, `${tz}: Monday-Sunday of 23 Oct 2026`);
      assert.equal(o.initial.range, '19 Oct - 25 Oct', tz);
      assert.deepEqual(o.initial.rows, ALL_ROWS, tz);
      assert.equal(o.editableOwn, 7, `${tz}: only MY row is editable`);
      assert.deepEqual(o.day.headerDates, ['2026-10-23'], tz);
      assert.deepEqual(o.day.rows, ALL_ROWS, tz);
      assert.equal(o.day.call.startDate, '2026-10-23'); assert.equal(o.day.call.endDate, '2026-10-23');
      assert.equal(o.month.headerDates.length, 31, tz);
      assert.equal(o.month.headerDates[0], '2026-10-01'); assert.equal(o.month.headerDates[30], '2026-10-31');
      assert.equal(o.month.range, 'October 2026');
      assert.deepEqual([o.month.call.startDate, o.month.call.endDate], ['2026-10-01', '2026-10-31'], tz);
      assert.equal(o.month.asha21, '09:00 AM - 06:00 PM', `${tz}: data lands on the right date`);
      assert.equal(o.month.bilal05, '10:00 AM - 07:00 PM');
      assert.equal(o.nextMonth.headerDates.length, 30); assert.equal(o.nextMonth.range, 'November 2026');
      assert.equal(o.prevMonth2.range, 'September 2026'); assert.equal(o.prevMonth2.headerDates.length, 30);
      assert.equal(o.leap.range, 'February 2028'); assert.equal(o.leap.headerDates.length, 29, `${tz}: leap year`);
      assert.equal(o.yearBoundary.headerDates[0], '2025-12-29', `${tz}: week crossing the year`);
      assert.equal(o.yearBoundary.headerDates[6], '2026-01-04');
      assert.equal(o.yearBoundary.pickerValue, '2026-01-01');
      assert.equal(o.emptyPickerIgnored, o.yearBoundary.range, 'a cleared picker never moves the range');
      assert.deepEqual(o.errors, [], `${tz}: no React errors`);
    });
  });

  test('b. employee schedule for Day, Week and Month: only that employee, full range, server-side userId', () => {
    everyZone(({ employee: e }, tz) => {
      assert.equal(e.selected.chip, 'Filtered: Asha Rao (RS002)', tz);
      assert.deepEqual(e.selected.rows, ['Asha RaoEngineer'], tz);
      assert.deepEqual(e.selected.headerDates, WEEK, `${tz}: full Monday-Sunday week`);
      assert.deepEqual([e.selected.call.startDate, e.selected.call.endDate, e.selected.call.userId], ['2026-10-19', '2026-10-25', 2], tz);
      assert.equal(e.editableWhenFiltered, 0, 'another employee\'s row is not directly editable');
      assert.deepEqual(e.day.rows, ['Asha RaoEngineer']);
      assert.deepEqual([e.day.call.startDate, e.day.call.endDate, e.day.call.userId], ['2026-10-23', '2026-10-23', 2], tz);
      assert.equal(e.month.headerDates.length, 31);
      assert.deepEqual([e.month.call.startDate, e.month.call.endDate, e.month.call.userId], ['2026-10-01', '2026-10-31', 2], tz);
      assert.equal(e.month.asha21, '09:00 AM - 06:00 PM'); assert.equal(e.month.asha27, '09:00 AM - 06:00 PM');
      assert.equal(e.nextMonth.range, 'November 2026'); assert.equal(e.nextMonth.call.userId, 2);
      assert.equal(e.picked.range, 'December 2026', tz);
      assert.deepEqual([e.picked.call.startDate, e.picked.call.endDate, e.picked.call.userId], ['2026-12-01', '2026-12-31', 2], `${tz}: picker in Month view = the whole month, employee kept`);
      assert.equal(e.picked.chip, 'Filtered: Asha Rao (RS002)');
      assert.deepEqual([e.weekAfterPick.call.startDate, e.weekAfterPick.call.endDate, e.weekAfterPick.call.userId], ['2026-12-28', '2027-01-03', 2], `${tz}: year-boundary week`);
      assert.deepEqual([e.weekNext.call.startDate, e.weekNext.call.endDate, e.weekNext.call.userId], ['2027-01-04', '2027-01-10', 2], tz);
      assert.deepEqual(e.errors, []);
    });
  });

  test('c/d. search -> select -> automatic collapse -> reopen -> clear; the employee and the range survive view changes', () => {
    everyZone(({ employee: e, searchFlow: s }, tz) => {
      // selecting an exactly-one match dismisses the search panel
      assert.equal(e.selected.finderOpen, false, tz); assert.equal(e.noSearchPanelLeft, true);
      assert.equal(e.selected.findButton, 'Change employee');
      // changing views kept the employee every time (see b); the range was not reset by selecting
      assert.equal(e.selected.range, '19 Oct - 25 Oct', `${tz}: selecting an employee did not reset the range`);
      // clearing restores everyone for the SAME range, and sends no userId
      assert.deepEqual(e.cleared.rows, ALL_ROWS, tz);
      assert.equal(e.rangeKeptOnClear, true, `${tz}: clear keeps the selected date range and view`);
      assert.equal(e.cleared.call.userId, undefined);
      assert.equal(e.cleared.chip, null);
      assert.equal(e.cleared.findButton, 'Find employee');
      assert.deepEqual(e.beforeSearch.rows, ALL_ROWS);
      // several matches: list, pick one, panel collapses, chip shows, reopen, choose another, clear
      assert.equal(s.list.finderItems.length, 5, tz);
      assert.equal(s.afterPick.finderOpen, false); assert.deepEqual(s.afterPick.finderItems, []);
      assert.equal(s.afterPick.chip, 'Filtered: Bilal Khan (RS003)'); assert.deepEqual(s.afterPick.rows, ['Bilal KhanDesigner']);
      assert.equal(s.reopened.finderOpen, true); assert.equal(s.reopened.chip, 'Filtered: Bilal Khan (RS003)', 'still filtered while choosing another');
      assert.equal(s.second.chip, 'Filtered: Chitra Nair (RS004)'); assert.equal(s.second.finderOpen, false);
      assert.deepEqual(s.cleared.rows, ALL_ROWS); assert.equal(s.cleared.chip, null);
      // single-day result detail only in Day view
      assert.ok(s.dayResults.finderDayDetail > 0, 'Day view shows the day status in the results');
      assert.equal(s.weekResults.finderDayDetail, 0, `${tz}: no single-day result columns in Week view`);
      assert.equal(s.closed.finderOpen, false);
    });
  });

  test('c. selecting and clearing an employee never resets the selected view or date range', () => {
    everyZone(({ rangeKept: r }, tz) => {
      assert.equal(r.before.range, 'November 2026', tz);
      assert.equal(r.selected.range, 'November 2026', `${tz}: selecting kept the month`);
      assert.equal(r.selected.activeView, 'Month');
      assert.deepEqual([r.selected.call.startDate, r.selected.call.endDate, r.selected.call.userId], ['2026-11-01', '2026-11-30', 2], tz);
      assert.equal(r.cleared.range, 'November 2026', `${tz}: clearing kept the month`);
      assert.deepEqual([r.cleared.call.startDate, r.cleared.call.endDate, r.cleared.call.userId], ['2026-11-01', '2026-11-30', undefined], tz);
      assert.deepEqual(r.cleared.rows, ALL_ROWS);
      assert.deepEqual(r.errors, []);
    });
  });

  test('e. an employee GET /employees does not return (admin-role account) still gets a row and a clear empty note', () => {
    everyZone(({ notListed: n }, tz) => {
      assert.deepEqual(n.selected.rows, ['Shafiq MohammadDirector'], tz);
      assert.equal(n.selected.emptyState, false, 'never "No employees to schedule"');
      assert.match(n.selected.note, /No shifts are recorded for Shafiq Mohammad \(RS005\) in this week\./);
      assert.equal(n.call.userId, 9);
      assert.deepEqual(n.month.rows, ['Shafiq MohammadDirector']);
      assert.equal(n.month.headerDates.length, 31);
    });
  });

  test('f. stale responses never overwrite the current selection (range, employee, search)', () => {
    everyZone(({ stale: s }, tz) => {
      assert.equal(s.weekBefore.range, '19 Oct - 25 Oct', tz);
      assert.equal(s.weekAfter.asha21, '09:00 AM - 06:00 PM', `${tz}: the late MONTH answer (LEAVE) was dropped`);
      assert.equal(s.weekAfter.range, '19 Oct - 25 Oct');
      assert.deepEqual(s.clear.after, ALL_ROWS, `${tz}: the late FILTERED answer did not replace the cleared view`);
      assert.equal(s.clear.chipAfter, null);
      assert.equal(s.clear.bilal21After, '10:00 AM - 07:00 PM', 'everyone\'s data is intact');
      assert.deepEqual(s.searchAfter, ['Asha Rao (RS002)', 'Shafiq Mohammad (RS005)'], `${tz}: the late earlier SEARCH did not replace the newer results`);
      assert.deepEqual(s.searchBefore, s.searchAfter);
      assert.equal(s.dismissed.finderOpen, false); assert.deepEqual(s.dismissed.items, [], 'a dismissed search stays dismissed');
    });
  });

  test('f. errors and empty results: error with Retry, no-match message, empty filtered schedule', () => {
    everyZone(({ errorsAndEmpty: x }, tz) => {
      assert.equal(x.error.error.startsWith('boom'), true, tz);
      assert.equal(x.error.rows.length, 0, 'no table, no mock rows shown on error');
      assert.deepEqual(x.retried.rows, ALL_ROWS, `${tz}: Retry loads the schedule`);
      assert.equal(x.retried.error, null);
      assert.equal(x.noMatch.searchEmpty, 'No matching employees found.');
      assert.match(x.noShifts.note, /No shifts are recorded for Chitra Nair \(RS004\)/);
      assert.deepEqual(x.noShifts.rows, ['Chitra NairAnalyst']);
    });
  });

  test('h. Administrative Override while another employee is filtered: no duplicate-entry errors, existing entries edited in place', () => {
    everyZone(({ override: o }, tz) => {
      assert.equal(o.prefilled.userId, '2', 'opens on the filtered employee');
      assert.equal(o.bilal19, 'Create Shift', tz + ' ' + JSON.stringify(o.debugCalls));
      assert.equal(o.bilal21.save, 'Save Changes', `${tz}: Bilal's existing entry (not loaded while filtered) was found`);
      assert.equal(o.bilal21.locked, true);
      assert.ok(o.bilal21.lookups.includes('2026-10-21'), 'asked the existing API for that single day and employee: ' + JSON.stringify([o.bilal21, o.debugCalls]));
      assert.equal(o.race.creates, 0, `${tz}: submitting before the lookup returned did not create a duplicate`);
      assert.equal(o.race.save, 'Save Changes');
      assert.ok(o.race.toasts.some((t) => t.startsWith('info:An entry already exists')), 'the existing entry is shown for review');
      assert.ok(!o.race.toasts.some((t) => t.startsWith('error:')), 'no duplicate-entry error toast');
      assert.equal(o.chitra, 'Create Shift');
      assert.deepEqual(o.created.creates, ['4@2026-10-22'], 'a genuine create goes through once');
      assert.ok(o.created.toasts.some((t) => t.includes('Shift created successfully (administrative override)')));
      assert.equal(o.created.chip, 'Filtered: Asha Rao (RS002)', 'the schedule filter is not touched by the override');
      assert.equal(o.duplicateStatus, 409, 'the (mocked) server still refuses a blind duplicate');
      assert.equal(o.overridePanel, true);
      assert.deepEqual(o.errors, []);
    });
  });

  test('live updates: merged only inside the range and, when filtered, only for the selected employee', () => {
    everyZone(({ live: l }, tz) => {
      assert.deepEqual(l.otherEmployeeIgnored, ['Asha RaoEngineer'], tz);
      assert.equal(l.selectedMerged, '11:00 AM - 08:00 PM', `${tz}: the selected employee's update is shown`);
      assert.equal(l.outsideRangeIgnored, 1);
      assert.equal(l.everyoneAfterClear, '07:00 AM - 03:00 PM', `${tz}: with no filter everyone's updates merge`);
      assert.deepEqual(l.errors, []);
    });
  });
});
