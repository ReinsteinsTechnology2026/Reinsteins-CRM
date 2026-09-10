const platformPool = require("../config/platformDb");

// ==========================================
// DEMO REQUEST SERVICE (Phase 6)
//
// Pure DB logic against groworgs_platform_db.demo_requests ONLY --
// never touches `companies`, `platform_users`, or any tenant
// database. This is the entire data-access surface for the public
// "Request a Demo" form: one INSERT, nothing else needed this phase.
// ==========================================

const createDemoRequest = async ({ name, companyName, email, phone, employeeCount, message }) => {
    const [result] = await platformPool.query(
        `INSERT INTO demo_requests
            (name, company_name, email, phone, employee_count, message, status)
         VALUES (?, ?, ?, ?, ?, ?, 'new')
         RETURNING id`,
        [name, companyName, email, phone || null, employeeCount || null, message || null]
    );

    return { id: result[0].id };
};

// ==========================================
// PLATFORM OWNER DEMO REQUEST MANAGEMENT (Phase 7)
//
// Everything below is read/write against demo_requests ONLY -- same
// isolation as createDemoRequest above, just now consumed by the
// Platform Dashboard instead of the public form. Nothing here
// touches `companies`, `platform_users`, or any tenant database, so
// there is still no path from a demo request to actually creating a
// company -- that remains a separate, deliberate Platform Owner
// action (POST /api/platform/companies), untouched by this phase.
// ==========================================

// List columns intentionally omit `message` -- the management table
// (Part 4) doesn't need it, and getDemoRequestById below is the
// dedicated single-record lookup that includes it. Not a security
// boundary (nothing in this table is sensitive beyond ordinary lead
// contact info); just the right payload for what each view needs.
const LIST_COLUMNS = `
    id, name, company_name, email, phone, employee_count, status, created_at
`;

const DETAIL_COLUMNS = `${LIST_COLUMNS}, message`;

const listDemoRequests = async () => {
    // Phase 8 fix: `created_at` is a TIMESTAMP column (second-level
    // granularity) -- two submissions in the same second previously
    // had no deterministic order, so "newest first" wasn't actually
    // guaranteed. `id DESC` as a secondary key breaks ties by
    // insertion order, since id is an auto-increment primary key.
    const [rows] = await platformPool.query(
        `SELECT ${LIST_COLUMNS} FROM demo_requests ORDER BY created_at DESC, id DESC`
    );
    return rows;
};

const getDemoRequestById = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT ${DETAIL_COLUMNS} FROM demo_requests WHERE id = ? LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

// Guarded to update ONLY the `status` column -- there is no code
// path here (or in the controller that calls this) that accepts any
// other field name from a caller, so "arbitrary fields cannot be
// updated" holds by construction, not just by validation.
const updateDemoRequestStatus = async (id, status) => {
    const [result] = await platformPool.query(
        `UPDATE demo_requests SET status = ? WHERE id = ?`,
        [status, id]
    );
    if (result.affectedRows === 0) {
        return null;
    }
    return await getDemoRequestById(id);
};

module.exports = {
    createDemoRequest,
    listDemoRequests,
    getDemoRequestById,
    updateDemoRequestStatus,
};
