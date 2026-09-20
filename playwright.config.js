const { defineConfig, devices } = require("@playwright/test");
const { VIEWPORTS } = require("./e2e/viewports");

// ==========================================
// PLAYWRIGHT CONFIGURATION -- Production Readiness Audit
//
// Assumes the backend (server/app.js) is ALREADY running on
// http://localhost:5000 before `npx playwright test` is invoked --
// same "server must already be up" convention every existing
// server/_test_*.js integration test already relies on. This keeps
// the backend's disposable-test-database environment overrides
// (PLATFORM_DB_HOST/PORT/USER/PASSWORD/NAME) a run-time concern
// rather than baking a specific test-DB configuration into this
// file.
//
// The frontend (Vite dev server) IS managed here via `webServer`,
// since it needs no special environment and starting it is the same
// regardless of which backend/database it's pointed at (it always
// talks to http://localhost:5000 by default -- see
// client/src/config.js's VITE_API_URL fallback).
//
// globalSetup (e2e/global-setup.js) seeds one disposable tenant
// (Owner/Admin/Employee/Stakeholder/HR fixtures) via real HTTP calls
// against the already-running backend, and writes the resulting
// credentials to e2e/.fixtures.json for every spec file to reuse --
// mirrors the exact provisioning pattern already used throughout
// server/_test_*.js (never touches any real tenant).
//
// Four projects cover "Desktop / Laptop / Tablet / Mobile" for the
// full functional suite; e2e/responsiveness.spec.js separately sweeps
// ALL seven required viewport sizes (see viewports.js) against a set
// of critical routes for layout-only checks (no horizontal scroll,
// no clipped/overlapping content, reachable controls).
// ==========================================

module.exports = defineConfig({

  testDir: "./e2e",
  fullyParallel: false, // shared seeded tenant -- avoid cross-test data races
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e-report" }]],
  timeout: 45_000,

  globalSetup: require.resolve("./e2e/global-setup.js"),

  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },

  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop1440 },
    },
    {
      name: "laptop",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.laptop1280 },
    },
    {
      name: "tablet",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.tablet768, hasTouch: true },
    },
    {
      name: "mobile",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.mobile390, hasTouch: true, isMobile: true },
    },
  ],

  webServer: {
    command: "npm run dev",
    cwd: "./client",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    timeout: 60_000,
  },

});
