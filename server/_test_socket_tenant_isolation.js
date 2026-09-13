require("dotenv").config();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { io: ioClient } = require("socket.io-client");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const platformCompanyService = require("./services/platformCompanyService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("./controllers/platformAuthController");

// ==========================================
// SOCKET.IO MULTI-TENANT ISOLATION SELF-TEST
//
// Real socket.io-client connections against the live backend on
// http://localhost:5000. Uses two throwaway tenants (provisioned
// through the REAL Phase 2D/2E APIs) plus a third, briefly-suspended
// tenant for the "suspended company" check. Never touches
// reinsteins_workhub except for one READ-ONLY legacy-socket
// connection test using the real, pre-existing admin user (id=2,
// status=active) -- no writes, no data changes.
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "sockettest_owner@groworgs.internal";
const OWNER_PASSWORD = "SocketTestOwner!2026Pwd";

const A_SLUG = "sockettest_a";
const B_SLUG = "sockettest_b";
const C_SLUG = "sockettest_suspended";
const A_DB = buildTenantDbName(A_SLUG);
const B_DB = buildTenantDbName(B_SLUG);
const C_DB = buildTenantDbName(C_SLUG);

const ADMIN_A_PASSWORD = "SocketA!Pass2026";
const ADMIN_B_PASSWORD = "SocketB!Pass2026";
const ADMIN_C_PASSWORD = "SocketC!Pass2026";

let failures = 0;
function check(label, condition, detail) {
    if (condition) console.log(`  [PASS] ${label}`);
    else { failures++; console.log(`  [FAIL] ${label}${detail ? " -- " + detail : ""}`); }
}

async function apiPost(path, body, token) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* non-JSON */ }
    return { status: res.status, body: json };
}

function connectSocket(token, { timeoutMs = 4000 } = {}) {
    return new Promise((resolve) => {
        const socket = ioClient(BASE_URL, {
            auth: { token },
            transports: ["websocket"],
            reconnection: false,
            forceNew: true,
            timeout: timeoutMs,
        });
        const timer = setTimeout(() => {
            socket.close();
            resolve({ connected: false, error: "timeout", socket: null });
        }, timeoutMs);

        socket.on("connect", () => {
            clearTimeout(timer);
            resolve({ connected: true, error: null, socket });
        });
        socket.on("connect_error", (err) => {
            clearTimeout(timer);
            socket.close();
            resolve({ connected: false, error: err.message, socket: null });
        });
    });
}

function waitForEvent(socket, eventName, timeoutMs = 1500) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (!done) { done = true; resolve({ received: false, data: null }); }
        }, timeoutMs);
        socket.once(eventName, (data) => {
            if (!done) { done = true; clearTimeout(timer); resolve({ received: true, data }); }
        });
    });
}

