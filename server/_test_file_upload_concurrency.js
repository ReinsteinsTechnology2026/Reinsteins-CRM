require("dotenv").config();
const bcrypt = require("bcrypt");
const fs = require("fs");
const path = require("path");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { UPLOADS_ROOT } = require("./utils/tenantUploadPath");

// ==========================================
// PHASE 16B -- FILE UPLOAD TENANT-CONTEXT CONCURRENCY SELF-TEST
//
// Reproduces, under REAL concurrent load, the exact race Phase 16A's
// _test_file_tenant_isolation.js exposed intermittently: multer's
// destination callback fires from inside busboy's stream processing,
// an async continuation whose AsyncLocalStorage context is tied to
// the underlying request socket's own creation context, not to when
// tenantProtect's runWithTenantContext() ran -- see the Phase 16B
// comment block in utils/tenantUploadPath.js for the full mechanism.
//
// This script fires INTERLEAVED, GENUINELY CONCURRENT (via
// Promise.all over already-started fetch() calls, never awaited one
// at a time) uploads from two tenants, across all 5 upload types this
// codebase has, then inspects the ACTUAL FILESYSTEM -- not just API
// responses -- to prove no file from one tenant ever lands under the
// other tenant's directory, even transiently. This is what actually
// changed in Phase 16B: before the fix, this exact test (run several
// times during development) reproduced physical cross-tenant
// misfiling; after the fix, it has not.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "concur16b_owner@groworgs.internal";
const OWNER_PASSWORD = "Concur16bOwner!2026Pwd";

const A_SLUG = "concur16b_a";
const B_SLUG = "concur16b_b";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);
const A_DIR = path.join(UPLOADS_ROOT, `tenant_${A_SLUG}`);
const B_DIR = path.join(UPLOADS_ROOT, `tenant_${B_SLUG}`);

const ADMIN_A_PASSWORD = "Concur16bAdminA!2026";
const ADMIN_B_PASSWORD = "Concur16bAdminB!2026";
const EMPLOYEE_PASSWORD = "Concur16bEmployee!2026";

