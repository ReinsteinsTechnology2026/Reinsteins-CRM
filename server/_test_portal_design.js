// Portal redesign guards. No database, no network, no browser, nothing production: static reads of the
// client sources and CSS, plus arithmetic on the design tokens.
//   - the green design system exists (tokens) and nothing blue is left in the redesigned portal;
//   - text/background pairs used by the new chrome meet WCAG AA;
//   - the dark-green sidebar / light canvas are applied consistently by BOTH layouts (and the duplicated
//     shell selectors in EmployeeHome.css agree with them);
//   - the employee dashboard keeps every real feature, route and label while the decorative illustrations
//     are gone;
//   - sidebar navigation (all existing items) and the header controls are unchanged.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'client', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n').replace(/^﻿/, '');

const theme = read('styles/theme.css');
const token = (name) => {
  const m = theme.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
  assert.ok(m, `token ${name} is defined in theme.css`);
  return m[1].trim();
};

// ---- colour maths -------------------------------------------------------------------------------
const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (hex) => {
  const [r, g, b] = hexToRgb(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
function hueSatLight(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s, l };
}
const isBlue = (r, g, b) => { const { h, s, l } = hueSatLight(r, g, b); return h >= 190 && h <= 265 && s >= 0.25 && l >= 0.12 && l <= 0.97; };

// ---- 1. design system ---------------------------------------------------------------------------
test('green design tokens exist: dark-green sidebar, light-green canvas, focus ring; "info" is no longer blue', () => {
  for (const name of ['--canvas', '--sidebar-bg', '--sidebar-bg-deep', '--sidebar-text', '--sidebar-text-muted', '--sidebar-hover', '--sidebar-active', '--sidebar-border', '--focus-ring']) token(name);
  assert.equal(token('--primary').toUpperCase(), '#16A66A', 'the brand green is unchanged');
  for (const name of ['--canvas', '--sidebar-bg', '--sidebar-active', '--info', '--info-light']) {
    const [r, g, b] = hexToRgb(token(name));
    assert.equal(isBlue(r, g, b), false, `${name} (${token(name)}) is not blue`);
  }
  const { h } = hueSatLight(...hexToRgb(token('--sidebar-bg')));
  assert.ok(h > 120 && h < 175, 'sidebar background is green');
});

test('text / background pairs of the new chrome meet WCAG AA (4.5:1)', () => {
  const pairs = [
    ['sidebar text on sidebar', token('--sidebar-text'), token('--sidebar-bg')],
    ['sidebar muted text on sidebar', token('--sidebar-text-muted'), token('--sidebar-bg')],
    ['white on sidebar', '#FFFFFF', token('--sidebar-bg')],
    ['white on active nav item', '#FFFFFF', token('--sidebar-active')],
    ['body text on canvas', token('--text'), token('--canvas')],
    ['secondary text on canvas', token('--text-secondary'), token('--canvas')],
    ['muted text on white', token('--text-muted'), '#FFFFFF'],
    ['muted text on canvas', token('--text-muted'), token('--canvas')],
    ['muted text on mint', token('--text-muted'), '#E8F8F0'],
    ['white on dashboard filled controls (primary-dark)', '#FFFFFF', token('--primary-dark')],
    ['primary-dark on mint', token('--primary-dark'), '#E8F8F0'],
  ];
  for (const [label, fg, bg] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${label}: ${contrast(fg, bg).toFixed(2)}`);
});

test('no blue colour is left anywhere in the redesigned portal (tenant app CSS/JSX; public site and platform console are separate products)', () => {
  const SKIP = ['pages/Public', 'pages/Platform', 'Landing', 'publicTheme', 'publicComponents', 'platformTheme', 'platformComponents', 'PlatformLayout', 'PublicLayout', 'PlatformProtectedRoute'];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(SRC, full).replace(/\\/g, '/');
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(css|jsx|js)$/.test(entry.name) || SKIP.some((s) => rel.includes(s))) continue;
      fs.readFileSync(full, 'utf8').split(/\r?\n/).forEach((line, i) => {
        for (const m of line.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) {
          const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
          const [r, g, b] = [0, 2, 4].map((k) => parseInt(hex.slice(k, k + 2), 16));
          if (isBlue(r, g, b)) found.push(`${rel}:${i + 1} #${hex}`);
        }
        for (const m of line.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
          if (isBlue(+m[1], +m[2], +m[3])) found.push(`${rel}:${i + 1} ${m[0]}`);
        }
      });
    }
  };
  walk(SRC);
  assert.deepEqual(found, [], `blue found:\n${found.join('\n')}`);
});

