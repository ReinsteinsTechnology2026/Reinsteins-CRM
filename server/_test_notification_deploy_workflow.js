// Static checks only: reads files, never connects to a database, never runs a migration.
// They guard the ORDER and fail-closed behavior of the deploy pipeline for the outbox migration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
// Comments may legitimately mention settings; only executable lines are checked.
const workflow = read('.github/workflows/deploy.yml')
  .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
const lines = workflow.split('\n');
const idx = (re) => lines.findIndex((l) => re.test(l.trim()));
const MIGRATION = 'server/_migrate_add_notification_email_outbox.js';
const migrationLines = lines
  .map((l, i) => [l.trim(), i])
  .filter(([l]) => /^node server\/_migrate_[a-z_]+\.js$/.test(l));

test('deploy: the outbox migration runs exactly once, after every other migration and before build/restart', () => {
  const mine = migrationLines.filter(([l]) => l === `node ${MIGRATION}`);
  assert.equal(mine.length, 1, 'exactly one outbox migration step');
  const at = mine[0][1];
  for (const [l, i] of migrationLines) if (l !== `node ${MIGRATION}`) assert.ok(i < at, `${l} must run before the outbox migration`);
  const build = idx(/^cd client$/);
  const restart = idx(/systemctl restart/);
  assert.ok(build > at, 'client build comes after the migration');
  assert.ok(restart > at, 'restart comes after the migration');
});

test('deploy: a failing migration must stop the deploy (set -e before the steps, nothing swallows the exit code)', () => {
  const setE = idx(/^set -e$/);
  assert.ok(setE >= 0 && setE < migrationLines[0][1], 'set -e precedes the first migration');
  assert.doesNotMatch(workflow, /set \+e/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /_migrate_add_notification_email_outbox\.js\s*(\|\||;|\|)/);
  assert.doesNotMatch(workflow, /node server\/_migrate_[a-z_]+\.js\s*\|\|\s*true/);
});

test('deploy: the pipeline does not enable email delivery or carry SMTP settings', () => {
  assert.doesNotMatch(workflow, /NOTIFICATION_EMAIL_ENABLED/);
  assert.doesNotMatch(workflow, /SMTP_(HOST|USER|PASS|PORT)/);
});

test('migration script: fails the process when any database fails, and when it cannot even start', () => {
  const src = read(MIGRATION);
  assert.match(src, /process\.exit\(failures === 0 \? 0 : 1\)/);
  assert.match(src, /\.catch\(\(error\) => \{[^}]*process\.exit\(1\)/);
  assert.match(src, /failures\+\+/);
});

test('migration script: loads server/.env by explicit path and refuses to run without database settings', () => {
  const src = read(MIGRATION);
  assert.match(src, /require\("dotenv"\)\.config\(\{ path: require\("path"\)\.join\(__dirname, "\.env"\) \}\)/);
  const guard = src.indexOf('Refusing to run');
  assert.ok(guard > 0, 'has the fail-closed guard');
  for (const name of ['DB_HOST', 'DB_NAME', 'PLATFORM_DB_HOST', 'PLATFORM_DB_NAME']) assert.ok(src.slice(0, guard).includes(name), name);
  // the guard runs before any pool module is required
  assert.ok(guard < src.indexOf('require("./config/db")'));
  assert.ok(guard < src.indexOf('require("./config/platformDb")'));
});

test('migration script: verifies the table and the due index after creating them', () => {
  const src = read(MIGRATION);
  assert.match(src, /to_regclass\('notification_email_outbox'\)/);
  assert.match(src, /idx_notification_email_outbox_due/);
  assert.match(src, /verification failed/);
});

test('every migration run by the deploy workflow loads .env by explicit path (a cwd-relative load finds nothing in CI)', () => {
  for (const [l] of migrationLines) {
    const file = l.replace('node ', '');
    assert.match(read(file), /dotenv"\)\.config\(\{ path: require\("path"\)\.join\(__dirname, "\.env"\) \}\)/, file);
  }
});

test('the application never runs the migration or DDL by itself at startup', () => {
  const serverDir = path.join(ROOT, 'server');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'uploads') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js') && !e.name.startsWith('_')) {
        const src = fs.readFileSync(full, 'utf8');
        if (/_migrate_add_notification_email_outbox/.test(src.replace(/\/\/.*$/gm, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""'))) offenders.push(e.name);
        if (/\b(dueIndexSql|schema)\b/.test(src) && /require\([^)]*notificationEmailOutbox/.test(src)
          && /\{[^}]*\b(dueIndexSql|schema)\b[^}]*\}\s*=\s*require\([^)]*notificationEmailOutbox/.test(src)) offenders.push(`${e.name} imports the DDL`);
      }
    }
  };
  walk(serverDir);
  assert.deepEqual(offenders, []);
  assert.doesNotMatch(read('server/app.js'), /_migrate_/);
});

test('NOTIFICATION_EMAIL_ENABLED is documented as opt-in, not enabled by default in .env.example', () => {
  const example = read('server/.env.example');
  assert.doesNotMatch(example, /^NOTIFICATION_EMAIL_ENABLED=/m);
  assert.match(example, /^# NOTIFICATION_EMAIL_ENABLED=true$/m);
});
