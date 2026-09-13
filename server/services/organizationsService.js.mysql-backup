const pool = require("../config/db");

// ==========================================
// ORGANIZATIONS SERVICE (Phase 2A)
//
// CRUD for the organizations ENTITY itself, created
// in the Phase 1 migration. Deliberately a distinct
// file from:
//   - organizationService.js (singular) -- unrelated
//     HR/reporting-hierarchy helpers (departments,
//     reporting managers, org chart), untouched here.
//   - organizationMemberService.js -- Phase 1's
//     organization_members CRUD, the sole
//     authoritative source for "is this person a
//     member of this organization". This file never
//     duplicates that logic; it only reads
//     organization_members for read-only rollup
//     counts (member_count) on the list/detail views.
// ==========================================

// ==========================================
// GET ALL ORGANIZATIONS (with member/project rollups)
// ==========================================

const getAllOrganizations = async () => {

    const [organizations] = await pool.query(`
        SELECT
            o.*,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM organization_members om
                WHERE om.organization_id = o.id
            ) AS member_count,

            (
                SELECT COUNT(*)
                FROM projects p
                WHERE p.organization_id = o.id
            ) AS project_count

        FROM organizations o
        LEFT JOIN users creator
            ON creator.id = o.created_by
        ORDER BY o.id DESC
    `);

    return organizations;

};

// ==========================================
// GET ONE ORGANIZATION (with rollups)
// ==========================================

const getOrganizationById = async (id) => {

    const [organizations] = await pool.query(`
        SELECT
            o.*,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM organization_members om
                WHERE om.organization_id = o.id
            ) AS member_count,

            (
                SELECT COUNT(*)
                FROM projects p
                WHERE p.organization_id = o.id
            ) AS project_count

        FROM organizations o
        LEFT JOIN users creator
            ON creator.id = o.created_by
        WHERE o.id = ?
        LIMIT 1
    `, [id]);

    return organizations[0] || null;

};

// ==========================================
// FIND BY NAME (duplicate-name check)
// ==========================================

const getOrganizationByName = async (name) => {

    const [[row]] = await pool.query(
        `SELECT id FROM organizations WHERE name = ? LIMIT 1`,
        [name]
    );

    return row || null;

};

// ==========================================
// CREATE ORGANIZATION
// createdBy is always the server-resolved caller
// (req.user.id) -- never trusted from the request
// body, per the approved authorization requirement.
// ==========================================

const createOrganization = async (data, createdBy) => {

    const { name, description, status } = data;

    const [result] = await pool.query(`
        INSERT INTO organizations (name, description, status, created_by)
        VALUES (?, ?, ?, ?)
    `, [
        name,
        description || null,
        status || "active",
        createdBy,
    ]);

    return result.insertId;

};

module.exports = {
    getAllOrganizations,
    getOrganizationById,
    getOrganizationByName,
    createOrganization,
};
