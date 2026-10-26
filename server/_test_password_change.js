// Mandatory password change: challenge token, login branching, forced-change endpoint, session
// enforcement (REST + sockets wiring), tenant isolation, migration, and the client wiring.
// In-memory fake databases only -- no PostgreSQL, no network, no production data.
process.env.JWT_SECRET = 'test-legacy-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
process.env.TENANT_JWT_SECRET = 'test-tenant-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbb';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------- fakes
const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const rowsOf = (list, extra = {}) => Object.assign([...list], extra);

// An in-memory `users` table that answers exactly the statements the code under test issues (and
// throws on any other, so a changed query is noticed instead of silently ignored).
function makeUserStore(users) {
  const log = [];
  const find = (id) => users.find((u) => u.id === id);
  const query = async (sql, params = []) => {
    const q = norm(sql);
    log.push({ q, params });
    if (/FROM users WHERE employee_id = \? OR LOWER\(email\) = LOWER\(\?\) LIMIT 1/.test(q)) {
      return [rowsOf(users.filter((u) => u.employee_id === params[0] || String(u.email || '').toLowerCase() === String(params[1]).toLowerCase()).slice(0, 1))];
    }
    if (/^SELECT id, employee_id, full_name, email, password, role, status, employment_status, system_access, designation, must_change_password FROM users WHERE id = \? LIMIT 1$/.test(q)) {
      return [rowsOf(users.filter((u) => u.id === params[0]))];
    }
    if (/^SELECT id, employee_id, full_name, email, role, designation, system_access, project_access_override FROM users WHERE id = \? LIMIT 1$/.test(q)) {
      return [rowsOf(users.filter((u) => u.id === params[0]))];
    }
    if (/^UPDATE users SET password = \?, must_change_password = FALSE, password_changed_at = NOW\(\) WHERE id = \? AND must_change_password = TRUE AND password = \?$/.test(q)) {
      const u = find(params[1]);
      if (u && u.must_change_password === true && u.password === params[2]) {
        u.password = params[0];
        u.must_change_password = false;
        u.password_changed_at = new Date();
        return [rowsOf([], { affectedRows: 1 })];
      }
      return [rowsOf([], { affectedRows: 0 })];
    }
    if (/^UPDATE users SET last_login = NOW\(\) WHERE id = \?$/.test(q)) return [rowsOf([], { affectedRows: 1 })];
    if (/^SELECT id, employee_id, role, status, employment_status, system_access, must_change_password, password_changed_at FROM users WHERE id = \? LIMIT 1$/.test(q)) {
      return [rowsOf(users.filter((u) => u.id === params[0]))];
    }
    if (/^SELECT must_change_password, password_changed_at FROM users WHERE id = \? LIMIT 1$/.test(q)) {
      return [rowsOf(users.filter((u) => u.id === params[0]))];
    }
    throw new Error('unexpected SQL in test: ' + q);
  };
  return { users, query, log };
}

const TEMP = 'Temp#Pass123';
const HASH_ROUNDS = 4; // test fixtures only
const makeUser = (over = {}) => ({
  id: 1, employee_id: 'EMP001', full_name: 'Asha Rao', email: 'asha@acme.test', password: bcrypt.hashSync(TEMP, HASH_ROUNDS),
  role: 'employee', status: 'active', employment_status: 'active', system_access: 'employee', designation: 'Engineer',
  project_access_override: null, must_change_password: true, password_changed_at: null, ...over,
});

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

// ---- tenant fakes: two companies, each with its OWN database
const platformCompanyService = require('./services/platformCompanyService');
const tenantConnectionManager = require('./config/tenantConnectionManager');
const companies = {
  acme: { id: 1, company_slug: 'acme', company_name: 'Acme Co', status: 'active' },
  other: { id: 2, company_slug: 'other', company_name: 'Other Co', status: 'active' },
};
const tenantStores = { 1: makeUserStore([]), 2: makeUserStore([]) };
platformCompanyService.getCompanyBySlug = async (slug) => companies[slug] || null;
platformCompanyService.getCompanyById = async (id) => Object.values(companies).find((c) => c.id === id) || null;
platformCompanyService.isCompanyAccessAllowed = () => true;
tenantConnectionManager.getTenantPoolForCompany = (company) => tenantStores[company.id];

const tenantAuth = require('./controllers/tenantAuthController');
const legacyAuth = require('./controllers/authController');
const { tenantProtect } = require('./middleware/tenantAuthMiddleware');
const { protect } = require('./middleware/authMiddleware');
const db = require('./config/db');
const challenge = require('./utils/passwordChangeChallenge');
const { checkPasswordSessionState } = require('./utils/passwordSessionState');

function useLegacyStore(users) {
  const store = makeUserStore(users);
  const original = db.query;
  db.query = store.query;
  return { store, restore: () => { db.query = original; } };
}
function useTenantStore(companyId, users) {
  tenantStores[companyId] = makeUserStore(users);
  return tenantStores[companyId];
}

const tenantLogin = (slug, employeeId, password) => {
  const res = fakeRes();
  return tenantAuth.login({ params: { companySlug: slug }, body: { employeeId, password } }, res).then(() => res);
};
const tenantForce = (slug, challengeToken, body) => {
  const res = fakeRes();
  return tenantAuth.forceChangePassword({ params: { companySlug: slug }, headers: { authorization: challengeToken ? `Bearer ${challengeToken}` : undefined }, body }, res).then(() => res);
};
const legacyLogin = (employeeId, password) => {
  const res = fakeRes();
  return legacyAuth.login({ body: { employeeId, password } }, res).then(() => res);
};
const legacyForce = (challengeToken, body) => {
  const res = fakeRes();
  return legacyAuth.forceChangePassword({ headers: { authorization: challengeToken ? `Bearer ${challengeToken}` : undefined }, body }, res).then(() => res);
};
const GOOD_NEW = 'Brand#New2026pw';
const goodBody = (over = {}) => ({ temporaryPassword: TEMP, newPassword: GOOD_NEW, confirmPassword: GOOD_NEW, ...over });
const runProtect = async (mw, token) => {
  const res = fakeRes(); let nextCalled = false; const req = { headers: { authorization: `Bearer ${token}` } };
  await mw(req, res, () => { nextCalled = true; });
  return { res, nextCalled, req };
};

// ================================================================ challenge token
test('challenge token: signed with a DERIVED key, so no normal session check will ever accept it', () => {
  const token = challenge.signChallenge({ scope: 'tenant', userId: 1, passwordHash: 'h1', companyId: 1, companySlug: 'acme' });
  const ok = challenge.verifyChallenge(token, 'tenant');
  assert.equal(ok.ok, true);
  assert.equal(ok.claims.userId, 1);
  assert.equal(ok.claims.type, 'password_change_challenge');

  // neither raw secret verifies it
  assert.throws(() => jwt.verify(token, process.env.TENANT_JWT_SECRET, { algorithms: ['HS256'] }));
  assert.throws(() => jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] }));
  assert.throws(() => jwt.verify(token, process.env.TENANT_JWT_SECRET, { issuer: 'groworgs-tenant', audience: 'groworgs-tenant-user' }));

  // a challenge for one login type does not verify as the other
  assert.equal(challenge.verifyChallenge(token, 'legacy').ok, false);
  const legacyToken = challenge.signChallenge({ scope: 'legacy', userId: 1, passwordHash: 'h1' });
  assert.equal(challenge.verifyChallenge(legacyToken, 'tenant').ok, false);
  assert.equal(challenge.verifyChallenge(legacyToken, 'legacy').ok, true);
});

