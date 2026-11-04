// RENDERED tests of the real tenant-feature UI: the Owner Portal feature checklist, the route gate, the features provider and
// the two sidebars. Real components, real CSS imports, real React, real react-router and jsdom DOM events; only the network
// layer (services/api, services/socket) is replaced by small stubs (_test_tenant_features_harness/).
//
// The client sources are loaded in place through the client's own Vite (ssrLoadModule); nothing is written inside the
// project and no dependency is installed. If the client dev dependencies or jsdom are missing the tests are SKIPPED with
// a message. Run: node --test _test_tenant_features_rendered.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const ROOT = path.join(__dirname, "..");
const CLIENT = path.join(ROOT, "client");
const HARNESS = path.join(__dirname, "_test_tenant_features_harness");

const clientRequire = fs.existsSync(path.join(CLIENT, "package.json")) ? createRequire(path.join(CLIENT, "package.json")) : null;
const tryResolve = (name, paths) => { try { return require.resolve(name, { paths }); } catch { return null; } };
const jsdomPath = tryResolve("jsdom", [path.join(ROOT, "node_modules"), path.join(CLIENT, "node_modules"), __dirname]);
const viteOk = clientRequire && tryResolve("vite", [CLIENT]) && tryResolve("react-dom", [CLIENT]) && tryResolve("react-router-dom", [CLIENT]);
const SKIP = !viteOk || !jsdomPath ? "client dev dependencies (vite, react, react-dom, react-router-dom) or jsdom are not installed" : false;

let vite = null;
let React = null;
let act = null;
let createRoot = null;
let Router = null;
let modules = {};

const FEATURES_CATALOG = [
  { id: "dashboard", name: "Dashboard", description: "Home page.", requires: [] },
  { id: "employee_management", name: "Employee Management", description: "Employees.", requires: [] },
  { id: "attendance", name: "Attendance Management", description: "Attendance.", requires: [] },
  { id: "shift_management", name: "Shift Management", description: "Shifts.", requires: ["employee_management"] },
  { id: "chat", name: "Chat", description: "Chat.", requires: [] },
  { id: "meetings", name: "Meetings", description: "Meetings.", requires: ["employee_management"] },
  { id: "smart_sheets", name: "Smart Sheets", description: "Sheets.", requires: [] },
];

test.before(async () => {
  if (SKIP) return;
  const { JSDOM } = require(jsdomPath);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  for (const key of ["HTMLElement", "Node", "Event", "MouseEvent", "KeyboardEvent", "sessionStorage", "localStorage", "getComputedStyle"]) {
    if (!(key in globalThis) || key === "sessionStorage" || key === "localStorage") Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });

  React = clientRequire("react");
  act = React.act;
  createRoot = clientRequire("react-dom/client").createRoot;
  Router = clientRequire("react-router-dom");

  const { createServer } = clientRequire("vite");
  vite = await createServer({
    root: CLIENT,
    server: { middlewareMode: true },
    appType: "custom",
    logLevel: "error",
    optimizeDeps: { noDiscovery: true, include: [] },
    resolve: {
      alias: [
        { find: /^(\.\.?\/)+services\/api$/, replacement: path.join(HARNESS, "api.js") },
        { find: /^(\.\.?\/)+services\/socket$/, replacement: path.join(HARNESS, "socket.js") },
        { find: /^(\.\.?\/)+services\/platformApi$/, replacement: path.join(HARNESS, "platformApi.js") },
      ],
    },
  });
  const load = (file) => vite.ssrLoadModule(file);
  modules = {
    FeatureSelector: (await load("/src/pages/Platform/FeatureSelector.jsx")).default,
    AddCompanyModal: (await load("/src/pages/Platform/AddCompanyModal.jsx")).default,
    CompanyFeaturesCard: (await load("/src/pages/Platform/CompanyFeaturesCard.jsx")).default,
    FeatureGateModule: await load("/src/components/Features/FeatureGate.jsx"),
    Provider: (await load("/src/context/TenantFeatures.jsx")).TenantFeaturesProvider,
    context: await load("/src/context/tenantFeaturesContext.js"),
    AdminSidebar: (await load("/src/components/Layout/AdminSidebar.jsx")).default,
    EmployeeSidebar: (await load("/src/components/Layout/EmployeeSidebar.jsx")).default,
  };
});

test.after(async () => {
  if (vite) await vite.close();
});

// ------------------------------------------------------------------------------------------------ helpers

