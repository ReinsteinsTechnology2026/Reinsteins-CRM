// ==========================================
// TENANT USER SERVICE (Phase 2E)
//
// Pure DB logic against a tenant database's `users` table. Every
// function here takes an already-resolved tenant pool (from
// config/tenantConnectionManager.js) as its first argument rather
// than importing a fixed pool -- this file has no opinion about
// which tenant it's talking to, and never imports config/db.js
// (the existing Reinsteins-only pool) or config/platformDb.js.
//
// Schema/conventions below were read directly from the live tenant
// schema (schemas/tenantSchema.sql) and from the existing, currently
// real admin row in reinsteins_workhub -- not guessed:
//   - role='admin' + system_access='super_admin' is what an actual
//     full-access admin account has today (confirmed by querying the
//     live Reinsteins admin row).
//   - employee_id and email both carry real UNIQUE constraints.
//   - login (authController.js) authenticates by employee_id, not
//     email -- so the identifier this service generates is what the
//     new admin will actually need to log in with.
//   - password hashing is bcrypt, cost 12, stored in the `password`
//     column -- matching every existing tenant user creation path.
// ==========================================

// Platform-provisioned admins get a tenant-agnostic "ADM" prefix --
// deliberately NOT the existing "RS"/"INT" prefixes used by
// employeeController.js, since those are Reinsteins' own employee/
// intern numbering conventions and would be meaningless (or
// misleading) for a different company's tenant database. The
// generation algorithm itself (highest-existing-number + 1, so gaps
// are never reused) mirrors employeeController.js's
// generateNextIdentifier exactly, just parameterized to run against
// whichever tenant pool is passed in instead of the fixed pool.
const ADMIN_ID_PREFIX = "ADM";
const MAX_ID_ATTEMPTS = 5;

async function generateNextAdminIdentifier(tenantPool) {
    const [rows] = await tenantPool.query(
        `SELECT employee_id FROM users
         WHERE employee_id REGEXP ?
         ORDER BY CAST(SUBSTRING(employee_id, ?) AS UNSIGNED) DESC
         LIMIT 1`,
        [`^${ADMIN_ID_PREFIX}[0-9]+$`, ADMIN_ID_PREFIX.length + 1]
    );

    const highestNumber = rows.length > 0
        ? parseInt(rows[0].employee_id.slice(ADMIN_ID_PREFIX.length), 10)
        : 0;

    return `${ADMIN_ID_PREFIX}${String(highestNumber + 1).padStart(3, "0")}`;
}

async function getUserByEmail(tenantPool, email) {
    const [rows] = await tenantPool.query(
        `SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1`,
        [email.toLowerCase()]
    );
    return rows[0] || null;
}

async function countAdmins(tenantPool) {
    const [[{ c }]] = await tenantPool.query(
        `SELECT COUNT(*) AS c FROM users WHERE role = 'admin'`
    );
    return c;
}

// The company's own admin's display name/email ONLY -- deliberately
// the exact same two fields already visible to the Platform Owner via
// the createFirstAdmin response, never a broader profile. No
// password/password_hash column is ever selected here.
async function getFirstAdmin(tenantPool) {
    const [rows] = await tenantPool.query(
        `SELECT full_name, email FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`
    );
    return rows[0] || null;
}

// Single COUNT, not a row list -- how many accounts (any role) were
// created on/after the given date. Used for "New Users This Month" on
// the dashboard; only ever a number, same boundary as countAdmins.
async function countUsersSince(tenantPool, sinceDate) {
    const [[{ c }]] = await tenantPool.query(
        `SELECT COUNT(*) AS c FROM users WHERE created_at >= ?`,
        [sinceDate]
    );
    return c;
}

// Aggregate headcount only -- a single COUNT/GROUP BY, never a row
// list. Used by the Platform Owner Dashboard/Companies page to show
// "how many people" without ever returning names, emails, or any
// other per-user detail across the platform-layer boundary.
async function countUsersByRole(tenantPool) {
    const [rows] = await tenantPool.query(
        `SELECT role, COUNT(*) AS c FROM users GROUP BY role`
    );
    let total = 0;
    let admins = 0;
    for (const row of rows) {
        const count = Number(row.c);
        total += count;
        if (row.role === "admin") admins += count;
    }
    return { total, admins, employees: total - admins };
}

// Creates the tenant's first Administrator. passwordHash must
// already be hashed (bcrypt) by the caller -- this service never
// hashes/compares passwords itself, matching the existing convention
// (authController.js/employeeController.js own bcrypt calls
// directly rather than a service layer doing it silently).
//
// role='admin' and system_access='super_admin' are hardcoded, not
// client-controlled -- matching the real values already used by
// every actual admin account in this system.
async function createFirstAdmin(tenantPool, { name, email, phone, passwordHash }) {

    const cleanedEmail = email.trim().toLowerCase();

    const existing = await getUserByEmail(tenantPool, cleanedEmail);
    if (existing) {
        const error = new Error("A user with this email already exists in this tenant.");
        error.code = "TENANT_EMAIL_TAKEN";
        throw error;
    }

    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {

        const employeeId = await generateNextAdminIdentifier(tenantPool);

        try {

            const [result] = await tenantPool.query(
                `INSERT INTO users
                    (employee_id, full_name, email, phone, password, role, system_access, status)
                 VALUES (?, ?, ?, ?, ?, 'admin', 'super_admin', 'active')`,
                [employeeId, name.trim(), cleanedEmail, phone || null, passwordHash]
            );

            return {
                id: result.insertId,
                employeeId,
                fullName: name.trim(),
                email: cleanedEmail,
                phone: phone || null,
                role: "admin",
                systemAccess: "super_admin",
                status: "active",
            };

        } catch (insertError) {

            const isDuplicateEmployeeId =
                insertError.code === "ER_DUP_ENTRY" &&
                insertError.message?.includes("employee_id");

            if (isDuplicateEmployeeId) {
                continue; // retry with a freshly generated ID
            }

            if (insertError.code === "ER_DUP_ENTRY" && insertError.message?.includes("email")) {
                const error = new Error("A user with this email already exists in this tenant.");
                error.code = "TENANT_EMAIL_TAKEN";
                throw error;
            }

            throw insertError;

        }

    }

    throw new Error("Could not generate a unique employee ID after several attempts.");

}

module.exports = {
    getUserByEmail,
    countAdmins,
    countUsersByRole,
    getFirstAdmin,
    countUsersSince,
    createFirstAdmin,
};