test('challenge token: ordinary session tokens, garbage, tampering and missing tokens are all refused', () => {
  const tenantSession = jwt.sign({ userId: 1, companyId: 1, companySlug: 'acme', type: 'tenant_user' }, process.env.TENANT_JWT_SECRET, { expiresIn: '8h', issuer: 'groworgs-tenant', audience: 'groworgs-tenant-user' });
  const legacySession = jwt.sign({ id: 1, employeeId: 'EMP001', role: 'employee' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  for (const bad of [tenantSession, legacySession, 'garbage', '', undefined, null]) {
    assert.equal(challenge.verifyChallenge(bad, 'tenant').ok, false);
    assert.equal(challenge.verifyChallenge(bad, 'legacy').ok, false);
  }
  const good = challenge.signChallenge({ scope: 'legacy', userId: 1, passwordHash: 'h' });
  const [h, p, s] = good.split('.');
  const tampered = [h, Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), userId: 2 })).toString('base64url'), s].join('.');
  assert.equal(challenge.verifyChallenge(tampered, 'legacy').ok, false, 'changing the user id breaks the signature');
  const noneAlg = [Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'), p, ''].join('.');
  assert.equal(challenge.verifyChallenge(noneAlg, 'legacy').ok, false, 'alg none refused');
});

test('challenge token: expires after 10 minutes, and goes stale when the password changes', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 9, 25, 10, 0, 0) });
  const token = challenge.signChallenge({ scope: 'legacy', userId: 7, passwordHash: 'old-hash' });
  const claims = challenge.verifyChallenge(token, 'legacy').claims;
  assert.equal(challenge.fingerprintMatches(claims, 'old-hash'), true);
  assert.equal(challenge.fingerprintMatches(claims, 'new-hash'), false, 'a changed password invalidates the old challenge');
  t.mock.timers.tick(9 * 60 * 1000);
  assert.equal(challenge.verifyChallenge(token, 'legacy').ok, true, 'still valid at 9 minutes');
  t.mock.timers.tick(2 * 60 * 1000);
  const expired = challenge.verifyChallenge(token, 'legacy');
  assert.deepEqual([expired.ok, expired.reason], [false, 'expired']);
});

// ================================================================ session state rule
test('session state: pending accounts and sessions older than the last forced change are refused', () => {
  assert.equal(checkPasswordSessionState({ must_change_password: false, password_changed_at: null }, 1000).allowed, true);
  assert.equal(checkPasswordSessionState(undefined, 1000).allowed, true, 'a user without the columns is not affected');
  const flagged = checkPasswordSessionState({ must_change_password: true }, 1000);
  assert.deepEqual([flagged.allowed, flagged.code], [false, 'PASSWORD_CHANGE_REQUIRED']);
  const changedAt = new Date(Date.UTC(2026, 9, 25, 10, 0, 30));
  const stale = checkPasswordSessionState({ must_change_password: false, password_changed_at: changedAt }, Math.floor(changedAt / 1000) - 1);
  assert.deepEqual([stale.allowed, stale.code], [false, 'SESSION_SUPERSEDED']);
  assert.equal(checkPasswordSessionState({ must_change_password: false, password_changed_at: changedAt }, Math.floor(changedAt / 1000)).allowed, true, 'issued in the same second as the change is the NEW session');
  assert.equal(checkPasswordSessionState({ must_change_password: false, password_changed_at: changedAt }, undefined).allowed, false, 'no iat cannot be proven newer');
});

// ================================================================ tenant login + forced change
test('tenant login: an employee with a temporary password gets a challenge and NO session', async () => {
  useTenantStore(1, [makeUser()]);
  const res = await tenantLogin('acme', 'EMP001', TEMP);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.passwordChangeRequired, true);
  assert.ok(res.body.challengeToken);
  assert.equal(res.body.token, undefined, 'no session token is issued');
  assert.deepEqual(Object.keys(res.body.user).sort(), ['employeeId', 'fullName'], 'only what the page needs');
  assert.equal(res.body.passwordPolicy.minLength >= 8, true);
  assert.equal(res.body.user.password, undefined);
  assert.ok(!JSON.stringify(res.body).includes(tenantStores[1].users[0].password), 'the hash never leaves the server');
  assert.ok(!tenantStores[1].log.some((l) => /last_login/.test(l.q)), 'a pending login does not record a sign-in');
});

test('tenant login: wrong password and inactive accounts behave as before (no challenge)', async () => {
  useTenantStore(1, [makeUser(), makeUser({ id: 2, employee_id: 'EMP002', email: 'b@acme.test', status: 'inactive' })]);
  const wrong = await tenantLogin('acme', 'EMP001', 'nope');
  assert.equal(wrong.statusCode, 401);
  assert.equal(wrong.body.challengeToken, undefined);
  const inactive = await tenantLogin('acme', 'EMP002', TEMP);
  assert.equal(inactive.statusCode, 403);
  assert.equal(inactive.body.challengeToken, undefined);
});

test('tenant login: unflagged employees, Admin and Super Admin log in normally and are never asked to change', async () => {
  useTenantStore(1, [
    makeUser({ id: 1, must_change_password: false }),
    makeUser({ id: 2, employee_id: 'ADM001', email: 'adm@acme.test', role: 'admin', system_access: 'admin', must_change_password: false }),
    makeUser({ id: 3, employee_id: 'SUP001', email: 'sup@acme.test', role: 'employee', system_access: 'super_admin', must_change_password: false }),
  ]);
  for (const id of ['EMP001', 'ADM001', 'SUP001']) {
    const res = await tenantLogin('acme', id, TEMP);
    assert.equal(res.statusCode, 200, id);
    assert.ok(res.body.token, `${id} gets a normal session`);
    assert.equal(res.body.passwordChangeRequired, undefined);
    const decoded = jwt.verify(res.body.token, process.env.TENANT_JWT_SECRET, { issuer: 'groworgs-tenant', audience: 'groworgs-tenant-user' });
    assert.equal(decoded.type, 'tenant_user');
  }
});

test('forced change (tenant): wrong temporary password, mismatch, weak and reused passwords are refused and nothing changes', async () => {
  const store = useTenantStore(1, [makeUser()]);
  const before = store.users[0].password;
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;

  const cases = [
    [goodBody({ temporaryPassword: 'wrong' }), /temporary password is incorrect/i],
    [goodBody({ confirmPassword: GOOD_NEW + 'x' }), /do not match/i],
    [goodBody({ newPassword: 'short1A', confirmPassword: 'short1A' }), /at least \d+ characters/i],
    [goodBody({ newPassword: 'alllowercase123', confirmPassword: 'alllowercase123' }), /uppercase/i],
    [goodBody({ newPassword: 'ALLUPPERCASE123', confirmPassword: 'ALLUPPERCASE123' }), /lowercase/i],
    [goodBody({ newPassword: 'NoDigitsHereAtAll', confirmPassword: 'NoDigitsHereAtAll' }), /number/i],
    [{ temporaryPassword: TEMP, newPassword: '', confirmPassword: '' }, /required/i],
    [{}, /required/i],
  ];
  for (const [body, message] of cases) {
    const res = await tenantForce('acme', challengeToken, body);
    if (message) { assert.equal(res.statusCode, 400, JSON.stringify(body)); assert.match(res.body.message, message); }
    assert.equal(store.users[0].password, before, 'password untouched');
    assert.equal(store.users[0].must_change_password, true, 'still pending');
  }
  // the new password may not equal the temporary one
  const same = await tenantForce('acme', challengeToken, { temporaryPassword: TEMP, newPassword: TEMP, confirmPassword: TEMP });
  assert.equal(same.statusCode, 400);
  assert.equal(store.users[0].must_change_password, true);
});

