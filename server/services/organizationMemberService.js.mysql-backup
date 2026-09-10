const pool = require("../config/db");

// ==========================================
// ORGANIZATION MEMBERSHIP SERVICE (Phase 1)
//
// organization_members is the SOLE authoritative
// source for "is this person a member of this
// organization" -- users.organization_id is a
// denormalized, kept-in-sync convenience column
// (useful for scoped queries without a join, and for
// future Attendance/Leave scoping), never itself
// consulted for an authorization decision anywhere
// in this file or its callers.
//
// One organization per person is enforced at the DB
// level (organization_members.user_id has a UNIQUE
// constraint, not just the (organization_id, user_id)
// pair) -- cross-organization membership is
// impossible to create by construction, not merely
// rejected here in application code.
// ==========================================

// ==========================================
// IS ORGANIZATION MEMBER
// The single check every project-membership /
// task-assignment eligibility path should call.
// ==========================================

async function isOrganizationMember(organizationId, userId) {

    if (!organizationId || !userId) {
        return false;
    }

    const [[row]] = await pool.query(
        `SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1`,
        [organizationId, userId]
    );

    return Boolean(row);

}

// ==========================================
// GET A USER'S CURRENT ORGANIZATION MEMBERSHIP
// (there can be at most one, per the UNIQUE
// constraint on user_id)
// ==========================================

async function getOrganizationMembershipForUser(userId) {

    const [[row]] = await pool.query(
        `SELECT organization_id FROM organization_members WHERE user_id = ? LIMIT 1`,
        [userId]
    );

    return row?.organization_id || null;

}

// ==========================================
// GET ORGANIZATION MEMBERS
// (department/designation joined for the Members
// table -- designation is stored directly on users,
// department comes from users.department_id)
// ==========================================

async function getOrganizationMembers(organizationId) {

    const [rows] = await pool.query(
        `
        SELECT
            om.id,
            om.user_id,
            u.full_name,
            u.email,
            u.employee_id,
            u.employment_status,
            u.designation,
            d.name AS department_name,
            om.added_by,
            adder.full_name AS added_by_name,
            om.created_at
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        LEFT JOIN departments d ON d.id = u.department_id
        LEFT JOIN users adder ON adder.id = om.added_by
        WHERE om.organization_id = ?
        ORDER BY u.full_name
        `,
        [organizationId]
    );

    return rows;

}

// ==========================================
// GET ELIGIBLE EMPLOYEES FOR AN ORGANIZATION
// Active employees with NO current organization
// membership at all -- per the one-organization-per-
// person schema (UNIQUE on organization_members.
// user_id), anyone already in ANY organization
// (including this one) is, by definition, ineligible
// to be newly added, so this single condition covers
// both "already a member here" and "belongs to a
// different organization" without a second query.
// ==========================================

async function getEligibleEmployees() {

    const [rows] = await pool.query(
        `
        SELECT u.id, u.employee_id, u.full_name, u.email
        FROM users u
        WHERE u.employment_status = 'active'
        AND NOT EXISTS (
            SELECT 1 FROM organization_members om WHERE om.user_id = u.id
        )
        ORDER BY u.full_name
        `
    );

    return rows;

}

// ==========================================
// ADD ORGANIZATION MEMBER
// Mirrors addMembers() in projectMemberController.js's
// skip-rather-than-error convention for a batch add,
// but this is a single-user operation since org
// membership is 1:1 (see UNIQUE constraint above).
//
// Rejects (rather than silently no-ops):
//   - user not found / not an active employee
//   - user already belongs to a DIFFERENT organization
// No-ops (idempotent, matches project addMembers'
// "already a member" convention):
//   - user is already a member of THIS organization
// ==========================================

async function addOrganizationMember(organizationId, userId, addedBy) {

    const [[user]] = await pool.query(
        `SELECT id, employment_status FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );

    if (!user) {
        return { success: false, reason: "not_found" };
    }

    if (user.employment_status !== "active") {
        return { success: false, reason: "not_active" };
    }

    const existingOrgId = await getOrganizationMembershipForUser(userId);

    if (existingOrgId && Number(existingOrgId) === Number(organizationId)) {
        return { success: true, reason: "already_member" };
    }

    if (existingOrgId && Number(existingOrgId) !== Number(organizationId)) {
        return { success: false, reason: "different_organization" };
    }

    await pool.query(
        `INSERT INTO organization_members (organization_id, user_id, added_by) VALUES (?, ?, ?)`,
        [organizationId, userId, addedBy || null]
    );

    await pool.query(
        `UPDATE users SET organization_id = ? WHERE id = ?`,
        [organizationId, userId]
    );

    return { success: true, reason: "added" };

}

// ==========================================
// REMOVE ORGANIZATION MEMBER
//
// Per the approved business rule: removing someone
// from an organization ALSO removes their
// project_members rows in that organization's
// projects -- but never touches the users row, and
// never touches existing task assignments (a removed
// employee who remains assigned_to on an existing
// task keeps that assignment; this is a deliberate,
// explicitly-approved deferral to a later business-
// rule decision, not an oversight).
// ==========================================

async function removeOrganizationMember(organizationId, userId) {

    const [[existing]] = await pool.query(
        `SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ? LIMIT 1`,
        [organizationId, userId]
    );

    if (!existing) {
        return { success: false, reason: "not_a_member" };
    }

    await pool.query(
        `DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?`,
        [organizationId, userId]
    );

    await pool.query(
        `UPDATE users SET organization_id = NULL WHERE id = ? AND organization_id = ?`,
        [userId, organizationId]
    );

    const [cascadeResult] = await pool.query(
        `
        DELETE pm FROM project_members pm
        JOIN projects p ON p.id = pm.project_id
        WHERE pm.user_id = ?
        AND p.organization_id = ?
        `,
        [userId, organizationId]
    );

    return { success: true, reason: "removed", removedProjectMemberships: cascadeResult.affectedRows };

}

module.exports = {
    isOrganizationMember,
    getOrganizationMembershipForUser,
    getOrganizationMembers,
    getEligibleEmployees,
    addOrganizationMember,
    removeOrganizationMember,
};
