// Regression tests for "the UI is old after login until I refresh": a tab running an older bundle than the
// deployed one must notice and reload ONCE, without loops, without extra reloads, and without touching the
// session. See client/src/utils/buildVersion.js for the root cause (index.html served with Last-Modified only).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const load = () => import(pathToFileURL(path.join(ROOT, 'client/src/utils/buildVersion.js')).href);

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return { getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; }, data };
}
const jsonResponse = (body, ok = true) => ({ ok, json: async () => body });

test('fetchDeployedBuildId: reads the id with a cache-proof request, and returns null for anything unexpected', async () => {
  const { fetchDeployedBuildId } = await load();
  const seen = [];
  const id = await fetchDeployedBuildId(async (url, options) => { seen.push({ url, options }); return jsonResponse({ buildId: 'abc123' }); });
  assert.equal(id, 'abc123');
  assert.match(seen[0].url, /^\/version\.json\?t=\d+$/, 'unique query so no CDN/browser cache can answer it');
  assert.equal(seen[0].options.cache, 'no-store');
  assert.ok(seen[0].options.signal, 'has a timeout so a hung request cannot hold up startup/login');

  assert.equal(await fetchDeployedBuildId(async () => jsonResponse({}, false)), null, '404 / 500');
  assert.equal(await fetchDeployedBuildId(async () => ({ ok: true, json: async () => { throw new SyntaxError('<!doctype html>'); } })), null, 'SPA fallback returns HTML with 200');
  assert.equal(await fetchDeployedBuildId(async () => { throw new TypeError('offline'); }), null, 'network error');
  assert.equal(await fetchDeployedBuildId(async () => jsonResponse({ buildId: 42 })), null, 'wrong type');
  assert.equal(await fetchDeployedBuildId(async () => jsonResponse({ buildId: '' })), null, 'empty id');
  assert.equal(await fetchDeployedBuildId(async () => jsonResponse(null)), null);
});

test('reloadForNewBuild: reloads exactly once for a newer deploy, never for the same build, a dev server or an unknown id', async () => {
  const { reloadForNewBuild, _resetBuildVersionState } = await load();
  const run = (deployedId, { currentId = 'old1', storage = memoryStorage() } = {}) => {
    let reloads = 0;
    const did = reloadForNewBuild(deployedId, { currentId, storage, reload: () => { reloads += 1; } });
    return { did, reloads, storage };
  };

  _resetBuildVersionState();
  assert.equal(run('new2', { currentId: 'dev' }).reloads, 0, 'Vite dev server never reloads');
  assert.equal(run(null).reloads, 0, 'unknown deployed id: leave the app alone');
  assert.equal(run('old1').reloads, 0, 'already on the deployed build');

  const stale = run('new2');
  assert.deepEqual([stale.did, stale.reloads], [true, 1], 'stale tab reloads');
  assert.equal(stale.storage.data.wh_build_reload_attempt, 'new2');

  // same page load: a second trigger (startup check + login check) must not reload twice
  assert.equal(run('new2').reloads, 0, 'at most one reload per page load');

  // LOOP PROTECTION: the page came back (new page load) still stale, e.g. an intermediate cache -> do not reload again
  _resetBuildVersionState();
  assert.equal(run('new2', { storage: stale.storage }).reloads, 0, 'same deployed id was already tried once');

  // a later, different deploy is allowed one reload of its own
  _resetBuildVersionState();
  assert.equal(run('new3', { storage: stale.storage }).reloads, 1);

  // once the tab is current, the guard is cleared so the NEXT deploy works again
  _resetBuildVersionState();
  const cleared = run('new3', { currentId: 'new3', storage: memoryStorage({ wh_build_reload_attempt: 'new3' }) });
  assert.equal(cleared.reloads, 0);
  assert.equal(cleared.storage.data.wh_build_reload_attempt, undefined);

  // unusable storage (private mode, quota): still reloads once per page load, never throws, never loops within the page
  _resetBuildVersionState();
  let reloads = 0;
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.doesNotThrow(() => reloadForNewBuild('new9', { currentId: 'old1', storage: broken, reload: () => { reloads += 1; } }));
  reloadForNewBuild('new9', { currentId: 'old1', storage: broken, reload: () => { reloads += 1; } });
  assert.equal(reloads, 1);
  _resetBuildVersionState();
});

test('reloadIfStaleBuild: startup path = one tiny request, then at most one reload; dev/offline do nothing', async () => {
  const { reloadIfStaleBuild, _resetBuildVersionState } = await load();
  let reloads = 0;
  const reload = () => { reloads += 1; };
  let requests = 0;
  const fetchImpl = async () => { requests += 1; return jsonResponse({ buildId: 'new2' }); };

  _resetBuildVersionState();
  assert.equal(await reloadIfStaleBuild({ currentId: 'dev', fetchImpl, storage: memoryStorage(), reload }), false);
  assert.equal(requests, 0, 'a dev server does not even make the request');

  assert.equal(await reloadIfStaleBuild({ currentId: 'old1', fetchImpl: async () => { throw new Error('offline'); }, storage: memoryStorage(), reload }), false);
  assert.equal(reloads, 0);

  assert.equal(await reloadIfStaleBuild({ currentId: 'old1', fetchImpl, storage: memoryStorage(), reload }), true);
  assert.equal(requests, 1);
  assert.equal(reloads, 1);
  _resetBuildVersionState();
});