test('forced change (tenant): success hashes the password, clears the flag, issues a session; normal login then works, the temporary password does not', async () => {
  const store = useTenantStore(1, [makeUser()]);
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;

  const res = await tenantForce('acme', challengeToken, goodBody());
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.token, 'a normal session is issued so the user can go straight in');
  assert.equal(res.body.user.role, 'employee');
  assert.equal(res.body.company.slug, 'acme');
  assert.equal(JSON.stringify(res.body).includes(GOOD_NEW), false, 'the new password is never echoed');

  const u = store.users[0];
  assert.equal(u.must_change_password, false);
  assert.ok(u.password_changed_at instanceof Date);
  assert.notEqual(u.password, GOOD_NEW, 'never stored in plaintext');
  assert.match(u.password, /^\$2[aby]\$12\$/, 'bcrypt, cost 12 (same as every other write path)');
  assert.equal(await bcrypt.compare(GOOD_NEW, u.password), true);
  assert.ok(!JSON.stringify(store.log).includes(GOOD_NEW), 'the plaintext never reached a query');

  // subsequent login: normal, no challenge
  const again = await tenantLogin('acme', 'EMP001', GOOD_NEW);
  assert.equal(again.statusCode, 200);
  assert.ok(again.body.token);
  assert.equal(again.body.passwordChangeRequired, undefined, 'asked ONCE, not on every login');
  assert.equal((await tenantLogin('acme', 'EMP001', TEMP)).statusCode, 401, 'the temporary password no longer works');

  // the session it issued is accepted by the real middleware
  const accepted = await runProtect(tenantProtect, res.body.token);
  assert.equal(accepted.nextCalled, true);
  assert.equal(accepted.req.user.id, 1);

  // replay: the same challenge cannot be used again
  const replay = await tenantForce('acme', challengeToken, goodBody({ temporaryPassword: GOOD_NEW, newPassword: GOOD_NEW + '2', confirmPassword: GOOD_NEW + '2' }));
  assert.equal(replay.statusCode, 401);
  assert.equal(replay.body.code, 'CHALLENGE_INVALID');
});

test('forced change (tenant): missing, invalid, expired and wrong-purpose challenges are rejected', async (t) => {
  useTenantStore(1, [makeUser()]);
  assert.equal((await tenantForce('acme', undefined, goodBody())).statusCode, 401, 'no token');
  assert.equal((await tenantForce('acme', 'garbage', goodBody())).statusCode, 401, 'garbage');

  const session = jwt.sign({ userId: 1, companyId: 1, companySlug: 'acme', type: 'tenant_user' }, process.env.TENANT_JWT_SECRET, { expiresIn: '8h', issuer: 'groworgs-tenant', audience: 'groworgs-tenant-user' });
  assert.equal((await tenantForce('acme', session, goodBody())).statusCode, 401, 'a normal session token is not a challenge');

  const legacyChallenge = challenge.signChallenge({ scope: 'legacy', userId: 1, passwordHash: tenantStores[1].users[0].password });
  assert.equal((await tenantForce('acme', legacyChallenge, goodBody())).statusCode, 401, 'a legacy challenge is not a tenant challenge');

  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;
  t.mock.timers.tick(11 * 60 * 1000);
  const expired = await tenantForce('acme', challengeToken, goodBody());
  assert.equal(expired.statusCode, 401);
  assert.equal(expired.body.code, 'CHALLENGE_EXPIRED');
  assert.equal(tenantStores[1].users[0].must_change_password, true);
});

test('forced change: the user comes ONLY from the challenge -- nobody can change another user\'s password through it', async () => {
  const store = useTenantStore(1, [
    makeUser({ id: 1, employee_id: 'EMP001' }),
    makeUser({ id: 2, employee_id: 'EMP002', email: 'b@acme.test', password: bcrypt.hashSync('Other#Temp456', HASH_ROUNDS), full_name: 'Ben' }),
  ]);
  const victimHash = store.users[1].password;
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;

  // the body names someone else in every way a client could try
  const res = await tenantForce('acme', challengeToken, { ...goodBody(), userId: 2, id: 2, employeeId: 'EMP002', email: 'b@acme.test' });
  assert.equal(res.statusCode, 200);
  assert.equal(store.users[1].password, victimHash, 'EMP002\'s password was not touched');
  assert.equal(store.users[1].must_change_password, true, 'EMP002 is still pending');
  assert.equal(store.users[0].must_change_password, false, 'only the challenge owner changed');
  const update = store.log.find((l) => /^UPDATE users SET password/.test(l.q));
  assert.equal(update.params[1], 1, 'the UPDATE targets the challenge owner only');

  // and the victim's temporary password is useless for the attacker's challenge
  const { challengeToken: attackerToken } = (await tenantLogin('acme', 'EMP002', 'Other#Temp456')).body;
  const crossed = await tenantForce('acme', attackerToken, goodBody({ temporaryPassword: TEMP }));
  assert.equal(crossed.statusCode, 400, 'the challenge owner must supply THEIR OWN temporary password');
});

test('tenant isolation: a challenge works only for the company it was issued for', async () => {
  const acme = useTenantStore(1, [makeUser({ id: 1 })]);
  const other = useTenantStore(2, [makeUser({ id: 1, full_name: 'Someone Else' })]);
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;

  const wrongTenant = await tenantForce('other', challengeToken, goodBody());
  assert.equal(wrongTenant.statusCode, 401, 'acme\'s challenge is refused at /other/...');
  assert.equal(other.users[0].must_change_password, true, 'the other tenant\'s user (same numeric id) is untouched');
  assert.equal(acme.users[0].must_change_password, true, 'and nothing happened in acme either');

  assert.equal((await tenantForce('does-not-exist', challengeToken, goodBody())).statusCode, 404);
  assert.equal((await tenantForce('Bad Slug!', challengeToken, goodBody())).statusCode, 404);

  const ok = await tenantForce('acme', challengeToken, goodBody());
  assert.equal(ok.statusCode, 200);
  assert.equal(other.users[0].must_change_password, true);
  assert.equal(jwt.decode(ok.body.token).companySlug, 'acme');
});

test('forced change: an account that became inactive, or is no longer pending, is refused', async () => {
  const store = useTenantStore(1, [makeUser()]);
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;
  store.users[0].status = 'inactive';
  assert.equal((await tenantForce('acme', challengeToken, goodBody())).statusCode, 403);
  store.users[0].status = 'active';
  store.users[0].must_change_password = false; // an administrator cleared it meanwhile
  assert.equal((await tenantForce('acme', challengeToken, goodBody())).statusCode, 401);
});

test('forced change: a double submit applies once (conditional UPDATE)', async () => {
  const store = useTenantStore(1, [makeUser()]);
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;
  const results = await Promise.all([tenantForce('acme', challengeToken, goodBody()), tenantForce('acme', challengeToken, goodBody())]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [200, 401], 'exactly one succeeds');
  assert.equal(store.log.filter((l) => /^UPDATE users SET password/.test(l.q)).length >= 1, true);
  assert.equal(store.users[0].must_change_password, false);
});

