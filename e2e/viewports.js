// Shared viewport sizes -- used by playwright.config.js (project
// definitions) and by e2e/responsiveness.spec.js (which sweeps ALL of
// these against a handful of critical routes, beyond the 4 projects
// Playwright itself runs the full suite against).
const VIEWPORTS = {
  mobile320: { width: 320, height: 568 },
  mobile375: { width: 375, height: 667 },
  mobile390: { width: 390, height: 844 },
  mobile414: { width: 414, height: 896 },
  tablet768: { width: 768, height: 1024 },
  laptop1280: { width: 1280, height: 800 },
  desktop1440: { width: 1440, height: 900 },
};

module.exports = { VIEWPORTS };