// ---- 2. shared chrome ---------------------------------------------------------------------------
const rule = (css, selector) => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `rule ${selector}`);
  return m[1];
};

test('employee AND admin layouts share the dark-green sidebar and light canvas (no white sidebar left to win by import order)', () => {
  const employeeSidebar = read('components/Layout/EmployeeSidebar.css');
  const adminSidebar = read('components/Layout/AdminSidebar.css');
  const employeeHome = read('pages/Employee/EmployeeHome.css');
  for (const [name, css, sel, active] of [['employee', employeeSidebar, '.employee-sidebar', '.employee-sidebar-item.active'], ['admin', adminSidebar, '.admin-sidebar', '.sidebar-item.active']]) {
    assert.match(rule(css, sel), /background:\s*var\(--sidebar-bg\)/, `${name} sidebar background`);
    assert.match(rule(css, active), /background:\s*var\(--sidebar-active\)/, `${name} active item`);
    assert.match(rule(css, active), /color:\s*#FFFFFF/, `${name} active text is white`);
  }
  // the duplicated shell selectors in EmployeeHome.css must agree (that file redeclares them)
  assert.match(rule(employeeHome, '.employee-sidebar'), /background:\s*var\(--sidebar-bg\)/);
  assert.match(rule(employeeHome, '.employee-layout'), /background:\s*var\(--canvas\)/);
  assert.match(rule(read('components/Layout/EmployeeLayout.css'), '.employee-layout'), /background:\s*var\(--canvas\)/);
  assert.match(adminSidebar, /\.admin-layout,[\s\S]*?background:\s*var\(--canvas\)/);
  assert.match(rule(read('components/Layout/SidebarToggleButton.css'), '.sidebar-toggle-button'), /background:\s*var\(--sidebar-bg\)/);
  // hover states and collapse/mobile behaviour are kept
  assert.match(rule(employeeSidebar, '.employee-sidebar-item:hover'), /var\(--sidebar-hover\)/);
  assert.match(employeeSidebar, /\.employee-sidebar\.collapsed \{[\s\S]*?width: 0;/);
  assert.match(employeeSidebar, /@media \(max-width: 1023px\)[\s\S]*?translateX\(-100%\)/);
});

test('keyboard focus is visible on the sidebar, header and dashboard controls', () => {
  assert.match(read('components/Layout/EmployeeSidebar.css'), /\.employee-sidebar-item:focus-visible[\s\S]*?outline: 2px solid #FFFFFF/);
  assert.match(read('components/Layout/AdminSidebar.css'), /\.sidebar-item:focus-visible[\s\S]*?outline: 2px solid #FFFFFF/);
  assert.match(read('components/Layout/EmployeeHeader.css'), /\.employee-notification-button:focus-visible[\s\S]*?var\(--focus-ring\)/);
  const home = read('pages/Employee/EmployeeHome.css');
  for (const sel of ['.dash-filter-tab:focus-visible', '.dash-quick-action-tile:focus-visible', '.dash-view-all-button:focus-visible']) assert.ok(home.includes(sel), sel);
  assert.ok(!/\.dash-[a-z-]+:focus-visible[^{]*\{[^}]*outline:\s*none;[^}]*\}/.test(home.replace(/box-shadow: var\(--focus-ring\);/g, 'X')) || /box-shadow: var\(--focus-ring\)/.test(home), 'focus is replaced by a ring, never just removed');
});

// ---- 3. employee dashboard ----------------------------------------------------------------------
const home = read('pages/Employee/EmployeeHome.jsx');

test('dashboard: decorative illustrations are gone, the greeting and compact welcome strip are in', () => {
  assert.ok(!fs.existsSync(path.join(SRC, 'pages/Employee/DashboardIllustrations.jsx')), 'illustration file removed');
  assert.ok(!/Illustration/.test(home), 'no illustration components used');
  assert.ok(!/dash-welcome-visual|dash-quote-bubble|dash-quote-panel/.test(home + read('pages/Employee/EmployeeHome.css')), 'no hero art / quote card');
  assert.match(home, /function getGreeting\(\)/);
  assert.match(home, /\{getGreeting\(\)\}, \{sessionUser\?\.fullName\}/);
  assert.match(home, /sessionUser\.designation/);
  assert.match(home, /<small>Employee ID<\/small>/);
  assert.match(home, /\{onlineChipLabel\}/, 'attendance status chip');
});

test('dashboard: KPI row sits full width ABOVE the main grid (the old layout overlapped the calendar); the four stats are intact', () => {
  assert.ok(home.indexOf('dash-kpi-grid') < home.indexOf('className="dash-main-grid"'), 'KPI row before the grid');
  for (const label of ["Today's Work Hours", 'Tasks Completed', 'Pending Tasks', 'Leave Requests']) assert.ok(home.includes(label), label);
  assert.match(home, /formatDuration\(todayTotalSeconds\)/);
  assert.match(home, /completedTasks\.length/);
  assert.match(home, /pendingTasks\.length/);
  assert.match(home, /pendingLeaves\.length/);
  const css = read('pages/Employee/EmployeeHome.css');
  assert.match(css, /\.dash-main-grid \{[^}]*grid-template-columns: minmax\(0, 1fr\) 330px;/);
  assert.match(css, /@media \(max-width: 1180px\)[\s\S]*?\.dash-main-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.dash-kpi-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.dash-kpi-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
});

test('dashboard: My Work filters, task navigation, calendar week and quick actions keep working and all point at existing routes', () => {
  for (const label of ['All', 'In Progress', 'Completed', 'Overdue']) assert.ok(new RegExp(`label: "${label}"`).test(home), `filter ${label}`);
  assert.match(home, /setWorkFilter\(filter\.key\)/);
  assert.match(home, /navigate\(`\$\{basePath\}\/task-workspace\/\$\{task\.id\}`\)/);
  assert.match(home, /onClick=\{\(\) => navigate\(`\$\{basePath\}\/tasks`\)\}/);
  assert.match(home, /thisWeek\.map\(\(day\)/);
  assert.match(home, /dash-week-day is-today/);
  // every link is built from the same base path the sidebar uses (works under /:companySlug/employee too)
  assert.match(home, /const basePath = companySlug \? `\/\$\{companySlug\}\/employee` : "\/employee";/);
  const routes = [...home.matchAll(/onClick: \(\) => navigate\(`\$\{basePath\}\/([a-z-]+)`\)/g)].map((m) => m[1]);
  assert.deepEqual(routes, ['attendance', 'leave', 'tasks']);
  assert.ok(!/navigate\("\/employee\//.test(home), 'no hard-coded /employee links left');
  // the schedule shortcut follows the sidebar's access rule (role / system_access, never designation)
  assert.match(home, /const shiftNav = getShiftNavItem\(sessionUser, basePath\);/);
  assert.match(home, /onClick: \(\) => navigate\(shiftNav\.path\)/);
  assert.match(home, /label: shiftNav\.name === "Shift Management" \? "Shift Management" : "View Schedule"/);
  const app = read('App.jsx');
  for (const r of ['attendance', 'shift-schedule', 'leave', 'tasks']) assert.ok(app.includes(`path: "${r}"`), `route ${r} still exists`);
  // one accent colour for the quick actions
  assert.ok(!/tone: "(blue|orange|purple)"/.test(home));
  const css = read('pages/Employee/EmployeeHome.css');
  assert.ok(!/tone-(blue|orange|purple)/.test(css));
  // real data, not mock data
  assert.match(home, /await getTasks\(\)/);
  assert.match(home, /"\/attendance\/status"/);
  assert.match(home, /"\/leaves\/my"/);
  assert.ok(!/mock|lorem|fakeTasks/i.test(home));
});

test('executive designations still get their own dashboard (access logic untouched)', () => {
  assert.match(home, /if \(showExecutiveDashboard\) \{\s*return <ExecutiveDashboard \/>;/);
  assert.match(home, /isExecutiveDashboardUser/);
});

// ---- 4. navigation + header ---------------------------------------------------------------------
test('every existing sidebar item is still there (labels, routes, access rules untouched)', () => {
  const sidebar = read('components/Layout/EmployeeSidebar.jsx');
  for (const label of ['Dashboard', 'Attendance', 'My Tasks', 'Projects', 'My Leave', 'My Reporting Manager', 'Hierarchy', 'My Team', 'Team Leave Approvals', 'My Profile', 'Chat', 'Email', 'Meetings', 'SOPs', 'Settings']) {
    assert.ok(sidebar.includes(`name: "${label}"`), `menu item ${label}`);
  }
  assert.match(sidebar, /\.\.\.shiftNav/, 'access-based Shift Management / Shift Schedule entry');
  assert.match(sidebar, /isExecutiveDashboardUser/);
  assert.match(sidebar, /showProjectsNavItem|hasProjectAccess/);
  assert.match(sidebar, /aria-label="Hide sidebar"/);
  assert.match(sidebar, /<CompanyLogo size=\{46\} \/>/, 'the real company logo component is used');
});

test('header: page title follows the route, notification / avatar / logout controls are kept and labelled', () => {
  const header = read('components/Layout/EmployeeHeader.jsx');
  assert.match(header, /\{getPageTitle\(pathname\)\}/);
  for (const [seg, title] of [['attendance', 'Attendance'], ['shift-management', 'Shift Management'], ['shift-schedule', 'Shift Schedule'], ['tasks', 'My Tasks'], ['leave', 'My Leave'], ['profile', 'My Profile'], ['team', 'My Team'], ['reporting-manager', 'My Reporting Manager'], ['hierarchy', 'Hierarchy'], ['chat', 'Chat']]) {
    assert.ok(new RegExp(`"?${seg}"?: "${title}"`).test(header), `${seg} -> ${title}`);
  }
  assert.match(header, /Team Leave Approvals/);
  assert.match(header, /aria-label="Notifications"/);
  assert.match(header, /Welcome back,/);
  assert.match(header, /employee-header-designation/);
  assert.match(header, /EmployeeProfileAvatar/);
  assert.match(header, /Logout|logout/);
  const css = read('components/Layout/EmployeeHeader.css');
  assert.match(rule(css, '.employee-header'), /min-height:\s*64px/);
  assert.match(rule(css, '.employee-notification-button'), /position:\s*relative/, 'unread badge sits on the bell');
  // narrow phones: the title wraps instead of running under the bell, and the duplicated header rule in EmployeeHome.css agrees
  assert.match(css, /@media \(max-width: 600px\) \{\s*\.employee-main \.employee-header \{\s*padding: 6px 12px;/);
  assert.match(css, /white-space: normal;/);
  assert.match(rule(read('pages/Employee/EmployeeHome.css'), '.employee-header'), /padding:\s*6px 24px/);
});