test('wiring: checked at startup and at login only -- never a reload per navigation, never a timer; login session untouched', () => {
  const main = read('client/src/main.jsx');
  assert.match(main, /import \{ reloadIfStaleBuild \} from "\.\/utils\/buildVersion";/);
  assert.match(main, /\nreloadIfStaleBuild\(\);\s*$/, 'checked once at startup, after render is requested');

  const login = read('client/src/pages/Auth/Login.jsx');
  assert.match(login, /fetchDeployedBuildId,\s*reloadForNewBuild,/);
  assert.equal((login.match(/await fetchDeployedBuildId\(\)/g) || []).length, 1, 'one check per login');
  const afterSession = login.slice(login.indexOf('SAVE LOGIN SESSION'));
  assert.ok(afterSession.indexOf('sessionStorage.setItem') < afterSession.indexOf('await fetchDeployedBuildId()'), 'the session is saved BEFORE any reload can happen');
  // both redirects (admin, employee) navigate first, then reload if stale -> lands on the right dashboard
  assert.equal((login.match(/navigate\(\s*(adminPath|employeePath),\s*\{\s*replace: true,\s*\}\s*\);\s*reloadForNewBuild\(deployedBuildId\);\s*return;/g) || []).length, 2);

  // the ONLY place that reloads the page is the version helper
  const walk = (dir, out = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, out); else if (/\.(jsx?|mjs)$/.test(f)) out.push(f); } return out; };
  const offenders = walk(path.join(ROOT, 'client/src')).filter((f) => /location\.reload\(|location\.href\s*=|location\.assign\(|location\.replace\(/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith('buildVersion.js')).map((f) => path.relative(ROOT, f));
  assert.ok(!offenders.some((f) => /Login\.jsx|App\.jsx|main\.jsx|Layout/.test(f)), `no forced reloads in login/router/layout code: ${offenders}`);
  const helper = read('client/src/utils/buildVersion.js');
  assert.ok(!/setTimeout|setInterval/.test(helper), 'no arbitrary timers');
  assert.equal((helper.match(/location\.reload\(\)/g) || []).length, 1, 'a single place actually reloads the page');
});

test('server sample documents the real fix: index.html revalidated, hashed assets immutable, missing assets 404', () => {
  const conf = read('server/deploy/frontend-cache-headers.nginx.example');
  assert.match(conf, /THIS IS A SAMPLE, NOT A WORKING CONFIG/);
  assert.match(conf, /Nothing in this repository applies it/);
  assert.match(conf, /administrator with access\s+# to the production host must adapt it/);
  assert.match(conf, /location = \/index\.html \{\s*add_header Cache-Control "no-cache" always;/);
  assert.match(conf, /location = \/version\.json \{\s*add_header Cache-Control "no-store" always;/);
  assert.match(conf, /location \/assets\/ \{\s*add_header Cache-Control "public, max-age=31536000, immutable" always;\s*try_files \$uri =404;/);
  assert.match(conf, /try_files \$uri \/index\.html;\s*add_header Cache-Control "no-cache" always;/);
});

// ---- the real build: version.json and the id compiled into the bundle must agree
function findVite() {
  for (let dir = ROOT; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'client', 'node_modules', 'vite', 'dist', 'node', 'index.js');
    if (fs.existsSync(candidate)) return { vite: candidate, plugin: path.join(dir, 'client', 'node_modules', '@vitejs', 'plugin-react', 'dist', 'index.js') };
    if (path.dirname(dir) === dir) return null;
  }
}
const toolchain = findVite();

test('production build publishes /version.json whose id is the one compiled into the bundle (and dev uses "dev")', { skip: toolchain ? false : 'client dev dependencies (vite) not installed' }, async () => {
  const vite = await import(pathToFileURL(toolchain.vite).href);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-build-'));
  try {
    await vite.build({ root: path.join(ROOT, 'client'), configFile: path.join(ROOT, 'client', 'vite.config.js'), logLevel: 'silent', build: { outDir, emptyOutDir: true, minify: false } });
    const published = JSON.parse(fs.readFileSync(path.join(outDir, 'version.json'), 'utf8'));
    assert.match(published.buildId, /^[0-9a-z]{6,}$/);
    const assets = fs.readdirSync(path.join(outDir, 'assets')).filter((f) => f.endsWith('.js'));
    const bundle = assets.map((f) => fs.readFileSync(path.join(outDir, 'assets', f), 'utf8')).join('\n');
    assert.ok(bundle.includes(JSON.stringify(published.buildId)), 'the same id is compiled into the JS bundle');
    assert.ok(!/__BUILD_ID__/.test(bundle), 'the placeholder was replaced');

    // the dev server must not get the file or a real id (so it never reloads itself)
    const config = await vite.resolveConfig({ root: path.join(ROOT, 'client'), configFile: path.join(ROOT, 'client', 'vite.config.js'), logLevel: 'silent' }, 'serve');
    assert.equal(config.define.__BUILD_ID__, '"dev"');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