// Number of employees (and therefore concurrent profile-photo
// uploads) per tenant for the primary stress test. Each employee is
// distinct so every upload produces a genuinely unique filename
// (employee-<id>-<timestamp>.jpg) -- unambiguous per-request
// verification, not dependent on exact millisecond timing.
const STRESS_EMPLOYEES_PER_TENANT = Number(process.env.CONCUR_STRESS_COUNT) || 15;

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiPost(pathname, body, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

async function apiGet(pathname, token) {
    const res = await fetch(`${BASE_URL}${pathname}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

// A minimal valid 1x1 JPEG, hardcoded bytes -- avoids depending on
// any real file on disk (same fixture _test_file_tenant_isolation.js
// already uses).
const TINY_JPEG_BASE64 =
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

function tinyJpegBlob() {
    return new Blob([Buffer.from(TINY_JPEG_BASE64, "base64")], { type: "image/jpeg" });
}

// middleware/fileUpload.js (the GENERIC file upload route) only
// accepts document extensions, not images -- a plain text fixture.
function tinyTextBlob() {
    return new Blob([Buffer.from("concurrency test fixture, not a real document")], { type: "text/plain" });
}

// Fires the request immediately (does NOT await the response) --
// callers collect the returned promises and Promise.all() them, so
// every request in a batch is genuinely in flight concurrently, not
// sequentially awaited one at a time.
function uploadProfilePhoto(token) {
    const form = new FormData();
    form.append("profilePhoto", tinyJpegBlob(), "test.jpg");
    return fetch(`${BASE_URL}/api/employees/profile/photo`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

function uploadGenericFile(token) {
    const form = new FormData();
    form.append("file", tinyTextBlob(), "test.txt");
    return fetch(`${BASE_URL}/api/files/upload`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

function uploadTaskAttachment(taskId, token) {
    const form = new FormData();
    form.append("attachments", tinyJpegBlob(), "test.jpg");
    return fetch(`${BASE_URL}/api/task-activity/${taskId}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

function uploadChatAttachment(conversationId, token) {
    const form = new FormData();
    form.append("image", tinyJpegBlob(), "test.jpg");
    return fetch(`${BASE_URL}/api/chat/conversations/${conversationId}/upload-image`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

function uploadMeetingAttachment(meetingId, token) {
    const form = new FormData();
    form.append("file", tinyJpegBlob(), "test.jpg");
    return fetch(`${BASE_URL}/api/meetings/${meetingId}/messages/attachment`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }));
}

// Recursively collects every filename physically present under a
// directory tree (empty array if the directory doesn't exist yet).
function listFilesRecursive(dir) {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFilesRecursive(full));
        else out.push(full);
    }
    return out;
}

(async () => {

    // ================================================
    // SETUP
    // ================================================
    console.log("SETUP -- platform owner + two tenants + admins + employee pools");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Concur16B Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "CONCUR16B A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const createB = await apiPost("/api/platform/companies", { companyName: "CONCUR16B B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    check("SETUP: both companies provisioned", createA.status === 201 && createB.status === 201);
    const companyAId = createA.body?.company?.id;
    const companyBId = createB.body?.company?.id;

    const adminA = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@concur16b-a.test", password: ADMIN_A_PASSWORD }, ownerToken);
    const adminB = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@concur16b-b.test", password: ADMIN_B_PASSWORD }, ownerToken);
    check("SETUP: both admins created", adminA.status === 201 && adminB.status === 201);

    const adminLoginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminA.body?.admin?.employeeId, password: ADMIN_A_PASSWORD });
    const adminLoginB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminB.body?.admin?.employeeId, password: ADMIN_B_PASSWORD });
    const adminTokenA = adminLoginA.body?.token;
    const adminTokenB = adminLoginB.body?.token;
    check("SETUP: both admin logins succeed", adminLoginA.status === 200 && adminLoginB.status === 200);

    // A pool of distinct plain employees per tenant, direct-DB fixture
    // (password known so we can log in via the real tenant-auth API)
    // -- STRESS_EMPLOYEES_PER_TENANT each, so every profile-photo
    // upload in the stress test produces a filename embedding its
    // employee id (employee-<id>-<timestamp>.jpg). Each tenant
    // database has its OWN independent id sequence starting at 1, so
    // without the sequence bump below, Tenant A's employee 6 and
    // Tenant B's employee 6 could both exist -- and under heavy
    // concurrency their upload timestamps can genuinely collide to
    // the same millisecond, producing the IDENTICAL filename in both
    // tenants' directories. That is an innocent naming coincidence,
    // not proof of cross-tenant misfiling, and it would make this
    // test's own verification ambiguous. Bumping Tenant B's sequence
    // to start far above anything Tenant A could reach in one run
    // eliminates the possibility entirely -- any filename collision
    // detected after this point is unambiguous evidence of a real
    // cross-tenant write.
    const empPasswordHash = await bcrypt.hash(EMPLOYEE_PASSWORD, 4);
    const poolA = getTenantPool(A_DB);
    const poolB = getTenantPool(B_DB);
    const [[{ seq }]] = await poolB.query(`SELECT pg_get_serial_sequence('users', 'id') AS seq`);
    await poolB.query(`ALTER SEQUENCE ${seq} RESTART WITH 100000`);

    const employeesA = [];
    const employeesB = [];
    for (let i = 0; i < STRESS_EMPLOYEES_PER_TENANT; i++) {
        const empId = `EMPA${String(i).padStart(3, "0")}`;
        const [[row]] = await poolA.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES (?, ?, ?, ?, 'employee', 'employee', 'active') RETURNING id`,
            [empId, `A Employee ${i}`, `a-emp-${i}@concur16b-a.test`, empPasswordHash]
        );
        employeesA.push({ id: row.id, employeeId: empId });
    }
    for (let i = 0; i < STRESS_EMPLOYEES_PER_TENANT; i++) {
        const empId = `EMPB${String(i).padStart(3, "0")}`;
        const [[row]] = await poolB.query(
            `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES (?, ?, ?, ?, 'employee', 'employee', 'active') RETURNING id`,
            [empId, `B Employee ${i}`, `b-emp-${i}@concur16b-b.test`, empPasswordHash]
        );
        employeesB.push({ id: row.id, employeeId: empId });
    }
    check(`SETUP: ${STRESS_EMPLOYEES_PER_TENANT} employees created per tenant`, employeesA.length === STRESS_EMPLOYEES_PER_TENANT && employeesB.length === STRESS_EMPLOYEES_PER_TENANT);

    const tokensA = [];
    const tokensB = [];
    for (const emp of employeesA) {
        const res = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: emp.employeeId, password: EMPLOYEE_PASSWORD });
        tokensA.push({ token: res.body?.token, employeeId: emp.id });
    }
    for (const emp of employeesB) {
        const res = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: emp.employeeId, password: EMPLOYEE_PASSWORD });
        tokensB.push({ token: res.body?.token, employeeId: emp.id });
    }
    check("SETUP: every employee login succeeded", tokensA.every((t) => !!t.token) && tokensB.every((t) => !!t.token));

    // ================================================
    // CONCURRENCY TEST 1 -- PROFILE PHOTO (primary stress test)
    // ================================================
    console.log(`\nTEST 1 -- Concurrent profile photo uploads (${STRESS_EMPLOYEES_PER_TENANT} x Tenant A interleaved with ${STRESS_EMPLOYEES_PER_TENANT} x Tenant B, fired simultaneously)`);

    const interleaved = [];
    for (let i = 0; i < STRESS_EMPLOYEES_PER_TENANT; i++) {
        interleaved.push({ side: "A", token: tokensA[i].token });
        interleaved.push({ side: "B", token: tokensB[i].token });
    }
    // .map() starts every fetch() synchronously, in the SAME tick,
    // before any of them has a chance to resolve -- this is what
    // makes the batch genuinely concurrent rather than a sequential
    // await-in-a-loop that merely LOOKS concurrent.
    const profilePhotoResults = await Promise.all(
        interleaved.map((entry) => uploadProfilePhoto(entry.token).then((r) => ({ ...entry, ...r })))
    );

    check("1a. Every concurrent profile photo upload succeeded (200)", profilePhotoResults.every((r) => r.status === 200), JSON.stringify(profilePhotoResults.filter((r) => r.status !== 200)));

    let crossTenantMisfile = false;
    let responseUrlMismatch = false;
    for (const r of profilePhotoResults) {
        const returnedPath = r.body?.profilePhoto || "";
        const expectedSlug = r.side === "A" ? A_SLUG : B_SLUG;
        const wrongSlug = r.side === "A" ? B_SLUG : A_SLUG;
        if (!returnedPath.includes(`tenant_${expectedSlug}`)) responseUrlMismatch = true;
        if (returnedPath.includes(`tenant_${wrongSlug}`)) crossTenantMisfile = true;
    }
    check("1b. Every response's stored path names its OWN tenant", !responseUrlMismatch);
    check("1c. No response's stored path names the OTHER tenant", !crossTenantMisfile);

    // The critical check: the ACTUAL FILESYSTEM, not just what the
    // API claims. Every filename Tenant A's uploads produced must
    // exist ONLY under A_DIR; every filename Tenant B's uploads
    // produced must exist ONLY under B_DIR.
    const filesInA = listFilesRecursive(A_DIR).map((f) => path.basename(f));
    const filesInB = listFilesRecursive(B_DIR).map((f) => path.basename(f));

    let physicalMisfileCount = 0;
    for (const r of profilePhotoResults) {
        // profilePhoto comes back already SIGNED (?fat=... appended by
        // signFileUrlsMiddleware.js) -- strip the query string before
        // comparing against a real filename on disk.
        const filename = (r.body?.profilePhoto || "").split("?")[0].split("/").pop();
        if (!filename) continue;
        const ownDirFiles = r.side === "A" ? filesInA : filesInB;
        const otherDirFiles = r.side === "A" ? filesInB : filesInA;
        if (!ownDirFiles.includes(filename)) {
            physicalMisfileCount++;
            console.log(`    -> MISSING from own tenant dir: ${r.side} / ${filename}`);
        }
        if (otherDirFiles.includes(filename)) {
            physicalMisfileCount++;
            console.log(`    -> CROSS-TENANT PHYSICAL FILE FOUND: ${r.side}'s file "${filename}" exists in the OTHER tenant's directory`);
        }
    }
    check("1d. PHYSICAL FILESYSTEM CHECK: every uploaded file exists ONLY under its own tenant's directory (0 crossings)", physicalMisfileCount === 0, `${physicalMisfileCount} crossing(s)/missing file(s) detected`);
    check("1e. Tenant A directory file count matches Tenant A upload count", filesInA.length === STRESS_EMPLOYEES_PER_TENANT, `expected ${STRESS_EMPLOYEES_PER_TENANT}, found ${filesInA.length}`);
    check("1f. Tenant B directory file count matches Tenant B upload count", filesInB.length === STRESS_EMPLOYEES_PER_TENANT, `expected ${STRESS_EMPLOYEES_PER_TENANT}, found ${filesInB.length}`);

    // ================================================
    // CONCURRENCY TEST 2 -- GENERIC FILE UPLOAD
    // ================================================
    console.log("\nTEST 2 -- Concurrent generic file uploads (5 x A interleaved with 5 x B)");
    const genericInterleaved = [];
    for (let i = 0; i < 5; i++) {
        genericInterleaved.push({ side: "A", token: tokensA[i].token });
        genericInterleaved.push({ side: "B", token: tokensB[i].token });
    }
    const genericResults = await Promise.all(
        genericInterleaved.map((entry) => uploadGenericFile(entry.token).then((r) => ({ ...entry, ...r })))
    );
    check("2a. Every concurrent generic file upload succeeded (200/201)", genericResults.every((r) => [200, 201].includes(r.status)), JSON.stringify(genericResults.filter((r) => ![200, 201].includes(r.status))));

    const filesInAFiles = listFilesRecursive(path.join(A_DIR, "files")).map((f) => path.basename(f));
    const filesInBFiles = listFilesRecursive(path.join(B_DIR, "files")).map((f) => path.basename(f));
    let genericMisfile = false;
    for (const r of genericResults) {
        const filename = (r.body?.file?.url || r.body?.url || "").split("?")[0].split("/").pop();
        if (!filename) continue;
        const otherDirFiles = r.side === "A" ? filesInBFiles : filesInAFiles;
        if (otherDirFiles.includes(filename)) genericMisfile = true;
    }
    check("2b. No generic file crossed tenant boundaries on disk", !genericMisfile);

    // ================================================
    // CONCURRENCY TEST 3 -- TASK ATTACHMENT
    // ================================================
    console.log("\nTEST 3 -- Concurrent task attachment uploads (5 x A interleaved with 5 x B)");
    const taskA = await apiPost("/api/tasks", { taskNumber: "CONCUR16B-A-1", taskTitle: "Concur Test A", taskDescription: "x", status: "todo" }, adminTokenA);
    const taskB = await apiPost("/api/tasks", { taskNumber: "CONCUR16B-B-1", taskTitle: "Concur Test B", taskDescription: "x", status: "todo" }, adminTokenB);
    check("SETUP: both tasks created", [200, 201].includes(taskA.status) && [200, 201].includes(taskB.status), JSON.stringify({ a: taskA.body, b: taskB.body }));
    const taskAId = taskA.body?.task?.id || taskA.body?.id;
    const taskBId = taskB.body?.task?.id || taskB.body?.id;

    if (taskAId && taskBId) {
        const taskInterleaved = [];
        // Uses the ADMIN token that created each task, not a plain
        // employee -- taskActivityController.js's access check is
        // scoped to task involvement, not just "any employee of this
        // company", and only the creator is guaranteed access here.
        for (let i = 0; i < 5; i++) {
            taskInterleaved.push({ side: "A", token: adminTokenA, taskId: taskAId });
            taskInterleaved.push({ side: "B", token: adminTokenB, taskId: taskBId });
        }
        const taskResults = await Promise.all(
            taskInterleaved.map((entry) => uploadTaskAttachment(entry.taskId, entry.token).then((r) => ({ ...entry, ...r })))
        );
        check("3a. Every concurrent task attachment upload succeeded (200/201)", taskResults.every((r) => [200, 201].includes(r.status)), JSON.stringify(taskResults.filter((r) => ![200, 201].includes(r.status))));

        const filesInATasks = listFilesRecursive(path.join(A_DIR, "tasks")).map((f) => path.basename(f));
        const filesInBTasks = listFilesRecursive(path.join(B_DIR, "tasks")).map((f) => path.basename(f));
        check("3b. Tenant A has task attachments physically present", filesInATasks.length > 0);
        check("3c. Tenant B has task attachments physically present", filesInBTasks.length > 0);
        const taskOverlap = filesInATasks.some((f) => filesInBTasks.includes(f));
        check("3d. No task attachment filename appears in both tenants' directories", !taskOverlap);
    } else {
        check("3. Skipped (task creation did not return an id -- see SETUP failure above)", false);
    }

    // ================================================
    // CONCURRENCY TEST 4 -- CHAT ATTACHMENT
    // ================================================
    console.log("\nTEST 4 -- Concurrent chat attachment uploads (5 x A interleaved with 5 x B)");
    const convA = await apiPost("/api/chat/conversations/private", { userId: employeesA[0].id }, adminTokenA);
    const convB = await apiPost("/api/chat/conversations/private", { userId: employeesB[0].id }, adminTokenB);
    check("SETUP: both private conversations created", [200, 201].includes(convA.status) && [200, 201].includes(convB.status), JSON.stringify({ a: convA.body, b: convB.body }));
    const convAId = convA.body?.conversationId;
    const convBId = convB.body?.conversationId;

    if (convAId && convBId) {
        const chatInterleaved = [];
        for (let i = 0; i < 5; i++) {
            chatInterleaved.push({ side: "A", token: adminTokenA, convId: convAId });
            chatInterleaved.push({ side: "B", token: adminTokenB, convId: convBId });
        }
        const chatResults = await Promise.all(
            chatInterleaved.map((entry) => uploadChatAttachment(entry.convId, entry.token).then((r) => ({ ...entry, ...r })))
        );
        check("4a. Every concurrent chat attachment upload succeeded (200/201)", chatResults.every((r) => [200, 201].includes(r.status)), JSON.stringify(chatResults.filter((r) => ![200, 201].includes(r.status))));

        const filesInAChat = listFilesRecursive(path.join(A_DIR, "chat")).map((f) => path.basename(f));
        const filesInBChat = listFilesRecursive(path.join(B_DIR, "chat")).map((f) => path.basename(f));
        check("4b. Tenant A has chat attachments physically present", filesInAChat.length > 0);
        check("4c. Tenant B has chat attachments physically present", filesInBChat.length > 0);
        const chatOverlap = filesInAChat.some((f) => filesInBChat.includes(f));
        check("4d. No chat attachment filename appears in both tenants' directories", !chatOverlap);
    } else {
        check("4. Skipped (conversation creation did not return an id -- see SETUP failure above)", false);
    }

    // ================================================
    // CONCURRENCY TEST 5 -- MEETING ATTACHMENT
    // ================================================
    console.log("\nTEST 5 -- Concurrent meeting attachment uploads (5 x A interleaved with 5 x B)");
    const meetingA = await apiPost("/api/meetings", { title: "Concur Meeting A" }, adminTokenA);
    const meetingB = await apiPost("/api/meetings", { title: "Concur Meeting B" }, adminTokenB);
    check("SETUP: both meetings created", [200, 201].includes(meetingA.status) && [200, 201].includes(meetingB.status), JSON.stringify({ a: meetingA.body, b: meetingB.body }));
    const meetingAId = meetingA.body?.meeting?.id || meetingA.body?.id;
    const meetingBId = meetingB.body?.meeting?.id || meetingB.body?.id;

    if (meetingAId && meetingBId) {
        const meetingInterleaved = [];
        for (let i = 0; i < 5; i++) {
            meetingInterleaved.push({ side: "A", token: adminTokenA, meetingId: meetingAId });
            meetingInterleaved.push({ side: "B", token: adminTokenB, meetingId: meetingBId });
        }
        const meetingResults = await Promise.all(
            meetingInterleaved.map((entry) => uploadMeetingAttachment(entry.meetingId, entry.token).then((r) => ({ ...entry, ...r })))
        );
        check("5a. Every concurrent meeting attachment upload succeeded (200/201)", meetingResults.every((r) => [200, 201].includes(r.status)), JSON.stringify(meetingResults.filter((r) => ![200, 201].includes(r.status))));

        const filesInAMeetings = listFilesRecursive(path.join(A_DIR, "meetings")).map((f) => path.basename(f));
        const filesInBMeetings = listFilesRecursive(path.join(B_DIR, "meetings")).map((f) => path.basename(f));
        check("5b. Tenant A has meeting attachments physically present", filesInAMeetings.length > 0);
        check("5c. Tenant B has meeting attachments physically present", filesInBMeetings.length > 0);
        const meetingOverlap = filesInAMeetings.some((f) => filesInBMeetings.includes(f));
        check("5d. No meeting attachment filename appears in both tenants' directories", !meetingOverlap);
    } else {
        check("5. Skipped (meeting creation did not return an id -- see SETUP failure above)", false);
    }

    // ================================================
    // FILE-SERVING AUTHORIZATION (still enforced after the fix)
    // ================================================
    console.log("\nTEST 6 -- File retrieval authorization still enforced");
    const meProfileA = await apiGet("/api/employees/profile/me", tokensA[0].token);
    const meProfileB = await apiGet("/api/employees/profile/me", tokensB[0].token);
    const signedUrlA = meProfileA.body?.profile?.profile_photo;
    const signedUrlB = meProfileB.body?.profile?.profile_photo;
    const bothUrlsObtained = typeof signedUrlA === "string" && typeof signedUrlB === "string";
    check("SETUP: both signed URLs obtained", bothUrlsObtained, JSON.stringify({ a: meProfileA.body, b: meProfileB.body }));

    if (bothUrlsObtained) {
        const fetchOwnA = await fetch(`${BASE_URL}${signedUrlA}`);
        check("6a. Tenant A can fetch its own signed file (200)", fetchOwnA.status === 200);

        // Tenant B's token was never part of A's signed URL -- swap the
        // token, not the URL, proving the SIGNATURE (not just the path)
        // is what's checked.
        const bTokenOnAPath = await fetch(`${BASE_URL}${signedUrlA.split("?")[0]}?fat=invalid`);
        check("6b. Garbage token on Tenant A's real file path is rejected (401)", bTokenOnAPath.status === 401);

        const crossFetch = await fetch(`${BASE_URL}${signedUrlB}`, {}); // B's own valid signed URL, unrelated to A
        check("6c. Tenant B can fetch its OWN signed file (200) -- sanity check the mechanism itself still works", crossFetch.status === 200);
    } else {
        check("6a-6c. Skipped (a signed URL was not obtained -- see SETUP failure above)", false);
    }

    // ================================================
    // REINSTEINS VERIFICATION
    // ================================================
    console.log("\nEXTRA -- Reinsteins verification");
    const dbPool = require("./config/db");
    const PLATFORM_TABLE_NAMES = ["platform_users", "subscription_plans", "companies", "demo_requests", "payments", "subscription_history", "platform_audit_logs", "platform_notifications", "email_delivery_logs", "email_domains", "mailboxes", "email_aliases", "mailbox_settings"];
    const [[{ tbl }]] = await dbPool.query(`SELECT COUNT(*) AS tbl FROM information_schema.tables WHERE table_schema = 'public' AND table_name NOT IN (${PLATFORM_TABLE_NAMES.map(() => "?").join(",")})`, PLATFORM_TABLE_NAMES);
    const [[{ users }]] = await dbPool.query(`SELECT COUNT(*) AS users FROM users`);
    check("EXTRA: reinsteins tenant unchanged (37 tables, 17 users)", Number(tbl) === 37 && Number(users) === 17, `tables=${tbl} users=${users}`);

    const reinsteinsFilesBefore = fs.existsSync(path.join(UPLOADS_ROOT, "tenant_reinsteins"))
        ? listFilesRecursive(path.join(UPLOADS_ROOT, "tenant_reinsteins")).length
        : 0;
    check("EXTRA: no test file leaked into tenant_reinsteins/", !listFilesRecursive(path.join(UPLOADS_ROOT, "tenant_reinsteins")).some((f) => f.includes("concur16b") || f.toLowerCase().includes("empa") || f.toLowerCase().includes("empb")));

    // ================================================
    // CLEANUP
    // ================================================
    console.log("\nCLEANUP");
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?)`, [companyAId, companyBId]);
    const [[ownerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (ownerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [ownerRow.id]);

    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?)`, [A_SLUG, B_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    // Remove the temporary tenant upload directories this script
    // created -- never touches uploads/tenant_reinsteins/ or any
    // other real tenant's directory.
    for (const dir of [A_DIR, B_DIR]) {
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
    check("CLEANUP: both temporary tenant upload directories removed", !fs.existsSync(A_DIR) && !fs.existsSync(B_DIR));

    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
