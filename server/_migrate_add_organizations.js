const pool = require("./config/db");

// ==========================================
// MIGRATION: ADD ORGANIZATIONS (Phase 1)
//
// Adds the organization layer described in the
// approved "TechOps -> Organizations -> Projects"
// architecture:
//   - organizations (the entity itself)
//   - organization_members (the authoritative
//     membership table -- NOT users.organization_id)
//   - organization_id added directly to users,
//     departments, designations, projects (the
//     approved hybrid-scoping "direct" tier).
//     Project-owned entities (epics/features/tasks/
//     etc.) are NOT touched -- they inherit
//     organization scope through their existing
//     project_id, per the approved plan.
//
// Idempotent: safe to run more than once.
// ==========================================

async function columnExists(table, column) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
    return rows.length > 0;
}

async function tableExists(table) {
    const [rows] = await pool.query(`SHOW TABLES LIKE ?`, [table]);
    return rows.length > 0;
}

(async () => {

    // ==========================================
    // 1. organizations
    // ==========================================

    if (!(await tableExists("organizations"))) {

        await pool.query(`
            CREATE TABLE organizations (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                description TEXT NULL,
                status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
                created_by INT UNSIGNED NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_organizations_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
            )
        `);

        console.log("Created table: organizations");

    } else {
        console.log("organizations already exists — skipped.");
    }

    // ==========================================
    // 2. organization_members
    // One organization per person is enforced at the
    // DB level (UNIQUE on user_id alone, not just the
    // pair) -- this is what makes cross-organization
    // membership impossible to create by construction,
    // not merely rejected in application code.
    // ==========================================

    if (!(await tableExists("organization_members"))) {

        await pool.query(`
            CREATE TABLE organization_members (
                id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                organization_id INT UNSIGNED NOT NULL,
                user_id INT UNSIGNED NOT NULL,
                added_by INT UNSIGNED NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT fk_om_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
                CONSTRAINT fk_om_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_om_added_by FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
                CONSTRAINT uq_om_user UNIQUE (user_id)
            )
        `);

        console.log("Created table: organization_members");

    } else {
        console.log("organization_members already exists — skipped.");
    }

    // ==========================================
    // 3. organization_id columns (direct-scoping tier)
    // ==========================================

    const directTables = ["users", "departments", "designations", "projects"];

    for (const table of directTables) {

        if (!(await columnExists(table, "organization_id"))) {

            await pool.query(`
                ALTER TABLE \`${table}\`
                ADD COLUMN organization_id INT UNSIGNED NULL,
                ADD CONSTRAINT fk_${table}_organization FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL
            `);

            console.log(`Added ${table}.organization_id`);

        } else {
            console.log(`${table}.organization_id already exists — skipped.`);
        }

    }

    // ==========================================
    // 4. SEED: "Reinsteins Technology" as the first
    // organization. Every currently-active employee
    // becomes a member; every existing department,
    // designation, and project belongs to it.
    // Inactive/resigned/terminated employees are
    // deliberately NOT made members -- they are not
    // currently part of the organization's workforce.
    // ==========================================

    const [[existingSeed]] = await pool.query(
        `SELECT id FROM organizations WHERE name = 'Reinsteins Technology' LIMIT 1`
    );

    let orgId;

    if (existingSeed) {

        orgId = existingSeed.id;
        console.log(`Seed organization already exists (id=${orgId}) — reusing it.`);

    } else {

        const [result] = await pool.query(
            `INSERT INTO organizations (name, description, status, created_by) VALUES (?, ?, 'active', NULL)`,
            ["Reinsteins Technology", "The founding organization, seeded from pre-existing single-tenant data."]
        );

        orgId = result.insertId;
        console.log(`Created seed organization "Reinsteins Technology" (id=${orgId})`);

    }

    const [deptResult] = await pool.query(
        `UPDATE departments SET organization_id = ? WHERE organization_id IS NULL`,
        [orgId]
    );
    console.log(`departments backfilled: ${deptResult.affectedRows}`);

    const [desigResult] = await pool.query(
        `UPDATE designations SET organization_id = ? WHERE organization_id IS NULL`,
        [orgId]
    );
    console.log(`designations backfilled: ${desigResult.affectedRows}`);

    const [projResult] = await pool.query(
        `UPDATE projects SET organization_id = ? WHERE organization_id IS NULL`,
        [orgId]
    );
    console.log(`projects backfilled: ${projResult.affectedRows}`);

    const [userResult] = await pool.query(
        `UPDATE users SET organization_id = ? WHERE employment_status = 'active' AND organization_id IS NULL`,
        [orgId]
    );
    console.log(`users (active) backfilled: ${userResult.affectedRows}`);

    const [memberResult] = await pool.query(
        `
        INSERT INTO organization_members (organization_id, user_id, added_by)
        SELECT ?, u.id, NULL
        FROM users u
        WHERE u.employment_status = 'active'
        AND NOT EXISTS (
            SELECT 1 FROM organization_members om WHERE om.user_id = u.id
        )
        `,
        [orgId]
    );
    console.log(`organization_members seeded: ${memberResult.affectedRows}`);

    console.log("\nMigration complete.");

    process.exit(0);

})().catch((e) => { console.error(e); process.exit(1); });