const mounted = [];
async function render(element) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  mounted.push({ root, container });
  return container;
}
test.afterEach(async () => {
  while (mounted.length) {
    const { root, container } = mounted.pop();
    await act(async () => { root.unmount(); });
    container.remove();
  }
  document.defaultView.sessionStorage.clear();
  globalThis.__tenantFeaturesApi = undefined;
  globalThis.__platformApi = undefined;
  globalThis.__platformCalls = [];
});

const click = async (element) => { await act(async () => { element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true })); }); };
const text = (container) => container.textContent.replace(/\s+/g, " ").trim();
const card = (container, id) => container.querySelector(`[data-testid="feature-card-${id}"]`);
const checkbox = (container, id) => card(container, id).querySelector("input[type=checkbox]");
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };

function Controlled({ initial, catalog = FEATURES_CATALOG, onValue }) {
  const [value, setValue] = React.useState(initial);
  onValue(value);
  return React.createElement(modules.FeatureSelector, { catalog, value, onChange: setValue });
}
async function renderSelector(initial) {
  const state = { value: initial };
  const container = await render(React.createElement(Controlled, { initial, onValue: (value) => { state.value = value; } }));
  return { container, state };
}

// ------------------------------------------------------------------------------------------------ Owner Portal checklist

test("OWNER UI: every module is listed with name, description, toggle and Enabled/Disabled state, and the selected count", { skip: SKIP }, async () => {
  const { container } = await renderSelector(["dashboard", "employee_management", "chat"]);
  for (const feature of FEATURES_CATALOG) {
    const el = card(container, feature.id);
    assert.ok(el, feature.id);
    assert.match(el.textContent, new RegExp(feature.name));
    assert.match(el.textContent, new RegExp(feature.description));
  }
  assert.equal(checkbox(container, "chat").checked, true);
  assert.equal(checkbox(container, "smart_sheets").checked, false);
  assert.match(card(container, "chat").textContent, /Enabled/);
  assert.match(card(container, "smart_sheets").textContent, /Disabled/);
  assert.match(card(container, "meetings").textContent, /Requires Employee Management/);
  assert.equal(text(container.querySelector('[data-testid="feature-selected-count"]')), "3 of 7 features selected");
});

test("OWNER UI: Select All, Deselect All and individual toggles update the selection and the count", { skip: SKIP }, async () => {
  const { container, state } = await renderSelector(["dashboard"]);
  const button = (label) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === label);

  await click(button("Select All"));
  assert.equal(state.value.length, FEATURES_CATALOG.length);
  assert.equal(text(container.querySelector('[data-testid="feature-selected-count"]')), "7 of 7 features selected");
  assert.equal(button("Select All").disabled, true);

  await click(button("Deselect All"));
  assert.deepEqual(state.value, []);
  assert.equal(text(container.querySelector('[data-testid="feature-selected-count"]')), "0 of 7 features selected");

  await click(checkbox(container, "attendance"));
  await click(checkbox(container, "chat"));
  assert.deepEqual(state.value, ["attendance", "chat"], "in catalog order");
  await click(checkbox(container, "attendance"));
  assert.deepEqual(state.value, ["chat"]);
});

test("OWNER UI: turning on a module that needs another is refused with an explanation -- never enabled silently", { skip: SKIP }, async () => {
  const { container, state } = await renderSelector(["dashboard"]);
  await click(checkbox(container, "meetings"));
  assert.deepEqual(state.value, ["dashboard"], "nothing changed behind the Owner's back");
  const notice = container.querySelector('[data-testid="feature-notice"]');
  assert.ok(notice);
  assert.match(text(notice), /Meetings requires Employee Management, which is not selected/);

  const confirm = [...notice.querySelectorAll("button")].find((b) => /Turn on Employee Management and Meetings/.test(b.textContent));
  assert.ok(confirm, "one explicit button names exactly what will be turned on");
  await click(confirm);
  assert.deepEqual(state.value, ["dashboard", "employee_management", "meetings"]);
  assert.equal(container.querySelector('[data-testid="feature-notice"]'), null);
});