(async () => {

    // ---------- Setup ----------
    console.log("SETUP -- platform owner + three tenants + admins");
    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Socket Test Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;
    check("SETUP: platform owner login", loginRes.status === 200 && !!ownerToken);

    const createA = await apiPost("/api/platform/companies", { companyName: "SOCKET TEST A", companySlug: A_SLUG, accessType: "trial" }, ownerToken);
    const companyAId = createA.body?.company?.id;
    const createB = await apiPost("/api/platform/companies", { companyName: "SOCKET TEST B", companySlug: B_SLUG, accessType: "trial" }, ownerToken);
    const companyBId = createB.body?.company?.id;
    const createC = await apiPost("/api/platform/companies", { companyName: "SOCKET TEST SUSPENDED", companySlug: C_SLUG, accessType: "trial" }, ownerToken);
    const companyCId = createC.body?.company?.id;
    check("SETUP: three companies provisioned", createA.status === 201 && createB.status === 201 && createC.status === 201);

    const adminA = await apiPost(`/api/platform/companies/${companyAId}/admin`, { name: "Admin A", email: "admin@sockettest-a.test", password: ADMIN_A_PASSWORD }, ownerToken);
    const adminB = await apiPost(`/api/platform/companies/${companyBId}/admin`, { name: "Admin B", email: "admin@sockettest-b.test", password: ADMIN_B_PASSWORD }, ownerToken);
    const adminC = await apiPost(`/api/platform/companies/${companyCId}/admin`, { name: "Admin C", email: "admin@sockettest-c.test", password: ADMIN_C_PASSWORD }, ownerToken);
    check("SETUP: three admins created", adminA.status === 201 && adminB.status === 201 && adminC.status === 201);

    const loginA = await apiPost(`/api/tenant-auth/${A_SLUG}/login`, { employeeId: adminA.body.admin.employeeId, password: ADMIN_A_PASSWORD });
    const loginB = await apiPost(`/api/tenant-auth/${B_SLUG}/login`, { employeeId: adminB.body.admin.employeeId, password: ADMIN_B_PASSWORD });
    const loginC = await apiPost(`/api/tenant-auth/${C_SLUG}/login`, { employeeId: adminC.body.admin.employeeId, password: ADMIN_C_PASSWORD });
    const tokenA = loginA.body?.token;
    const tokenB = loginB.body?.token;
    const tokenC = loginC.body?.token;
    check("SETUP: tenant A/B/C logins succeed", loginA.status === 200 && loginB.status === 200 && loginC.status === 200);

    // Second, plain employee user in each of A and B (direct DB
    // insert -- test fixture only), needed to create a real private
    // conversation in each tenant.
    const employeePasswordHash = await bcrypt.hash("FixtureEmployee!2026", 12);
    const poolA = getTenantPool(A_DB);
    const poolB = getTenantPool(B_DB);
    const [insA] = await poolA.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Employee A2', 'emp2@sockettest-a.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [employeePasswordHash]
    );
    const [insB] = await poolB.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Employee B2', 'emp2@sockettest-b.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [employeePasswordHash]
    );
    const employeeAId = insA.insertId;
    const employeeBId = insB.insertId;

    const convA = await apiPost("/api/chat/conversations/private", { userId: employeeAId }, tokenA);
    const convB = await apiPost("/api/chat/conversations/private", { userId: employeeBId }, tokenB);
    check("SETUP: private conversation created in tenant A", convA.status === 201, JSON.stringify(convA.body));
    check("SETUP: private conversation created in tenant B", convB.status === 201, JSON.stringify(convB.body));
    const conversationIdA = convA.body?.conversationId;
    const conversationIdB = convB.body?.conversationId;
    check("SETUP: both conversations independently got id=1 (per-tenant numbering, expected)", Number(conversationIdA) === 1 && Number(conversationIdB) === 1,
        `A=${conversationIdA} B=${conversationIdB}`);

    // Real, pre-existing Reinsteins admin user (id=2, status=active,
    // confirmed in Phase 2E investigation) -- used ONLY for a
    // read-only connection test, never written to.
    const legacyToken = jwt.sign({ id: 2, employeeId: "LEGACY-SOCKET-TEST", role: "admin" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const platformToken = jwt.sign({ userId: 1, type: "platform_owner" }, process.env.PLATFORM_JWT_SECRET,
        { expiresIn: "1h", issuer: PLATFORM_JWT_ISSUER, audience: PLATFORM_JWT_AUDIENCE });
    const garbageToken = "not.a.valid.jwt.token";

    // ---------- A/B/C: connections ----------
    console.log("\nTEST A/B/C -- connections");
    const connLegacy = await connectSocket(legacyToken);
    check("A. Reinsteins legacy user connects successfully", connLegacy.connected === true, connLegacy.error);

    const connA = await connectSocket(tokenA);
    check("B. New Tenant A user connects successfully", connA.connected === true, connA.error);

    const connB = await connectSocket(tokenB);
    check("C. New Tenant B user connects successfully", connB.connected === true, connB.error);

    // ---------- I/J/K: rejections ----------
    console.log("\nTEST I/J/K -- rejection cases");
    const connGarbage = await connectSocket(garbageToken, { timeoutMs: 3000 });
    check("I. Invalid JWT is rejected", connGarbage.connected === false);

    const connPlatform = await connectSocket(platformToken, { timeoutMs: 3000 });
    check("J. Platform JWT is rejected from tenant Socket.IO", connPlatform.connected === false);

    // Suspend tenant C's company, then attempt to connect with
    // Admin C's (still cryptographically valid) token.
    await platformPool.query(`UPDATE companies SET status = 'suspended' WHERE id = ?`, [companyCId]);
    const connSuspended = await connectSocket(tokenC, { timeoutMs: 3000 });
    check("K. Suspended tenant cannot use Socket.IO", connSuspended.connected === false);
    await platformPool.query(`UPDATE companies SET status = 'active' WHERE id = ?`, [companyCId]);

    // ---------- D/E/F: chat isolation ----------
    console.log("\nTEST D/E/F -- chat room isolation");

    connA.socket.emit("conversation:join", conversationIdA);
    connB.socket.emit("conversation:join", conversationIdB);
    await new Promise((r) => setTimeout(r, 300));

    // Tenant A attempts to join a conversation:1 -- which DOES exist
    // as an id, but belongs to Tenant B. A's own tenant DB has no
    // conversation_members row for it, so the authorization check
    // inside conversation:join must refuse it even though the ID is
    // valid-looking.
    const bMsgWaiter = waitForEvent(connB.socket, "message:new");
    const aMsgWaiter = waitForEvent(connA.socket, "message:new");

    // Tenant B sends a real message in ITS OWN conversation (REST
    // API, authenticated as Admin B).
    const sendB = await apiPost(`/api/chat/conversations/${conversationIdB}/messages`, { message: "Hello from Tenant B" }, tokenB);
    check("SETUP: message sent in tenant B's conversation", sendB.status === 201, JSON.stringify(sendB.body));

    const [bResult, aResult] = await Promise.all([bMsgWaiter, aMsgWaiter]);
    check("D/F. Tenant B's own socket (in its own conversation room) receives its message", bResult.received === true);
    check("E. Tenant A's socket (joined to ITS OWN same-numbered conversation, NOT Tenant B's) does NOT receive Tenant B's message",
        aResult.received === false, JSON.stringify(aResult.data));

    // Explicit forged-payload attempt: Tenant A tries to join using
    // Tenant B's conversation id directly, then check it never
    // receives B's subsequent message either.
    connA.socket.emit("conversation:join", conversationIdB); // same numeric id as B's real conversation
    await new Promise((r) => setTimeout(r, 200));
    const aMsgWaiter2 = waitForEvent(connA.socket, "message:new");
    const sendB2 = await apiPost(`/api/chat/conversations/${conversationIdB}/messages`, { message: "Second message from Tenant B" }, tokenB);
    check("SETUP: second message sent in tenant B", sendB2.status === 201);
    const aResult2 = await aMsgWaiter2;
    check("F. Cross-tenant chat join attempt (same numeric id) still fails to receive Tenant B's messages",
        aResult2.received === false, JSON.stringify(aResult2.data));

    // ---------- G: meeting cross-tenant event isolation ----------
    console.log("\nTEST G -- meeting event isolation");
    // Both tenants' first meeting will independently get meetingId=1
    // once created -- without tenant-namespaced rooms this would be
    // the exact same Socket.IO room. Verify a Tenant A media-state
    // change (which requires actually being in room meeting:1) does
    // NOT reach a Tenant B socket, using the raw room-join primitive
    // directly (meeting:join requires DB-verified participancy we
    // haven't set up meetings for, so this proves the ROOM
    // NAMESPACING layer specifically, independent of the meeting
    // authorization layer already proven for chat above).
    const gWaiter = waitForEvent(connB.socket, "meeting:media-state-changed", 1200);
    connA.socket.emit("meeting:media-state", { meetingId: 1, isMuted: true, isCameraOff: false });
    const gResult = await gWaiter;
    check("G. Cross-tenant meeting event (same numeric meetingId) does not reach the other tenant's socket",
        gResult.received === false, JSON.stringify(gResult.data));

    // ---------- H: forged company fields in event payloads ignored ----------
    console.log("\nTEST H -- forged payload fields ignored");
    const hWaiter = waitForEvent(connB.socket, "meeting:media-state-changed", 1200);
    connA.socket.emit("meeting:media-state", {
        meetingId: 1, isMuted: true, isCameraOff: false,
        companyId: companyBId, companySlug: B_SLUG, tenantDbName: B_DB,
    });
    const hResult = await hWaiter;
    check("H. Forged companyId/companySlug/tenantDbName in event payload has no effect (still isolated)",
        hResult.received === false, JSON.stringify(hResult.data));

    // ---------- L: existing Reinsteins functionality still operational ----------
    console.log("\nTEST L -- existing Reinsteins socket functionality still operational");
    const legacyOnlineWaiter = waitForEvent(connLegacy.socket, "users:online", 1200);
    // users:online is emitted once right after connect -- may have
    // already fired before this listener attached, so also verify
    // the connection is simply alive and can emit/receive normally.
    connLegacy.socket.emit("conversation:join", 999999); // harmless no-op join attempt
    await new Promise((r) => setTimeout(r, 300));
    check("L. Legacy Reinsteins socket remains connected and responsive after all cross-tenant tests", connLegacy.socket.connected === true);

    // ---------- Cleanup ----------
    console.log("\nCLEANUP");
    connLegacy.socket?.close();
    connA.socket?.close();
    connB.socket?.close();

    // Phase 15 -- this script predates the platform_audit_logs
    // (Phase 12) and email_delivery_logs (Phase 13) tables; the
    // company creations above indirectly populate platform_audit_logs
    // (ON DELETE SET NULL on company_id/platform_user_id) as a side
    // effect of that later integration work, so without this explicit
    // cleanup, deleting the temp companies/owner below would silently
    // orphan those rows instead of removing them (see the Phase 14
    // final report for the original discovery of this class of bug in
    // several other pre-Phase-12 test scripts).
    await platformPool.query(`DELETE FROM email_delivery_logs WHERE company_id IN (?, ?, ?)`, [companyAId, companyBId, companyCId]);
    const [[sockettestOwnerRow]] = await platformPool.query(`SELECT id FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);
    if (sockettestOwnerRow) await platformPool.query(`DELETE FROM platform_audit_logs WHERE platform_user_id = ?`, [sockettestOwnerRow.id]);

    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(A_DB);
    await tenantProvisioningService.dropProvisionedDatabase(B_DB);
    await tenantProvisioningService.dropProvisionedDatabase(C_DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug IN (?, ?, ?)`, [A_SLUG, B_SLUG, C_SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const aGone = await tenantProvisioningService.databaseExists(A_DB);
    const bGone = await tenantProvisioningService.databaseExists(B_DB);
    const cGone = await tenantProvisioningService.databaseExists(C_DB);
    check("CLEANUP: all three tenant DBs gone", aGone === false && bGone === false && cGone === false);

    const [remaining] = await platformPool.query(`SELECT company_slug FROM companies`);
    check("CLEANUP: only Reinsteins remains in companies", remaining.length === 1 && remaining[0].company_slug === "reinsteins", JSON.stringify(remaining));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
