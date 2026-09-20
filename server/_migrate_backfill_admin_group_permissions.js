// Explicit, cwd-independent path -- matching app.js's own established
// fix for this exact problem (see its comment): dotenv's no-argument
// default resolves ".env" relative to process.cwd(), which is only
// "server/" when something has `cd`'d into this directory first. This
// script is invoked as `node server/_migrate_....js` from the repo
// root (both in CI/deployment and by a developer locally), where no
// .env file exists -- every OTHER _migrate_*.js/_setup_*.js/_test_*.js
// script in this codebase still has this latent cwd-dependent bug
// (confirmed: app.js is the only file that was ever fixed for it), but
// fixing this one script is what THIS migration actually needs to run
// safely and unattended in the deploy pipeline; touching the others is
// out of scope here.
require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const platformPool = require("./config/platformDb");
const { getTenantPool, closeAllTenantPools } = require("./config/tenantConnectionManager");
const { PERMISSION_KEYS } = require("./services/projectPermissionService");

// ==========================================
// BACKFILL MISSING PERMISSION KEYS ON THE DEFAULT
// "PROJECT ADMINISTRATORS" GROUP
//
// projectService.js's ensureDefaultProjectAdministratorsGroupId()
// only ever inserted project_permissions rows for a tenant's default
// "Project Administrators" group (project_id IS NULL, is_default =
// TRUE) at the moment that group was FIRST created. EPIC_CREATE and
// FEATURE_CREATE were added to PERMISSION_KEYS after Epics/Features
// shipped -- any tenant whose default group already existed before
// that never received rows for those two keys, so EPIC_CREATE/
// FEATURE_CREATE silently resolve to "not_set" -> deny for every
// member of that group, on every project, regardless of work-item
// count. (Live symptom: the "Add New Work Item" menu correctly hides
// Add Epic/Add Feature for such a member, since it only ever reflects
// the server-computed EPIC_CREATE/FEATURE_CREATE permissions --
// nothing in the menu itself was ever hiding them based on whether
// any Epic/Feature currently exists.)
//
// This is the one-off companion for tenants whose group already
// existed before this fix -- same pattern as
// _migrate_add_shift_schedules.js / _migrate_add_techops_recycle_bin.js.
// ensureDefaultProjectAdministratorsGroupId() itself was also fixed to
// perform this same backfill going forward (on the group's next
// touch, i.e. the tenant's next project creation), so this script is
// only needed to fix a currently-existing, already-broken project
// without waiting for that.
//
// Idempotent and safe to run more than once: only ever INSERTs a row
// for a (group, permission_key) pair that has NO row at all yet, and
// only ever with 'allow' -- matching this group's own documented "full
// access to every project" purpose. Never touches, downgrades, or
// deletes any existing row, and never touches any OTHER (non-default)
// security group a tenant may have deliberately configured more
// narrowly.
// ==========================================

async function backfillTenant(companySlug, tenantDbName) {
    const tenantPool = getTenantPool(tenantDbName);

    const [[group]] = await tenantPool.query(
        `SELECT id FROM project_security_groups WHERE project_id IS NULL AND name = 'Project Administrators' AND is_default = TRUE LIMIT 1`
    );

    if (!group) {
        console.log(`  [skip] ${companySlug} (${tenantDbName}) -- no default Project Administrators group yet (created on first project, already correct)`);
        return;
    }

    const [existingRows] = await tenantPool.query(
        `SELECT permission_key FROM project_permissions WHERE security_group_id = ? AND project_id IS NULL`,
        [group.id]
    );
    const existingKeys = new Set(existingRows.map((row) => row.permission_key));

    const missingKeys = PERMISSION_KEYS.filter((key) => !existingKeys.has(key));

    if (missingKeys.length === 0) {
        console.log(`  [skip] ${companySlug} (${tenantDbName}) -- already has every permission key`);
        return;
    }

    console.log(`  [migrate] ${companySlug} (${tenantDbName}) -- backfilling: ${missingKeys.join(", ")}`);

    for (const permissionKey of missingKeys) {
        await tenantPool.query(
            `
            INSERT INTO project_permissions (security_group_id, project_id, permission_key, value)
            VALUES (?, NULL, ?, 'allow')
            `,
            [group.id, permissionKey]
        );
    }

    console.log(`  [done] ${companySlug} (${tenantDbName})`);
}

(async () => {
    console.log("Backfill default admin group permissions -- enumerating provisioned tenant databases...\n");

    const [companies] = await platformPool.query(
        `SELECT company_slug, tenant_db_name FROM companies WHERE tenant_db_name IS NOT NULL AND tenant_db_name <> ''`
    );

    if (companies.length === 0) {
        console.log("No provisioned tenant databases found.");
    }

    let failures = 0;

    for (const company of companies) {
        try {
            await backfillTenant(company.company_slug, company.tenant_db_name);
        } catch (error) {
            failures++;
            console.error(`  [FAILED] ${company.company_slug} (${company.tenant_db_name}):`, error.message);
        }
    }

    await closeAllTenantPools();
    await platformPool.end();

    console.log(`\n${failures === 0 ? "All tenants migrated successfully." : `${failures} tenant(s) failed -- see errors above.`}`);
    process.exit(failures === 0 ? 0 : 1);
})().catch(async (error) => {
    console.error("MIGRATION SCRIPT ERROR:", error);
    process.exit(1);
});
