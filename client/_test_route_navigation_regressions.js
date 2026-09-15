import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// FRONTEND ROUTE/NAVIGATION REGRESSION CHECK
//
// No component-rendering test framework (Jest/Vitest/RTL) exists in
// this project, so this is a plain, dependency-free static source
// check -- run with `node _test_route_navigation_regressions.js` from
// client/. It specifically guards against the exact bug class found
// in production: a company-aware tenant employee navigating to
// Employee Profile or the Meeting Room got a completely blank white
// screen (no error boundary exists anywhere in this app, so any
// uncaught render-time exception unmounts the whole tree).
//
// Root cause was two-fold:
//   1. components/Layout/EmployeeSidebar.jsx computed its `basePath`
//      with `const basePath = companySlug ? \`...\` : basePath;` --
//      a self-referential const that throws
//      "ReferenceError: Cannot access 'basePath' before
//      initialization" every time it renders under the unprefixed
//      "/employee/..." route tree (companySlug undefined). Since
//      EmployeeSidebar is rendered by EmployeeLayout for every
//      employee route, this alone is a full-app-crashing defect
//      whenever companySlug is absent.
//   2. Several navigation call sites hardcoded
//      `basePath = isAdmin ? "/admin" : "/employee"`, ignoring
//      companySlug entirely -- so a company-scoped tenant employee
//      clicking "View My Profile" or "Join Meeting" was sent OFF
//      their "/:companySlug/employee/..." route tree and onto the
//      broken unprefixed one, triggering (1).
// ==========================================

const CLIENT_SRC = path.join(__dirname, "src");

let failures = 0;

function check(label, cond, detail) {
    if (cond) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

function listJsxFiles(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === "node_modules") continue;
            out.push(...listJsxFiles(full));
        } else if (entry.name.endsWith(".jsx") || entry.name.endsWith(".js")) {
            out.push(full);
        }
    }
    return out;
}

(function main() {

    console.log("=== SELF-REFERENTIAL CONST CHECK (bug #1's exact shape) ===");

    // const X = <cond> ? <expr> : X;  -- X on both the LHS and the
    // falsy branch of its own initializer is always a bug: X cannot
    // be referenced before its own declaration finishes.
    const selfRefPattern = /const\s+([a-zA-Z_$][\w$]*)\s*=\s*[^;]*\?\s*[^:;]*:\s*\1\s*;/g;

    let selfRefHits = [];
    for (const file of listJsxFiles(CLIENT_SRC)) {
        const content = fs.readFileSync(file, "utf8");
        let match;
        selfRefPattern.lastIndex = 0;
        while ((match = selfRefPattern.exec(content))) {
            selfRefHits.push(`${path.relative(CLIENT_SRC, file)}: const ${match[1]} = ... : ${match[1]};`);
        }
    }

    check(
        "No self-referential const declarations anywhere in src/ (the exact EmployeeSidebar.jsx bug shape)",
        selfRefHits.length === 0,
        JSON.stringify(selfRefHits)
    );

    console.log("\n=== EMPLOYEE SIDEBAR basePath (bug #1) ===");

    const sidebarPath = path.join(CLIENT_SRC, "components/Layout/EmployeeSidebar.jsx");
    const sidebarSrc = fs.readFileSync(sidebarPath, "utf8");

    check(
        "EmployeeSidebar.jsx basePath falls back to a literal \"/employee\" string, not itself",
        /const basePath = companySlug \? `\/\$\{companySlug\}\/employee` : "\/employee";/.test(sidebarSrc)
    );

    console.log("\n=== COMPANY-SLUG-AWARE NAVIGATION (bug #2) ===");

    // Every one of these files navigates to Employee Profile or the
    // Meeting Room and must preserve companySlug when present --
    // otherwise a tenant employee is silently routed onto the
    // unprefixed tree (harmless post-fix-#1, but still an
    // architecture regression of the "Phase 8" company-aware
    // navigation convention used everywhere else in the sidebar/menu
    // code).
    const filesRequiringCompanySlugAwareBasePath = [
        "components/EmployeeProfileAvatar.jsx",
        "pages/Meetings/MeetingsList.jsx",
        "pages/Meetings/MeetingDetails.jsx",
        "pages/Meetings/JoinMeetingModal.jsx",
    ];

    for (const relPath of filesRequiringCompanySlugAwareBasePath) {
        const fullPath = path.join(CLIENT_SRC, relPath);
        const src = fs.readFileSync(fullPath, "utf8");

        check(
            `${relPath} reads companySlug via useParams()`,
            /useParams\(\)/.test(src) && /companySlug/.test(src)
        );

        check(
            `${relPath} no longer hardcodes an unconditional "/employee" or "/admin" basePath`,
            !/const basePath = isAdmin \? "\/admin" : "\/employee";/.test(src) &&
            !/const basePath = role === "admin" \? "\/admin" : "\/employee";/.test(src)
        );
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`RESULT: ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    console.log("=".repeat(60));

    process.exit(failures === 0 ? 0 : 1);

})();
