require("dotenv").config();

const tenantUploadPath = require("./utils/tenantUploadPath");
const { resolveLogoDestination } = require("./middleware/companyLogoUploadMiddleware");
const { handleLogoUploadError } = require("./controllers/platformCompanyController");

// ==========================================
// COMPANY LOGO UPLOAD -- DESTINATION-DIRECTORY ERROR HANDLING SELF-TEST
//
// Focused, no real HTTP/DB/filesystem writes needed -- both units
// under test are plain functions. Proves:
//   1. A destination-directory failure (EACCES/ENOENT/ENOTDIR/other)
//      reaches multer's callback as an error, never as a thrown
//      exception that could escape multer's own handling.
//   2. handleLogoUploadError's client-facing response never contains
//      the error's code, message, path, or stack -- only the existing
//      generic "Failed to upload company logo." text.
//   3. The real error IS observable server-side (captured via a
//      temporary console.error monkey-patch), distinguishing
//      EACCES/ENOENT/ENOTDIR/other filesystem codes from Multer's own
//      error codes and from the file-type-rejection case.
//
// Does not touch any real file, directory, or database -- only
// tenantUploadAbsoluteDirForSlug (a pure function reference) and
// console.error are monkey-patched, both restored immediately after.
// ==========================================

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

function makeRes() {
    return {
        statusCode: null,
        payload: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.payload = payload; return this; },
    };
}

function withCapturedConsoleError(fn) {
    const captured = [];
    const original = console.error;
    console.error = (...args) => { captured.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ")); };
    try {
        fn();
    } finally {
        console.error = original;
    }
    return captured.join("\n");
}

(async () => {

    // ==========================================
    // CASE 1 -- resolveLogoDestination calls back with the error
    // instead of throwing, for each of EACCES/ENOENT/ENOTDIR
    // ==========================================
    console.log("1. CASE 1 -- destination-directory failures reach multer's callback as an error, never a thrown exception");

    for (const code of ["EACCES", "ENOENT", "ENOTDIR"]) {

        const original = tenantUploadPath.tenantUploadAbsoluteDirForSlug;
        tenantUploadPath.tenantUploadAbsoluteDirForSlug = () => {
            const err = new Error(`simulated ${code} creating branding directory`);
            err.code = code;
            throw err;
        };

        let threw = false;
        let callbackError = null;
        let callbackDir = null;

        try {
            resolveLogoDestination(
                { targetCompany: { companySlug: "logouploaderrortest" } },
                { originalname: "logo.png" },
                (err, dir) => { callbackError = err; callbackDir = dir; }
            );
        } catch (_err) {
            threw = true;
        } finally {
            tenantUploadPath.tenantUploadAbsoluteDirForSlug = original;
        }

        check(`CASE 1 (${code}): resolveLogoDestination did not throw synchronously`, !threw);
        check(`CASE 1 (${code}): multer's callback received the real error, not a directory`, !!callbackError && callbackError.code === code, JSON.stringify({ callbackError: callbackError?.message, callbackDir }));
    }

    // Sanity check: the success path still works unchanged (a
    // non-throwing directory resolver still calls back with (null, dir)).
    {
        const original = tenantUploadPath.tenantUploadAbsoluteDirForSlug;
        tenantUploadPath.tenantUploadAbsoluteDirForSlug = () => "/fake/uploads/tenant_logouploaderrortest/branding";
        let callbackError = "unset";
        let callbackDir = null;
        try {
            resolveLogoDestination(
                { targetCompany: { companySlug: "logouploaderrortest" } },
                { originalname: "logo.png" },
                (err, dir) => { callbackError = err; callbackDir = dir; }
            );
        } finally {
            tenantUploadPath.tenantUploadAbsoluteDirForSlug = original;
        }
        check("CASE 1 (success path): callback receives (null, dir) unchanged when directory resolution succeeds", callbackError === null && callbackDir === "/fake/uploads/tenant_logouploaderrortest/branding");
    }

    // ==========================================
    // CASE 2 -- handleLogoUploadError: client response never leaks
    // filesystem details, for each error category
    // ==========================================
    console.log("\n2. CASE 2 -- handleLogoUploadError never exposes filesystem paths/codes/stacks to the client");

    const scenarios = [
        { label: "EACCES", error: Object.assign(new Error("permission denied, mkdir '/var/www/reinsteins-crm/server/uploads/tenant_reinsteins/branding'"), { code: "EACCES", path: "/var/www/reinsteins-crm/server/uploads/tenant_reinsteins/branding" }) },
        { label: "ENOENT", error: Object.assign(new Error("no such file or directory, mkdir '/var/www/reinsteins-crm/server/uploads/tenant_reinsteins/branding'"), { code: "ENOENT" }) },
        { label: "ENOTDIR", error: Object.assign(new Error("not a directory, mkdir '/var/www/reinsteins-crm/server/uploads/tenant_reinsteins/branding'"), { code: "ENOTDIR" }) },
        { label: "Multer file-size limit", error: (() => { const e = new Error("File too large"); e.code = "LIMIT_FILE_SIZE"; e.name = "MulterError"; Object.setPrototypeOf(e, require("multer").MulterError.prototype); return e; })() },
        { label: "file-type rejection", error: new Error("Only JPG, JPEG, PNG and WEBP images are allowed") },
        { label: "other/unknown", error: new Error("something unexpected") },
    ];

    for (const scenario of scenarios) {
        const res = makeRes();
        const logged = withCapturedConsoleError(() => {
            handleLogoUploadError(scenario.error, {}, res, () => {});
        });

        check(`CASE 2 (${scenario.label}): status is 500 (unchanged, matches setCompanyLogo's own generic failure)`, res.statusCode === 500);
        check(
            `CASE 2 (${scenario.label}): response body is EXACTLY the existing generic message, nothing else`,
            JSON.stringify(res.payload) === JSON.stringify({ success: false, message: "Failed to upload company logo." }),
            JSON.stringify(res.payload)
        );
        check(`CASE 2 (${scenario.label}): response body does not contain the real error code`, !JSON.stringify(res.payload).includes(scenario.error.code || "\u0000never"));
        check(`CASE 2 (${scenario.label}): response body does not contain any filesystem path`, !JSON.stringify(res.payload).includes("/var/www"));
        check(`CASE 2 (${scenario.label}): response body does not contain a stack trace`, !JSON.stringify(res.payload).includes("at "));

        // ---- Case 3: the real error IS observable server-side ----
        check(`CASE 3 (${scenario.label}): the real error code/message WAS logged server-side`, logged.includes(scenario.error.code || scenario.error.message), logged);
    }

    // ---------- Report ----------
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);

})().catch((error) => {
    console.error("TEST SCRIPT ERROR:", error);
    process.exit(1);
});