// ================================================================ enforcement on protected APIs
test('tenantProtect: a challenge token can NOT open any protected API', async () => {
  useTenantStore(1, [makeUser()]);
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;
  const r = await runProtect(tenantProtect, challengeToken);
  assert.equal(r.res.statusCode, 401);
  assert.equal(r.nextCalled, false);
  // ...and the generic `protect` (used by every route file) refuses it too, on both paths
  const generic = await runProtect(protect, challengeToken);
  assert.equal(generic.res.statusCode, 401);
  assert.equal(generic.nextCalled, false);
});

test('tenantProtect: a session issued BEFORE the account was flagged stops working (401 PASSWORD_CHANGE_REQUIRED)', async () => {
  const store = useTenantStore(1, [makeUser({ must_change_password: false })]);
  const old = (await tenantLogin('acme', 'EMP001', TEMP)).body.token;
  assert.equal((await runProtect(tenantProtect, old)).nextCalled, true, 'valid while not flagged');
  store.users[0].must_change_password = true; // the one-time reset rolls out while this session is open
  const blocked = await runProtect(tenantProtect, old);
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.res.statusCode, 401);
  assert.equal(blocked.res.body.code, 'PASSWORD_CHANGE_REQUIRED');
});

test('tenantProtect: sessions older than the forced change are rotated out; the session issued by the change works', async () => {
  const store = useTenantStore(1, [makeUser()]);
  const now = Math.floor(Date.now() / 1000);
  const stale = jwt.sign({ userId: 1, companyId: 1, companySlug: 'acme', type: 'tenant_user', iat: now - 3600 }, process.env.TENANT_JWT_SECRET, { expiresIn: '8h', issuer: 'groworgs-tenant', audience: 'groworgs-tenant-user' });
  const { challengeToken } = (await tenantLogin('acme', 'EMP001', TEMP)).body;
  const changed = await tenantForce('acme', challengeToken, goodBody());
  assert.equal(changed.statusCode, 200);
  const rejected = await runProtect(tenantProtect, stale);
  assert.equal(rejected.nextCalled, false);
  assert.equal(rejected.res.body.code, 'SESSION_SUPERSEDED');
  assert.equal((await runProtect(tenantProtect, changed.body.token)).nextCalled, true);
  assert.ok(store.users[0].password_changed_at);
});

test('tenantProtect: normal sessions for unflagged employees, Admin and Super Admin are unaffected', async () => {
  useTenantStore(1, [
    makeUser({ id: 1, must_change_password: false }),
    makeUser({ id: 2, employee_id: 'ADM001', email: 'adm@acme.test', role: 'admin', system_access: 'admin', must_change_password: false }),
    makeUser({ id: 3, employee_id: 'SUP001', email: 'sup@acme.test', system_access: 'super_admin', must_change_password: false }),
  ]);
  for (const id of ['EMP001', 'ADM001', 'SUP001']) {
    const token = (await tenantLogin('acme', id, TEMP)).body.token;
    const r = await runProtect(tenantProtect, token);
    assert.equal(r.nextCalled, true, id);
    assert.equal(r.req.user.employeeId, id);
  }
});

// ================================================================ legacy login
test('legacy login: pending account -> challenge only; then forced change -> normal session and normal login', async () => {
  const { store, restore } = useLegacyStore([makeUser({ id: 5, employee_id: 'RS005', email: 'rs5@reinsteins.test' })]);
  try {
    // a legacy login whose SELECT includes project_access_override: answer it from the same table
    const origQuery = db.query;
    db.query = async (sql, params) => {
      if (/project_access_override, must_change_password FROM users WHERE employee_id/.test(norm(sql))) {
        return store.query('SELECT x FROM users WHERE employee_id = ? OR LOWER(email) = LOWER(?) LIMIT 1', params).catch(() => [rowsOf([])]);
      }
      return origQuery(sql, params);
    };
    // the legacy login SQL differs only by column list; route it to the same lookup
    const lookup = norm('x FROM users WHERE employee_id = ? OR LOWER(email) = LOWER(?) LIMIT 1');
    assert.ok(lookup);
    db.query = async (sql, params) => {
      const q = norm(sql);
      if (/FROM users WHERE employee_id = \? OR LOWER\(email\) = LOWER\(\?\) LIMIT 1$/.test(q)) {
        return [rowsOf(store.users.filter((u) => u.employee_id === params[0] || u.email === params[1]).slice(0, 1))];
      }
      return store.query(sql, params);
    };

    const pending = await legacyLogin('RS005', TEMP);
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.body.passwordChangeRequired, true);
    assert.equal(pending.body.token, undefined);
    assert.ok(pending.body.challengeToken);
    assert.equal(challenge.verifyChallenge(pending.body.challengeToken, 'legacy').ok, true);

    const weak = await legacyForce(pending.body.challengeToken, goodBody({ newPassword: 'weak', confirmPassword: 'weak' }));
    assert.equal(weak.statusCode, 400);
    assert.equal((await legacyForce(pending.body.challengeToken, goodBody({ temporaryPassword: 'nope' }))).statusCode, 400);
    assert.equal((await legacyForce(pending.body.challengeToken, goodBody({ confirmPassword: 'different' }))).statusCode, 400);
    assert.equal((await legacyForce('garbage', goodBody())).statusCode, 401);
    assert.equal(store.users[0].must_change_password, true);

    const done = await legacyForce(pending.body.challengeToken, goodBody());
    assert.equal(done.statusCode, 200);
    assert.ok(done.body.token);
    assert.equal(jwt.verify(done.body.token, process.env.JWT_SECRET).id, 5);
    assert.equal(store.users[0].must_change_password, false);

    const normal = await legacyLogin('RS005', GOOD_NEW);
    assert.equal(normal.statusCode, 200);
    assert.ok(normal.body.token);
    assert.equal(normal.body.passwordChangeRequired, undefined);
    assert.equal((await legacyLogin('RS005', TEMP)).statusCode, 401);
  } finally { restore(); }
});

test('legacy protect: pending / superseded sessions are refused, a challenge never opens an API, others pass', async () => {
  const users = [makeUser({ id: 9, must_change_password: false })];
  const { store, restore } = useLegacyStore(users);
  try {
    const session = jwt.sign({ id: 9, employeeId: 'EMP001', role: 'employee' }, process.env.JWT_SECRET, { expiresIn: '8h' });
    assert.equal((await runProtect(protect, session)).nextCalled, true);

    store.users[0].must_change_password = true;
    const blocked = await runProtect(protect, session);
    assert.equal(blocked.nextCalled, false);
    assert.equal(blocked.res.body.code, 'PASSWORD_CHANGE_REQUIRED');

    store.users[0].must_change_password = false;
    store.users[0].password_changed_at = new Date(Date.now() + 60 * 1000);
    const stale = await runProtect(protect, session);
    assert.equal(stale.nextCalled, false);
    assert.equal(stale.res.body.code, 'SESSION_SUPERSEDED');

    const ch = challenge.signChallenge({ scope: 'legacy', userId: 9, passwordHash: 'x' });
    assert.equal((await runProtect(protect, ch)).nextCalled, false);
  } finally { restore(); }
});

// ================================================================ migration
const migration = require('./_migrate_add_must_change_password');

