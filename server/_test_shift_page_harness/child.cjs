// Runs inside a CHILD process (React's scheduler keeps message ports open, so an in-process run would never
// exit, and jsdom globals stay out of the test runner). TZ is set by the parent before this process starts.
const { JSDOM } = require(process.env.JSDOM_DIR);
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
define("window", dom.window);
define("document", dom.window.document);
define("sessionStorage", dom.window.sessionStorage);
define("navigator", dom.window.navigator);
define("HTMLElement", dom.window.HTMLElement);
define("requestAnimationFrame", (cb) => setTimeout(cb, 0));

// "Today" is fixed (Friday 2026-10-23, local time) so every range is deterministic.
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(2026, 9, 23, 10, 0, 0); else super(...args); }
  static now() { return new RealDate(2026, 9, 23, 10, 0, 0).getTime(); }
}
define("Date", FixedDate);

const { runAll } = require("./dist/harness.cjs");
runAll()
  .then((results) => {
    process.stdout.write("RESULTS:" + JSON.stringify({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, results }) + "\n");
    process.exit(0);
  })
  .catch((e) => { process.stderr.write("RENDER HARNESS ERROR [step: " + globalThis.__step + "] " + String((e && e.stack) || e) + "\n"); process.exit(2); });