test("OWNER UI: turning off a module that others depend on lists the dependents and needs an explicit confirmation; Cancel keeps everything", { skip: SKIP }, async () => {
  const { container, state } = await renderSelector(["dashboard", "employee_management", "shift_management", "meetings", "chat"]);
  await click(checkbox(container, "employee_management"));
  assert.equal(state.value.length, 5, "unchanged");
  const notice = container.querySelector('[data-testid="feature-notice"]');
  assert.match(text(notice), /Shift Management and Meetings need Employee Management/);

  await click([...notice.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel"));
  assert.equal(state.value.length, 5);
  assert.equal(container.querySelector('[data-testid="feature-notice"]'), null);

  await click(checkbox(container, "employee_management"));
  await click([...container.querySelectorAll('[data-testid="feature-notice"] button')].find((b) => /Turn off Employee Management, Shift Management and Meetings/.test(b.textContent)));
  assert.deepEqual(state.value, ["dashboard", "chat"]);
});

// ------------------------------------------------------------------------------------------------ route gate

function Probe({ log }) {
  React.useEffect(() => { log.push("mounted"); }, [log]);
  return React.createElement("div", { "data-testid": "protected-module" }, "SECRET MODULE DATA");
}
const withFeatures = (features, element) => React.createElement(modules.context.TenantFeaturesContext.Provider, { value: { features, ready: true, isEnabled: (id) => !id || !Array.isArray(features) || features.includes(id), refresh() {} } }, element);

test("ROUTE GATE: a disabled module shows the notice and its page is never mounted (so it never loads its data)", { skip: SKIP }, async () => {
  const log = [];
  const { default: FeatureGate } = modules.FeatureGateModule;
  const container = await render(withFeatures(["dashboard"], React.createElement(Router.MemoryRouter, null, React.createElement(FeatureGate, { feature: "chat" }, React.createElement(Probe, { log })))));
  assert.match(text(container), /This feature is not enabled for your organization\./);
  assert.ok(container.querySelector('[data-testid="feature-disabled"]'));
  assert.equal(container.querySelector('[data-testid="protected-module"]'), null);
  assert.deepEqual(log, [], "the module component was never mounted");
  assert.doesNotMatch(text(container), /SECRET MODULE DATA/);
});

test("ROUTE GATE: an enabled module, a page that is always available, and a legacy session (no list) render normally", { skip: SKIP }, async () => {
  const { default: FeatureGate } = modules.FeatureGateModule;
  const page = (feature, features) => withFeatures(features, React.createElement(Router.MemoryRouter, null, React.createElement(FeatureGate, { feature }, React.createElement(Probe, { log: [] }))));
  assert.ok((await render(page("chat", ["chat"]))).querySelector('[data-testid="protected-module"]'));
  assert.ok((await render(page(null, ["dashboard"]))).querySelector('[data-testid="protected-module"]'), "settings/profile have no feature");
  assert.ok((await render(page("chat", null))).querySelector('[data-testid="protected-module"]'), "null list = every module (legacy)");
});

test("ROUTE GATE: if the dashboard itself is not enabled, the home page sends the user to the first module they do have", { skip: SKIP }, async () => {
  const { default: FeatureGate } = modules.FeatureGateModule;
  const tree = (features) => withFeatures(features, React.createElement(Router.MemoryRouter, { initialEntries: ["/acme/employee"] },
    React.createElement(Router.Routes, null,
      React.createElement(Router.Route, { path: "/acme/employee", element: React.createElement(FeatureGate, { feature: "dashboard", landing: true, portal: "employee" }, React.createElement("div", { "data-testid": "dashboard" }, "DASHBOARD")) }),
      React.createElement(Router.Route, { path: "/acme/employee/chat", element: React.createElement("div", { "data-testid": "chat-page" }, "CHAT PAGE") }),
      React.createElement(Router.Route, { path: "/acme/employee/tasks", element: React.createElement("div", { "data-testid": "tasks-page" }, "TASKS PAGE") }))));
  const withDashboard = await render(tree(["dashboard", "chat"]));
  assert.ok(withDashboard.querySelector('[data-testid="dashboard"]'));
  const without = await render(tree(["chat"]));
  assert.ok(without.querySelector('[data-testid="chat-page"]'), "redirected to chat");
  const none = await render(tree([]));
  assert.match(text(none), /not enabled for your organization/, "no module at all: a clear message, not a blank page");
});

// ------------------------------------------------------------------------------------------------ provider (live updates)

const Show = () => {
  const { features, isEnabled } = modules.context.useTenantFeatures();
  return React.createElement("div", { "data-testid": "state" }, `${features === null ? "ALL" : features.join(",")}|chat=${isEnabled("chat")}`);
};
const readState = (container) => container.querySelector('[data-testid="state"]')?.textContent;

test("PROVIDER: a company session shows the list from sign-in, and a legacy session (no company) gets every module without any request", { skip: SKIP }, async () => {
  globalThis.__tenantFeaturesApi = async () => ({ data: { company: { features: ["dashboard", "chat"] } } });
  sessionStorage.setItem("company", JSON.stringify({ slug: "acme", features: ["dashboard", "chat"] }));
  const company = await render(React.createElement(modules.Provider, null, React.createElement(Show)));
  await settle();
  assert.equal(readState(company), "dashboard,chat|chat=true");

  sessionStorage.clear();
  let asked = 0;
  globalThis.__tenantFeaturesApi = async () => { asked += 1; return { data: {} }; };
  const legacy = await render(React.createElement(modules.Provider, null, React.createElement(Show)));
  await settle();
  assert.equal(readState(legacy), "ALL|chat=true");
  assert.equal(asked, 0, "a legacy session never asks for a feature list");
});

test("PROVIDER: with no list yet the portal waits for /tenant-auth/me -- the module pages are not mounted in the meantime", { skip: SKIP }, async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.__tenantFeaturesApi = async (url) => { assert.equal(url, "/tenant-auth/me"); await gate; return { data: { company: { features: ["attendance"] } } }; };
  sessionStorage.setItem("company", JSON.stringify({ slug: "acme" })); // no features stored
  const container = await render(React.createElement(modules.Provider, null, React.createElement(Show)));
  assert.equal(readState(container), undefined, "nothing rendered yet");
  await act(async () => { release(); await gate; });
  await settle();
  assert.equal(readState(container), "attendance|chat=false");
});

test("LIVE UPDATE: the server's tenant:features-changed event updates a screen that is already open, without a reload", { skip: SKIP }, async () => {
  globalThis.__tenantFeaturesApi = async () => ({ data: { company: { features: ["dashboard", "chat"] } } });
  sessionStorage.setItem("company", JSON.stringify({ slug: "acme", features: ["dashboard", "chat"] }));
  const container = await render(React.createElement(modules.Provider, null, React.createElement(Show)));
  await settle();
  assert.equal(readState(container), "dashboard,chat|chat=true");

  await act(async () => { globalThis.__tenantFeaturesSocket.fire("tenant:features-changed", { features: ["dashboard"] }); });
  assert.equal(readState(container), "dashboard|chat=false", "the module disappears at once");
  assert.deepEqual(JSON.parse(sessionStorage.getItem("company")).features, ["dashboard"], "and the stored list follows");
});

test("LIVE UPDATE: an API answer FEATURE_NOT_ENABLED makes the portal re-read the company's modules", { skip: SKIP }, async () => {
  let serverFeatures = ["dashboard", "chat"];
  globalThis.__tenantFeaturesApi = async () => ({ data: { company: { features: serverFeatures } } });
  sessionStorage.setItem("company", JSON.stringify({ slug: "acme", features: ["dashboard", "chat"] }));
  const container = await render(React.createElement(modules.Provider, null, React.createElement(Show)));
  await settle();

  serverFeatures = ["dashboard"]; // the Owner switched chat off; this browser has not heard yet
  await act(async () => { window.dispatchEvent(new window.Event("tenant-features-denied")); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(readState(container), "dashboard|chat=false");
});

test("LIVE UPDATE: the provider stops listening when it unmounts (no leaked socket listeners)", { skip: SKIP }, async () => {
  globalThis.__tenantFeaturesApi = async () => ({ data: { company: { features: ["dashboard"] } } });
  sessionStorage.setItem("company", JSON.stringify({ slug: "acme", features: ["dashboard"] }));
  const root = document.createElement("div");
  const r = createRoot(root);
  await act(async () => { r.render(React.createElement(modules.Provider, null, React.createElement(Show))); });
  await settle();
  assert.equal(globalThis.__tenantFeaturesSocket.count("tenant:features-changed"), 1);
  await act(async () => { r.unmount(); });
  assert.equal(globalThis.__tenantFeaturesSocket.count("tenant:features-changed"), 0);
});

// ------------------------------------------------------------------------------------------------ sidebars

const sidebarProps = { collapsed: false, onToggle() {}, mobileNavOpen: false, onMobileNavClose() {} };
const SIDEBAR_USER = { id: 1, role: "admin", systemAccess: "super_admin", fullName: "Test Admin", designation: null };

async function renderSidebar(kind, features) {
  sessionStorage.setItem("token", "t");
  sessionStorage.setItem("user", JSON.stringify(SIDEBAR_USER));
  globalThis.__tenantFeaturesApi = async () => ({ data: {} });
  const Sidebar = kind === "admin" ? modules.AdminSidebar : modules.EmployeeSidebar;
  const base = kind === "admin" ? "/acme/admin" : "/acme/employee";
  return render(withFeatures(features, React.createElement(Router.MemoryRouter, { initialEntries: [base] },
    React.createElement(Router.Routes, null, React.createElement(Router.Route, { path: "/:companySlug/*", element: React.createElement(Sidebar, sidebarProps) })))));
}
const labels = (container, selector) => [...container.querySelectorAll(selector)].map((el) => el.textContent.trim());

test("SIDEBARS: the admin menu shows only the modules the company has (and always Settings)", { skip: SKIP }, async () => {
  const only = await renderSidebar("admin", ["dashboard", "employee_management", "attendance", "task_management"]);
  const shown = labels(only, ".admin-sidebar-menu-name");
  for (const expected of ["Dashboard", "Tasks", "Employees", "Attendance", "Hierarchy", "Organization", "Settings"]) assert.ok(shown.includes(expected), `${expected} is shown (${shown})`);
  for (const hidden of ["Chat", "Meetings", "Smart Sheets", "Shift Management", "TechOps", "Reports", "Leave", "SOP Library"]) assert.ok(!shown.some((label) => label.startsWith(hidden)), `${hidden} is hidden (${shown})`);
});

test("SIDEBARS: a company with Chat, Meetings and Smart Sheets sees exactly those (plus what it always has)", { skip: SKIP }, async () => {
  const b = await renderSidebar("admin", ["dashboard", "employee_management", "attendance", "chat", "meetings", "smart_sheets"]);
  const shown = labels(b, ".admin-sidebar-menu-name");
  for (const expected of ["Chat", "Meetings", "Smart Sheets", "Attendance", "Employees"]) assert.ok(shown.some((label) => label.startsWith(expected)), `${expected} (${shown})`);
  for (const hidden of ["Tasks", "TechOps", "Shift Management"]) assert.ok(!shown.some((label) => label.startsWith(hidden)), hidden);
});

test("SIDEBARS: with no feature list (a legacy Reinsteins session) the admin menu is complete, as before", { skip: SKIP }, async () => {
  const all = await renderSidebar("admin", null);
  const shown = labels(all, ".admin-sidebar-menu-name");
  for (const expected of ["Dashboard", "TechOps", "Tasks", "Employees", "Attendance", "Shift Management", "Smart Sheets", "Chat", "Meetings", "Settings"]) assert.ok(shown.some((label) => label.startsWith(expected)), expected);
});

test("SIDEBARS: the employee menu is filtered the same way", { skip: SKIP }, async () => {
  const container = await renderSidebar("employee", ["dashboard", "attendance", "chat", "smart_sheets"]);
  const shown = labels(container, ".employee-sidebar-menu-name");
  for (const expected of ["Dashboard", "Attendance", "Smart Sheets", "Chat", "Settings", "My Profile"]) assert.ok(shown.some((label) => label.startsWith(expected)), `${expected} (${shown})`);
  for (const hidden of ["My Tasks", "My Leave", "Meetings", "SOPs", "Email", "Hierarchy", "My Reporting Manager"]) assert.ok(!shown.some((label) => label.startsWith(hidden)), `${hidden} (${shown})`);
});

// ------------------------------------------------------------------------------------------------ Owner Portal: create + edit

const typeInto = async (input, value) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
};
const ownerApi = (overrides = {}) => async (method, url, body) => {
  if (overrides[`${method} ${url}`]) return overrides[`${method} ${url}`](body);
  if (url === "/plans") return { data: { plans: [] } };
  if (url === "/companies/features/catalog") return { data: { features: FEATURES_CATALOG } };
  if (method === "POST" && url === "/companies") return { data: { company: { id: 5, companyName: "Acme" } } };
  if (method === "POST" && url === "/companies/5/admin") return { data: { success: true } };
  return { data: {} };
};
const buttonNamed = (container, label) => [...container.querySelectorAll("button")].find((b) => b.textContent.trim() === label);

test("OWNER UI: Add Company shows the Feature Configuration section and sends exactly the selected modules with the new company", { skip: SKIP }, async () => {
  globalThis.__platformApi = ownerApi();
  let created = null;
  const container = await render(React.createElement(modules.AddCompanyModal, { onClose() {}, onCreated: (company) => { created = company; }, onPartialSuccess() {} }));
  await settle();
  assert.match(text(container), /Feature Configuration/);
  assert.equal(text(container.querySelector('[data-testid="feature-selected-count"]')), "7 of 7 features selected", "starts with every module; the Owner removes what the company must not have");

  // Company A: Dashboard, Employee Management, Attendance only
  for (const id of ["shift_management", "meetings", "chat", "smart_sheets"]) await click(checkbox(container, id));
  assert.equal(text(container.querySelector('[data-testid="feature-selected-count"]')), "3 of 7 features selected");

  await typeInto(container.querySelector("#company-name"), "Company A");
  await typeInto(container.querySelector("#company-slug"), "company_a");
  await typeInto(container.querySelector("#admin-name"), "Jane Doe");
  await typeInto(container.querySelector("#admin-email"), "jane@company-a.com");
  await typeInto(container.querySelector("#admin-password"), "password123");
  await click(buttonNamed(container, "Create Company"));
  await settle();

  const post = globalThis.__platformCalls.find((c) => c.method === "POST" && c.url === "/companies");
  assert.ok(post, "the company was created");
  assert.deepEqual(post.body.features, ["dashboard", "employee_management", "attendance"], "exactly the Owner's selection");
  assert.equal(post.body.companySlug, "company_a");
  assert.ok(created, "the existing creation flow still completes");
});

test("OWNER UI: creating a company with NO module selected is blocked before any request", { skip: SKIP }, async () => {
  globalThis.__platformApi = ownerApi();
  const container = await render(React.createElement(modules.AddCompanyModal, { onClose() {}, onCreated() {}, onPartialSuccess() {} }));
  await settle();
  await click(buttonNamed(container, "Deselect All"));
  await typeInto(container.querySelector("#company-name"), "Empty Co");
  await typeInto(container.querySelector("#company-slug"), "empty_co");
  await typeInto(container.querySelector("#admin-name"), "Jane");
  await typeInto(container.querySelector("#admin-email"), "jane@empty.com");
  await typeInto(container.querySelector("#admin-password"), "password123");
  await click(buttonNamed(container, "Create Company"));
  assert.match(text(container), /Select at least one feature/);
  assert.equal(globalThis.__platformCalls.filter((c) => c.method === "POST").length, 0, "nothing was created");
});

test("OWNER UI: Manage Features on an existing company shows what is enabled, saves the change, and warns what turning off means", { skip: SKIP }, async () => {
  let saved = null;
  globalThis.__platformApi = ownerApi({
    "GET /companies/7/features": () => ({ data: { features: ["dashboard", "employee_management", "chat", "smart_sheets"], configured: true } }),
    "PUT /companies/7/features": (body) => { saved = body.features; return { data: { features: body.features } }; },
  });
  const container = await render(React.createElement(modules.CompanyFeaturesCard, { companyId: 7 }));
  await settle();
  assert.equal(checkbox(container, "chat").checked, true, "the currently enabled features are shown");
  assert.equal(checkbox(container, "meetings").checked, false);
  assert.equal(buttonNamed(container, "Save Features").disabled, true, "nothing to save yet");

  await click(checkbox(container, "attendance")); // enable one more
  await click(checkbox(container, "smart_sheets")); // disable one
  assert.equal(buttonNamed(container, "Save Features").disabled, false);
  assert.match(text(container.querySelector('[data-testid="features-turning-off"]')), /Saving will turn off: Smart Sheets/);

  await click(buttonNamed(container, "Save Features"));
  await settle();
  assert.deepEqual(saved, ["dashboard", "employee_management", "attendance", "chat"], "the complete new selection is sent");
  assert.equal(buttonNamed(container, "Save Features").disabled, true, "saved: nothing pending");
  assert.equal(container.querySelector('[data-testid="features-turning-off"]'), null);
});

test("OWNER UI: a refused save (the server says a dependency is missing) leaves the Owner's selection on screen for correction", { skip: SKIP }, async () => {
  globalThis.__platformApi = ownerApi({
    "GET /companies/7/features": () => ({ data: { features: ["dashboard"], configured: true } }),
    "PUT /companies/7/features": () => { const error = new Error("refused"); error.response = { data: { message: "Meetings requires Employee Management." } }; throw error; },
  });
  const container = await render(React.createElement(modules.CompanyFeaturesCard, { companyId: 7 }));
  await settle();
  await click(checkbox(container, "chat"));
  await click(buttonNamed(container, "Save Features"));
  await settle();
  assert.equal(checkbox(container, "chat").checked, true, "the selection is still there");
  assert.equal(buttonNamed(container, "Save Features").disabled, false, "and can be corrected and retried");
});