function makeMigrationPool({ hasFlag = false, hasChangedAt = false, affected = 4, failOn = null, onLock = null, canAlter = true } = {}) {
  const statements = []; const events = [];
  const state = { hasFlag, hasChangedAt };
  const columnRows = (col) => rowsOf((col === 'must_change_password' ? state.hasFlag : state.hasChangedAt) ? [{ '?column?': 1 }] : []);
  // answers both the pool (pre-check) and the transaction connection, from the same state
  const answer = async (sql, params = []) => {
    const q = norm(sql); statements.push(q);
    if (failOn && failOn.test(q)) throw new Error('boom');
    if (/information_schema\.columns/.test(q)) return [columnRows(params[0])];
    if (/^SET LOCAL lock_timeout/.test(q)) return [rowsOf([])];
    if (/pg_advisory_xact_lock/.test(q)) { if (onLock) onLock(state); return [rowsOf([])]; }
    if (/pg_has_role\(current_user/.test(q)) return [rowsOf(canAlter === null ? [] : [{ can_alter: canAlter }])];
    if (/SELECT COUNT\(\*\)/.test(q)) return [rowsOf([{ n: affected }])];
    if (/ADD COLUMN IF NOT EXISTS must_change_password/.test(q)) { state.hasFlag = true; return [rowsOf([], { affectedRows: 0 })]; }
    if (/ADD COLUMN IF NOT EXISTS password_changed_at/.test(q)) { state.hasChangedAt = true; return [rowsOf([], { affectedRows: 0 })]; }
    if (/^UPDATE users SET must_change_password/.test(q)) return [rowsOf([], { affectedRows: affected })];
    throw new Error('unexpected migration query ' + q);
  };
  return {
    statements, events, state,
    query: answer,
    async getConnection() {
      events.push('connect');
      return {
        query: answer,
        beginTransaction: async () => events.push('begin'),
        commit: async () => events.push('commit'),
        rollback: async () => events.push('rollback'),
        release: () => events.push('release'),
      };
    },
  };
}

test('migration: first run adds both columns and flags employees in ONE transaction', async () => {
  const pool = makeMigrationPool({ affected: 7 });
  const quiet = console.log; console.log = () => {};
  let summary; try { summary = await migration.migrateDatabase('acme', pool); } finally { console.log = quiet; }
  assert.deepEqual([summary.action, summary.flagged], ['migrated', 7]);
  assert.deepEqual(pool.events, ['connect', 'begin', 'commit', 'release'], 'transactional');
  const writes = pool.statements.filter((s) => /^(ALTER|UPDATE)/.test(s));
  assert.equal(writes.length, 3);
  assert.match(writes[0], /ADD COLUMN IF NOT EXISTS password_changed_at timestamptz/);
  assert.match(writes[1], /ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT FALSE/);
  assert.match(writes[2], /^UPDATE users SET must_change_password = TRUE WHERE role = 'employee' AND COALESCE\(system_access, 'employee'\) NOT IN \('admin', 'super_admin'\) AND status <> 'pending'$/);
  assert.ok(pool.statements.indexOf(writes[1]) < pool.statements.indexOf(writes[2]), 'the flag column exists before it is set');
});

test('migration: a repeated run is a no-op -- nobody who already changed their password is flagged again', async () => {
  const pool = makeMigrationPool({ hasFlag: true, hasChangedAt: true });
  const quiet = console.log; console.log = () => {};
  let summary; try { summary = await migration.migrateDatabase('acme', pool); } finally { console.log = quiet; }
  assert.deepEqual([summary.action, summary.flagged], ['skipped', 0]);
  assert.deepEqual(pool.events, [], 'no connection, no transaction');
  assert.equal(pool.statements.filter((s) => /^(ALTER|UPDATE|INSERT|DELETE|DROP|TRUNCATE)/.test(s)).length, 0);
});

test('migration: a database that already has the flag but lacks password_changed_at only gains that column (no re-flagging)', async () => {
  const pool = makeMigrationPool({ hasFlag: true, hasChangedAt: false });
  const quiet = console.log; console.log = () => {};
  try { await migration.migrateDatabase('acme', pool); } finally { console.log = quiet; }
  const writes = pool.statements.filter((s) => /^(ALTER|UPDATE)/.test(s));
  assert.equal(writes.length, 1);
  assert.match(writes[0], /ADD COLUMN IF NOT EXISTS password_changed_at/);
});

test('migration: --dry-run writes nothing and reports what it would do', async () => {
  const pool = makeMigrationPool({ affected: 12 });
  const lines = []; const quiet = console.log; console.log = (m) => lines.push(m);
  let summary; try { summary = await migration.migrateDatabase('acme', pool, { dryRun: true }); } finally { console.log = quiet; }
  assert.deepEqual([summary.action, summary.flagged], ['dry-run', 12]);
  assert.deepEqual(pool.events, []);
  assert.equal(pool.statements.filter((s) => /^(ALTER|UPDATE)/.test(s)).length, 0);
  assert.match(lines.join('\n'), /would add .*flag 12 employee account/);
});

test('migration: a failure rolls the whole database back and is reported', async () => {
  const pool = makeMigrationPool({ failOn: /^UPDATE users SET must_change_password/ });
  await assert.rejects(() => migration.migrateDatabase('acme', pool), /boom/);
  assert.deepEqual(pool.events, ['connect', 'begin', 'rollback', 'release']);
});

test('migration: the decision is made INSIDE the transaction under a lock -- an overlapping run cannot re-flag', async () => {
  // the pre-check sees "missing", but by the time this run holds the lock another run has finished
  const pool = makeMigrationPool({ onLock: (state) => { state.hasFlag = true; state.hasChangedAt = true; } });
  const quiet = console.log; console.log = () => {};
  let summary; try { summary = await migration.migrateDatabase('acme', pool); } finally { console.log = quiet; }
  assert.deepEqual([summary.action, summary.flagged], ['skipped', 0]);
  assert.equal(pool.statements.filter((s) => /^(ALTER|UPDATE)/.test(s)).length, 0, 'no ALTER, and above all NO flagging UPDATE');
  assert.deepEqual(pool.events, ['connect', 'begin', 'commit', 'release']);
  const lock = pool.statements.findIndex((s) => /pg_advisory_xact_lock/.test(s));
  const recheck = pool.statements.map((s, i) => [s, i]).filter(([s, i]) => i > lock && /information_schema\.columns/.test(s));
  assert.ok(lock > 0 && recheck.length >= 2, 'the columns are re-checked after the lock is taken');
});

test('migration: fails fast instead of stalling the live app, and a dead connection cannot hide the real error', async () => {
  const pool = makeMigrationPool();
  const quiet = console.log; console.log = () => {};
  try { await migration.migrateDatabase('acme', pool); } finally { console.log = quiet; }
  const timeout = pool.statements.findIndex((q) => /^SET LOCAL lock_timeout = '30s'$/.test(q));
  const lock = pool.statements.findIndex((q) => /pg_advisory_xact_lock/.test(q));
  const firstAlter = pool.statements.findIndex((q) => /^ALTER/.test(q));
  assert.ok(timeout >= 0 && timeout < lock && lock < firstAlter, 'lock_timeout is set before the advisory lock and before any ALTER');

  // the connection dies mid-migration AND rollback throws: the ORIGINAL error is what gets reported
  const broken = makeMigrationPool({ failOn: /^ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at/ });
  const original = broken.getConnection;
  broken.getConnection = async () => { const c = await original(); c.rollback = async () => { throw new Error('connection terminated'); }; return c; };
  await assert.rejects(() => migration.migrateDatabase('acme', broken), /boom/);
});

test('migration: the lock key is fixed and passed as a bound parameter', async () => {
  const pool = makeMigrationPool();
  let seen;
  const original = pool.getConnection;
  pool.getConnection = async () => { const c = await original(); const q = c.query; c.query = async (sql, params) => { if (/pg_advisory_xact_lock/.test(sql)) seen = params; return q(sql, params); }; return c; };
  const quiet = console.log; console.log = () => {};
  try { await migration.migrateDatabase('acme', pool); } finally { console.log = quiet; }
  assert.deepEqual(seen, [migration.MIGRATION_LOCK_KEY]);
  assert.ok(Number.isInteger(migration.MIGRATION_LOCK_KEY));
});

test('migration targets: failures are counted per database, the run continues, and the exit status reflects them', async () => {
  const lines = []; const log = console.log; const err = console.error; console.log = () => {}; console.error = (m) => lines.push(m);
  try {
    const ok = makeMigrationPool({ hasFlag: true, hasChangedAt: true });
    const broken = { query: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' }); } };
    const calls = [];
    const targets = [
      { label: 'tenant-a', getPool: () => { calls.push('a'); return broken; } },
      { label: 'tenant-b', getPool: () => { calls.push('b'); return ok; } },
    ];
    const result = await migration.runTargets(targets);
    assert.deepEqual(result, { failures: 1, skipped: 0 });
    assert.deepEqual(calls, ['a', 'b'], 'a failing database does not stop the others');
    assert.ok(lines.some((l) => /\[FAILED\] tenant-a: connect ECONNREFUSED/.test(l)), 'named clearly');
    assert.ok(!lines.some((l) => /password|token|secret/i.test(l)));
    // an invalid tenant name is refused by getTenantPool itself and reported the same way
    const refused = await migration.runTargets([{ label: 'bad', getPool: () => { throw new Error('Refusing to connect: "x" is not a valid tenant database name.'); } }]);
    assert.equal(refused.failures, 1);
  } finally { console.log = log; console.error = err; }
});

test('legacy database: a database that does not exist is skipped; any other legacy failure stops the deploy; a missing TENANT database is always a failure', async () => {
  const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
  try {
    const missing = { query: async () => { throw Object.assign(new Error('database "reinsteins_workhub" does not exist'), { code: '3D000' }); } };
    const down = { query: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } };
    const denied = { query: async () => { throw Object.assign(new Error('password authentication failed'), { code: '28P01' }); } };
    assert.deepEqual(await migration.runTargets([{ label: 'legacy database', getPool: () => missing, skipIfMissing: true }]), { failures: 0, skipped: 1 });
    assert.deepEqual(await migration.runTargets([{ label: 'legacy database', getPool: () => down, skipIfMissing: true }]), { failures: 1, skipped: 0 }, 'unreachable is NOT "missing"');
    assert.deepEqual(await migration.runTargets([{ label: 'legacy database', getPool: () => denied, skipIfMissing: true }]), { failures: 1, skipped: 0 }, 'bad credentials is NOT "missing"');
    assert.deepEqual(await migration.runTargets([{ label: 'acme (tenant_acme)', getPool: () => missing }]), { failures: 1, skipped: 0 }, 'a registered tenant database must exist');
    assert.equal(migration.isMissingDatabaseError({ code: '3D000' }), true);
    assert.equal(migration.isMissingDatabaseError({ code: '42P01' }), false);
    assert.equal(migration.isMissingDatabaseError(null), false);
  } finally { console.log = log; console.error = err; }
  const src = read('server/_migrate_add_must_change_password.js');
  assert.equal((src.match(/skipIfMissing: true/g) || []).length, 1, 'only the legacy target may be skipped');
  assert.match(src, /label: "legacy database", getPool: \(\) => legacyPool, skipIfMissing: true/);
  assert.match(src, /SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> ''/, 'same tenant discovery query as the other migrations');
  assert.match(src, /getTenantPool\(company\.tenant_db_name\)/, 'tenant pools come from getTenantPool, which validates the name');
  assert.match(src, /process\.exit\(failures === 0 \? 0 : 1\)/);
  assert.match(src, /main\(\)\.catch\(\(error\) => \{[\s\S]*process\.exit\(1\)/, 'an unexpected error also exits non-zero');
});

test('deploy safety: set -e is on, so a failed migration can never be followed by the build or the restart', () => {
  const wf = read('.github/workflows/deploy.yml');
  const script = wf.slice(wf.indexOf('run: |'));
  assert.match(script.split('\n').slice(0, 4).join('\n'), /set -e/, 'set -e is the first command of the deploy script');
  const migrate = script.indexOf('node server/_migrate_add_must_change_password.js');
  assert.ok(migrate > 0);
  const between = script.slice(migrate, script.indexOf('sudo systemctl restart'));
  assert.ok(!/\|\|\s*true|set \+e|continue-on-error/.test(script), 'nothing in the deploy swallows a failure');
  assert.ok(!/--dry-run/.test(script.replace(/#.*$/gm, '')), 'the deploy never runs the dry-run form');
  assert.match(between, /npm run build/);
  assert.ok(!/DB_NAME|PLATFORM_DB_NAME|_DB_HOST|scratch|preview_/i.test(script.replace(/#.*$/gm, '')), 'no database is named or overridden: the script uses server/.env like every other migration');
});

test('dry run is a faithful, strictly read-only pre-flight: only SELECTs, no connection, and it checks the user can ALTER users', async () => {
  const pool = makeMigrationPool({ affected: 5 });
  const quiet = console.log; console.log = () => {};
  try { await migration.migrateDatabase('acme', pool, { dryRun: true }); } finally { console.log = quiet; }
  assert.ok(pool.statements.length > 0);
  assert.ok(pool.statements.every((q) => /^SELECT /.test(q)), 'every statement of a dry run is a SELECT: ' + pool.statements.join(' | '));
  assert.ok(pool.statements.some((q) => /pg_has_role\(current_user/.test(q)), 'ownership is checked');
  assert.deepEqual(pool.events, [], 'no transaction connection is ever opened');
});

test('dry run reports a permission problem BEFORE the deploy (not the owner of users, or no users table)', async () => {
  for (const canAlter of [false, null]) {
    const pool = makeMigrationPool({ canAlter });
    const log = console.log; const err = console.error; console.log = () => {}; console.error = () => {};
    let result;
    try { result = await migration.runTargets([{ label: 'acme (tenant_acme)', getPool: () => pool }], { dryRun: true }); } finally { console.log = log; console.error = err; }
    assert.equal(result.failures, 1, `canAlter=${canAlter}: counted as a failure, so the dry run exits non-zero`);
    assert.equal(pool.statements.filter((q) => /^(ALTER|UPDATE)/.test(q)).length, 0);
  }
  // a database that is already migrated needs no ALTER, so the ownership question does not arise
  const done = makeMigrationPool({ hasFlag: true, hasChangedAt: true, canAlter: false });
  const log = console.log; console.log = () => {};
  let r; try { r = await migration.runTargets([{ label: 'acme', getPool: () => done }], { dryRun: true }); } finally { console.log = log; }
  assert.equal(r.failures, 0);
});

test('targets: the legacy database comes first only when DB_NAME is set; tenants follow in registry order; each tenant pool comes from getTenantPool', () => {
  const legacyPool = { name: 'legacy' };
  const seen = [];
  const getTenantPool = (name) => { seen.push(name); return { name }; };
  const companies = [{ company_slug: 'reinsteins', tenant_db_name: 'tenant_reinsteins' }, { company_slug: 'client', tenant_db_name: 'tenant_client' }];

  const withLegacy = migration.buildTargets({ legacyPool, legacyDbName: 'reinsteins_workhub', companies, getTenantPool });
  assert.deepEqual(withLegacy.targets.map((t) => t.label), ['legacy database', 'reinsteins (tenant_reinsteins)', 'client (tenant_client)']);
  assert.deepEqual(withLegacy.targets.map((t) => Boolean(t.skipIfMissing)), [true, false, false]);
  assert.deepEqual(withLegacy.targets.map((t) => t.legacy === true), [true, false, false], 'only the legacy target is marked legacy');
  assert.equal(withLegacy.targets[0].getPool(), legacyPool);
  assert.deepEqual(withLegacy.notices, []);
  withLegacy.targets[1].getPool(); withLegacy.targets[2].getPool();
  assert.deepEqual(seen, ['tenant_reinsteins', 'tenant_client']);

  for (const unset of [undefined, '', '   ', null]) {
    const without = migration.buildTargets({ legacyPool, legacyDbName: unset, companies, getTenantPool });
    assert.deepEqual(without.targets.map((t) => t.label), ['reinsteins (tenant_reinsteins)', 'client (tenant_client)'], `DB_NAME=${JSON.stringify(unset)}: no legacy target`);
    assert.equal(without.notices.length, 1);
    assert.match(without.notices[0], /DB_NAME is not set in server\/\.env/);
  }
  assert.deepEqual(migration.buildTargets({ legacyPool, legacyDbName: 'x', companies: [], getTenantPool }).targets.map((t) => t.label), ['legacy database']);
});

test('migration: never touches passwords or hashes, never drops or deletes; excludes admins and pending self-registrations', () => {
  const src = read('server/_migrate_add_must_change_password.js');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/SELECT[^;`]*\bpassword\b(?!_changed_at)/i.test(code.replace(/password_changed_at/g, '')), 'never selects a password');
  assert.ok(!/SET\s+password\s*=/i.test(code), 'never writes a password');
  assert.ok(!/\b(DROP|TRUNCATE|DELETE\s+FROM)\b/i.test(code), 'nothing destructive');
  const logLines = code.split(/\r?\n/).filter((l) => /console\.(log|error)/.test(l));
  assert.ok(logLines.length > 0);
  assert.ok(!logLines.some((l) => /\$\{\s*[\w.]*(password|hash|row|user)\w*\s*[}.]/i.test(l)), 'logs counts and labels only -- no interpolated password, hash or row');
  const { BACKFILL_WHERE } = migration;
  assert.match(BACKFILL_WHERE, /role = 'employee'/);
  assert.match(BACKFILL_WHERE, /NOT IN \('admin', 'super_admin'\)/);
  assert.match(BACKFILL_WHERE, /status <> 'pending'/);
});

// ================================================================ wiring (static)
test('new employees: the INSERT sets must_change_password = TRUE; the tenant schema has both columns', () => {
  const emp = read('server/controllers/employeeController.js');
  const insert = emp.slice(emp.indexOf('INSERT INTO users'), emp.indexOf('RETURNING id', emp.indexOf('INSERT INTO users')));
  assert.match(insert, /system_access,\s*must_change_password\s*\)/);
  assert.match(insert, /\?,\s*TRUE\s*\)/);
  const schema = read('server/schemas/tenantSchema.postgresql.sql');
  assert.match(schema, /"must_change_password" boolean NOT NULL DEFAULT FALSE,/);
  assert.match(schema, /"password_changed_at" timestamptz DEFAULT NULL,/);
  // self-registration and first-admin provisioning are deliberately unchanged
  assert.ok(!/must_change_password/.test(read('server/services/tenantUserService.js')));
});

test('routes: the force-change endpoints are NOT behind protect/tenantProtect and ARE rate limited', () => {
  const t = read('server/routes/tenantAuthRoutes.js');
  assert.match(t, /router\.post\("\/:companySlug\/force-change-password", tenantLoginLimiter, forceChangePassword\);/);
  const a = read('server/routes/authRoutes.js');
  assert.match(a, /router\.post\(\s*"\/force-change-password",\s*authLoginLimiter,\s*forceChangePassword\s*\);/);
  assert.ok(!/force-change-password[^)]*protect/.test(t + a));
});

test('enforcement is wired into every authentication path (REST, legacy REST, both socket handshakes)', () => {
  assert.match(read('server/middleware/tenantAuthMiddleware.js'), /checkPasswordSessionState\(user, decoded\.iat\)/);
  assert.match(read('server/middleware/authMiddleware.js'), /checkPasswordSessionState\(rows\[0\], legacyDecoded\.iat\)/);
  const app = read('server/app.js');
  assert.equal((app.match(/checkPasswordSessionState\(user, decoded\.iat\)\.allowed/g) || []).length, 2, 'legacy and tenant socket authentication');
});

test('deploy: the migration runs before the restart, after the existing ones', () => {
  const wf = read('.github/workflows/deploy.yml');
  const at = wf.indexOf('node server/_migrate_add_must_change_password.js');
  assert.ok(at > wf.indexOf('node server/_migrate_add_workitem_assignment.js'));
  assert.ok(at < wf.indexOf('sudo systemctl restart reinsteins-crm'));
  assert.ok(at < wf.indexOf('npm run build'));
});

test('client: login keeps the challenge under its own key, never as a session; the page is outside ProtectedRoute', () => {
  const login = read('client/src/pages/Auth/Login.jsx');
  const branch = login.slice(login.indexOf('if (response.data.passwordChangeRequired)'), login.indexOf('const {\n        token,\n        user,\n      } = response.data;'));
  assert.match(branch, /sessionStorage\.removeItem\("token"\)/);
  assert.match(branch, /storePendingPasswordChange\(/);
  assert.match(branch, /\/change-password`? : "\/legacy-change-password"/);
  assert.ok(!/setItem\(\s*"token"/.test(branch), 'no token is stored for a pending change');
  const flow = read('client/src/utils/passwordChangeFlow.js');
  assert.match(flow, /PENDING_PASSWORD_CHANGE_KEY = "passwordChangePending"/);
  const app = read('client/src/App.jsx');
  assert.match(app, /path="\/legacy-change-password"\s+element=\{<ChangePassword \/>\}/);
  assert.match(app, /path="\/:companySlug\/change-password"\s+element=\{<ChangePassword \/>\}/);
  assert.ok(!/<ProtectedRoute[^>]*>\s*<ChangePassword/.test(app));
});

test('client page: three fields with show/hide, live rules, confirmation check, safe handling of expired challenges', () => {
  const page = read('client/src/pages/Auth/ChangePassword.jsx');
  for (const label of ['Temporary Password', 'New Password', 'Confirm New Password']) assert.ok(page.includes(`label="${label}"`), label);
  assert.equal((page.match(/aria-label=\{visible \?/g) || []).length, 1, 'one reusable show/hide toggle');
  assert.match(page, /The password your company gave you is temporary/);
  assert.match(page, /The new password and confirmation do not match/);
  assert.match(page, /code === "CHALLENGE_EXPIRED" \|\| code === "CHALLENGE_INVALID"/);
  assert.match(page, /clearPendingPasswordChange\(\);\s*toast\.error/);
  assert.match(page, /if \(!pending \|\| \(pending\.companySlug \|\| null\) !== \(companySlug \|\| null\)\)/);
  assert.match(page, /headers: \{ Authorization: `Bearer \$\{pending\.challengeToken\}` \}/);
  // sends only the three passwords: no field that could name another user
  assert.match(page, /\{ temporaryPassword, newPassword, confirmPassword \}/);
  assert.ok(!/userId|employeeId:/.test(page.slice(page.indexOf('api.post('), page.indexOf('const { token, user, company }'))));
});

test('client helpers: pending change storage and the rule checklist', async () => {
  const flow = await import(pathToFileURL(path.join(ROOT, 'client/src/utils/passwordChangeFlow.js')).href);
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  try {
    assert.equal(flow.readPendingPasswordChange(), null);
    flow.storePendingPasswordChange({ challengeToken: 'abc', companySlug: 'acme', employeeId: 'E1', fullName: 'A' });
    assert.equal(flow.readPendingPasswordChange().challengeToken, 'abc');
    assert.equal(store.has('token'), false, 'never stored as a session token');
    store.set(flow.PENDING_PASSWORD_CHANGE_KEY, '{not json');
    assert.equal(flow.readPendingPasswordChange(), null, 'a damaged value is discarded');
    assert.equal(store.has(flow.PENDING_PASSWORD_CHANGE_KEY), false);
    flow.storePendingPasswordChange({ challengeToken: 'abc' });
    flow.clearPendingPasswordChange();
    assert.equal(flow.readPendingPasswordChange(), null);
  } finally { delete globalThis.sessionStorage; }

  const rules = flow.evaluatePasswordRules('Abcdefghij1', { minLength: 10, requireUppercase: true, requireLowercase: true, requireDigit: true });
  assert.ok(rules.every((r) => r.met));
  assert.deepEqual(flow.evaluatePasswordRules('abc', { minLength: 8, requireUppercase: false, requireLowercase: true, requireDigit: false }).map((r) => [r.key, r.met]), [['length', false], ['lower', true]]);
  assert.equal(flow.evaluatePasswordRules('', undefined).length, 4, 'falls back to the default policy');
});

test('the ONLY code that clears the flag is the forced-change service; Settings change-password is untouched; every creation path is accounted for', () => {
  const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f, out); } else if (f.endsWith('.js') && !/_test_|_migrate_|backup/.test(f)) out.push(f); } return out; };
  const clearing = walk(path.join(ROOT, 'server')).filter((f) => /must_change_password\s*=\s*FALSE/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
  assert.deepEqual(clearing, ['server/services/forcedPasswordChangeService.js']);
  const auth = read('server/controllers/authController.js');
  const settings = auth.slice(auth.indexOf('const changePassword ='), auth.indexOf('FORCED PASSWORD CHANGE (legacy login)'));
  assert.match(settings, /UPDATE users\s+SET password = \?\s+WHERE id = \?/, 'unchanged: only the password');
  assert.ok(!/must_change_password|password_changed_at/.test(settings));

  // every INSERT INTO users in the codebase, and what it does about the flag
  const inserts = walk(path.join(ROOT, 'server')).filter((f) => /INSERT\s+INTO\s+users/i.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
  assert.deepEqual(inserts, ['server/controllers/authController.js', 'server/controllers/employeeController.js', 'server/createAdmin.js', 'server/createEmployee.js', 'server/services/tenantUserService.js'],
    'a NEW user-creating path must be reviewed against the temporary-password policy');
  assert.match(read('server/createEmployee.js'), /\(employee_id, full_name, email, password, role, status, must_change_password\)\s+VALUES \(\?, \?, \?, \?, \?, \?, TRUE\)/, 'the CLI helper uses a fixed temporary password -> pending');
  assert.ok(!/must_change_password/.test(read('server/createAdmin.js')), 'admin CLI helper: deliberately unchanged');
  assert.ok(!/must_change_password/.test(read('server/services/tenantUserService.js')), 'first tenant admin: deliberately unchanged');
  const register = auth.slice(auth.indexOf('const registerEmployee'), auth.indexOf('const changePassword ='));
  assert.ok(!/must_change_password/.test(register), 'self-registration (pending, own password): deliberately unchanged');
  assert.match(register, /'pending'/);
});

test('rollout guide exists and its facts match the code (challenge lifetime, default rules, who is flagged, pre-flight, rollback)', () => {
  const doc = read('server/PASSWORD_CHANGE_ROLLOUT.md');
  assert.equal(challenge.CHALLENGE_TTL_SECONDS, 600);
  assert.match(doc, /more than \*\*10 minutes\*\*/, 'matches CHALLENGE_TTL_SECONDS');
  const { describePasswordPolicy } = require('./utils/passwordPolicy');
  const policy = describePasswordPolicy();
  assert.ok(doc.includes(`${policy.minLength}+ characters with an uppercase letter, a lowercase letter and a number`), 'matches the default policy');
  assert.match(doc, /PASSWORD_MIN_LENGTH/);
  // who is flagged -- the same exclusions the migration and the creation code implement
  assert.match(doc, /Admin and Super Admin accounts that already exist \| \*\*Not\*\* flagged/);
  assert.match(doc, /Admin and Super Admin accounts that already exist \| \*\*Not\*\* flagged by the deploy migration; flagged by the second step/);
  assert.match(doc, /System Administrator\*\* \(`users\.is_system_administrator = TRUE`, one per database\) \| \*\*Never\*\* flagged/);
  assert.match(doc, /`existing-employees-v2` \/ `existing-admins-v2`/);
  assert.match(doc, /`--legacy-without-system-administrator` records the decision that the legacy database has \*\*no exempt\s+account\*\*/);
  assert.match(doc, /only while that column is \*\*absent\*\*/);
  assert.match(doc, /Pending self-registrations/);
  assert.match(doc, /First admin created by the platform owner/);
  // sessions
  assert.match(doc, /Sessions are ended at rollout/);
  assert.match(doc, /stops working at their next request/);
  assert.match(doc, /real-time connections are refused too/);
  assert.match(doc, /Invalid login response/);
  // sequence + pre-flight + rollback
  assert.match(doc, /node server\/_migrate_add_must_change_password\.js --dry-run/);
  assert.match(doc, /only runs `SELECT`s/);
  assert.match(doc, /does not own the `users` table/);
  assert.match(doc, /UPDATE users SET must_change_password = FALSE;/);
  assert.match(doc, /no administrator password-reset screen/);
  assert.match(doc, /ownership check runs only for a database that\s+still lacks at least one of the two columns/);
  // production naming and scope: one database for DB_NAME and PLATFORM_DB_NAME, only `users` is altered
  assert.match(doc, /In production the legacy database is `reinsteins_crm`; `reinsteins_workhub` is its name from before the move to\s+PostgreSQL/);
  assert.match(doc, /`DB_NAME` and `PLATFORM_DB_NAME` name the same database, `reinsteins_crm`/);
  assert.match(doc, /never touches the platform tables there \(`companies`, `platform_users`/);
  assert.doesNotMatch(doc, /groworgs_platform_db/, 'no database name that does not exist in production');
  // the backfill WHERE flags inactive employees and, through `status <> 'pending'`, never a NULL status
  assert.match(migration.BACKFILL_WHERE, /status <> 'pending'/);
  assert.match(doc, /Existing \*\*inactive\*\* employees .* \| Flagged too/);
  assert.match(doc, /Rows whose `status` is NULL \| \*\*Not\*\* flagged/);
});
