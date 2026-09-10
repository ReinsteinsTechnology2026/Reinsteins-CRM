const platformPool = require("../config/platformDb");

// ==========================================
// PLATFORM USER SERVICE (Phase 2B)
//
// Pure DB logic against groworgs_platform_db.platform_users
// ONLY -- this file never touches the tenant `users` table
// and never imports config/db.js. Mirrors the existing
// service/controller layering convention already used
// throughout server/services/*.js.
// ==========================================

const getByEmail = async (email) => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email, password_hash, role, status, created_at, updated_at
         FROM platform_users
         WHERE email = ?
         LIMIT 1`,
        [email]
    );
    return rows[0] || null;
};

const getActiveById = async (id) => {
    const [rows] = await platformPool.query(
        `SELECT id, name, email, role, status
         FROM platform_users
         WHERE id = ? AND status = 'active'
         LIMIT 1`,
        [id]
    );
    return rows[0] || null;
};

// passwordHash must already be hashed (bcrypt) by the caller --
// this service never hashes/compares passwords itself, matching
// the existing convention where authController.js owns bcrypt
// calls directly rather than a service layer doing it silently.

const create = async ({ name, email, passwordHash, role = "platform_owner" }) => {

    const existing = await getByEmail(email);

    if (existing) {
        const error = new Error("A platform user with this email already exists.");
        error.code = "PLATFORM_USER_EMAIL_TAKEN";
        throw error;
    }

    const [result] = await platformPool.query(
        `INSERT INTO platform_users (name, email, password_hash, role, status)
         VALUES (?, ?, ?, ?, 'active')`,
        [name, email, passwordHash, role]
    );

    return { id: result.insertId, name, email, role, status: "active" };

};

module.exports = {
    getByEmail,
    getActiveById,
    create,
};
