require("dotenv").config();
const bcrypt = require("bcrypt");
const { io: ioClient } = require("socket.io-client");

const platformPool = require("./config/platformDb");
const platformUserService = require("./services/platformUserService");
const tenantProvisioningService = require("./services/tenantProvisioningService");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { buildTenantDbName } = require("./utils/tenantDbName");
const { UPLOADS_ROOT } = require("./utils/tenantUploadPath");
const fs = require("fs");
const path = require("path");

// ==========================================
// CHAT FILE UPLOAD + SOCKET EMIT SIGNING SELF-TEST
//
// Focused check that the explicit signing added at chatController.js's
// uploadChatImage socket-emit call site actually produces a signed
// URL over a REAL live socket connection (the one thing not covered
// by the broader file-isolation suite, which only checks REST
// responses).
// ==========================================

const BASE_URL = "http://localhost:5000";
const OWNER_EMAIL = "chatfiletest_owner@groworgs.internal";
const OWNER_PASSWORD = "ChatFileTestOwner!2026";
const SLUG = "chatfiletest_a";
const DB = buildTenantDbName(SLUG);

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

const TINY_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=";

(async () => {

    const passwordHash = await bcrypt.hash(OWNER_PASSWORD, 12);
    await platformUserService.create({ name: "Chat File Owner", email: OWNER_EMAIL, passwordHash, role: "platform_owner" });
    const loginRes = await apiPost("/api/platform/auth/login", { email: OWNER_EMAIL, password: OWNER_PASSWORD });
    const ownerToken = loginRes.body?.token;

    const create = await apiPost("/api/platform/companies", { companyName: "CHAT FILE TEST", companySlug: SLUG, accessType: "trial" }, ownerToken);
    const companyId = create.body?.company?.id;
    check("SETUP: company provisioned", create.status === 201);

    const empPasswordHash = await bcrypt.hash("ChatFileEmp!2026", 12);
    const tenantPool = getTenantPool(DB);
    const [insA] = await tenantPool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP001', 'Chat Emp A', 'a@chatfiletest.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [empPasswordHash]
    );
    const [insB] = await tenantPool.query(
        `INSERT INTO users (employee_id, full_name, email, password, role, system_access, status) VALUES ('EMP002', 'Chat Emp B', 'b@chatfiletest.test', ?, 'employee', 'employee', 'active') RETURNING id`,
        [empPasswordHash]
    );
    const userAId = insA.insertId;
    const userBId = insB.insertId;

    const loginA = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: "EMP001", password: "ChatFileEmp!2026" });
    const loginB = await apiPost(`/api/tenant-auth/${SLUG}/login`, { employeeId: "EMP002", password: "ChatFileEmp!2026" });
    const tokenA = loginA.body?.token;
    const tokenB = loginB.body?.token;
    check("SETUP: both employees logged in", loginA.status === 200 && loginB.status === 200);

    const conv = await apiPost("/api/chat/conversations/private", { userId: userBId }, tokenA);
    const conversationId = conv.body?.conversationId;
    check("SETUP: private conversation created", conv.status === 201 && !!conversationId);

    // Connect B's socket and join the conversation room BEFORE A uploads,
    // so B receives the real-time "message:new" event.
    const socketB = ioClient(BASE_URL, { auth: { token: tokenB }, transports: ["websocket"], forceNew: true });
    await new Promise((resolve) => socketB.on("connect", resolve));
    socketB.emit("conversation:join", conversationId);
    await new Promise((r) => setTimeout(r, 300));

    const messagePromise = new Promise((resolve) => {
        socketB.once("message:new", (msg) => resolve(msg));
        setTimeout(() => resolve(null), 4000);
    });

    // Upload the chat image as A (REST, multipart).
    const buf = Buffer.from(TINY_JPEG_BASE64, "base64");
    const form = new FormData();
    form.append("image", new Blob([buf], { type: "image/jpeg" }), "chat-test.jpg");
    const uploadRes = await fetch(`${BASE_URL}/api/chat/conversations/${conversationId}/upload-image`, {
        method: "POST",
        headers: { Authorization: `Bearer ${tokenA}` },
        body: form,
    });
    const uploadBody = await uploadRes.json();
    check("Upload succeeded (REST response)", uploadRes.status === 201, JSON.stringify(uploadBody));

    const restImageUrl = uploadBody?.message?.image;
    check("REST response image URL is signed", typeof restImageUrl === "string" && restImageUrl.includes("fat="), restImageUrl);
    check("REST response image URL is tenant-namespaced", restImageUrl?.includes(`tenant_${SLUG}`));

    const socketMessage = await messagePromise;
    check("B received the real-time message:new event", !!socketMessage, "timed out waiting for socket event");
    check("Socket-delivered image URL is ALSO signed (the explicit emit-signing path)",
        typeof socketMessage?.image === "string" && socketMessage.image.includes("fat="), socketMessage?.image);

    if (restImageUrl) {
        const fetchViaRest = await fetch(`${BASE_URL}${restImageUrl}`);
        check("Signed URL from REST response actually serves the image", fetchViaRest.status === 200 && (fetchViaRest.headers.get("content-type") || "").startsWith("image/"));
    }
    if (socketMessage?.image) {
        const fetchViaSocket = await fetch(`${BASE_URL}${socketMessage.image}`);
        check("Signed URL from socket event actually serves the image", fetchViaSocket.status === 200 && (fetchViaSocket.headers.get("content-type") || "").startsWith("image/"));
    }

    socketB.close();

    // Cleanup
    console.log("\nCLEANUP");
    await closeAllTenantPools();
    await tenantProvisioningService.dropProvisionedDatabase(DB);
    await platformPool.query(`DELETE FROM companies WHERE company_slug = ?`, [SLUG]);
    await platformPool.query(`DELETE FROM platform_users WHERE email = ?`, [OWNER_EMAIL]);

    const uploadsDir = path.join(UPLOADS_ROOT, `tenant_${SLUG}`);
    if (fs.existsSync(uploadsDir)) fs.rmSync(uploadsDir, { recursive: true, force: true });

    const dbGone = await tenantProvisioningService.databaseExists(DB);
    check("CLEANUP: tenant DB gone", dbGone === false);
    check("CLEANUP: upload directory gone", !fs.existsSync(uploadsDir));

    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    await platformPool.end();
    process.exit(failures === 0 ? 0 : 1);

})().catch(async (err) => {
    console.error("TEST SCRIPT ERROR:", err);
    process.exit(1);
});
