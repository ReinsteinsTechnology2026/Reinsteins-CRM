const pool = require("../config/db");

const { deleteLinksForItem } = require("./workItemLinkService");
const { createWithGeneratedCode } = require("./workItemCodeService");
const { isEligibleProjectAssignee } = require("./projectPermissionService");

// ==========================================
// ASSIGNMENT ELIGIBILITY
// Reuses the SAME rule Task assignment already enforces (isEligibleProjectAssignee
// -- active employment_status + explicit project_members row, already
// including the System Administrator bypass via canUserAccessProject
// underneath it). null/undefined assigned_to is always valid (no
// assignee yet). Thrown error name matches featureService.js's
// CROSS_PROJECT_ERROR convention so the controller can map it to 400
// the same way.
// ==========================================

const CROSS_PROJECT_ERROR = "CrossProjectParentError";

async function assertEligibleAssignee(assignedTo, projectId) {

    if (assignedTo === null || assignedTo === undefined || assignedTo === "") {
        return;
    }

    const eligible = await isEligibleProjectAssignee(Number(assignedTo), projectId);

    if (!eligible) {
        const error = new Error("Selected user must be an active member of this project");
        error.name = CROSS_PROJECT_ERROR;
        throw error;
    }

}

// ==========================================
// EPIC SERVICE
//
// Top of the new Epic -> Feature -> User Story ->
// Task hierarchy. Deliberately its own service file
// (not folded into userStoryService.js or a generic
// "work item" service) -- one concern per service,
// matching this codebase's existing convention
// (sprintAnalyticsService.js kept separate from
// sprintService.js for the same reason).
//
// No activity/history logging here, by design --
// this version does not extend task_activity or add
// any new activity table for Epics.
// ==========================================

// ==========================================
// GET EPICS FOR A PROJECT (with rollup stats)
// ==========================================

const getEpicsByProject = async (projectId) => {

    const [epics] = await pool.query(`
        SELECT
            e.*,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name,
            assignee.full_name AS assigned_to_name,
            assigner.full_name AS assigned_by_name,

            (
                SELECT COUNT(*)
                FROM features f
                WHERE f.epic_id = e.id
                AND f.deleted_at IS NULL
            ) AS feature_count

        FROM epics e
        LEFT JOIN users owner
            ON owner.id = e.owner_id
        LEFT JOIN users creator
            ON creator.id = e.created_by
        LEFT JOIN users assignee
            ON assignee.id = e.assigned_to
        LEFT JOIN users assigner
            ON assigner.id = e.assigned_by
        WHERE e.project_id = ?
        AND e.deleted_at IS NULL
        ORDER BY e.id DESC
    `, [projectId]);

    // feature_count is bigint (COUNT(*)) -- pg returns it as a string.
    return epics.map((e) => ({
        ...e,
        feature_count: Number(e.feature_count),
    }));

};

// ==========================================
// GET ONE EPIC
// ==========================================

const getEpicById = async (id) => {

    const [epics] = await pool.query(`
        SELECT
            e.*,
            p.name AS project_name,
            owner.full_name AS owner_name,
            creator.full_name AS created_by_name,
            assignee.full_name AS assigned_to_name,
            assigner.full_name AS assigned_by_name
        FROM epics e
        INNER JOIN projects p
            ON p.id = e.project_id
        LEFT JOIN users owner
            ON owner.id = e.owner_id
        LEFT JOIN users creator
            ON creator.id = e.created_by
        LEFT JOIN users assignee
            ON assignee.id = e.assigned_to
        LEFT JOIN users assigner
            ON assigner.id = e.assigned_by
        WHERE e.id = ?
        AND e.deleted_at IS NULL
        LIMIT 1
    `, [id]);

    return epics[0] || null;

};

// ==========================================
// CREATE EPIC
// ==========================================

const createEpic = async (projectId, data, createdBy) => {

    const {
        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        assigned_to,
    } = data;

    await assertEligibleAssignee(assigned_to, projectId);

    // Assigned By is always the authenticated creator -- never a
    // client-supplied value (createdBy comes from req.user.id in the
    // controller, the same trusted source used for created_by).
    const assignedBy = assigned_to ? createdBy : null;

    const id = await createWithGeneratedCode("epic", async (epicCode) => {

        const [result] = await pool.query(`
            INSERT INTO epics(
                project_id,
                epic_code,
                title,
                description,
                owner_id,
                created_by,
                status,
                priority,
                start_date,
                due_date,
                assigned_to,
                assigned_by
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            RETURNING id
        `, [

            projectId,
            epicCode,
            title,
            description || null,
            owner_id || null,
            createdBy,
            status || "new",
            priority || "Medium",
            start_date || null,
            due_date || null,
            assigned_to || null,
            assignedBy,

        ]);

        return result[0].id;

    });

    return id;

};

// ==========================================
// UPDATE EPIC
// ==========================================

const updateEpic = async (id, data, projectId, updatedBy) => {

    const {
        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
        assigned_to,
    } = data;

    await assertEligibleAssignee(assigned_to, projectId);

    // Per decision: on reassignment, Assigned By becomes whoever is
    // performing THIS change (updatedBy = req.user.id from the
    // controller) -- not preserved as the original creator. Only set
    // when assigned_to is actually present in the payload, so a
    // partial update that omits assigned_to doesn't clobber an
    // existing assignment's assigned_by with a stray value.
    const assignedBy = assigned_to ? updatedBy : null;

    await pool.query(`
        UPDATE epics
        SET
            title=?,
            description=?,
            owner_id=?,
            status=?,
            priority=?,
            start_date=?,
            due_date=?,
            assigned_to=?,
            assigned_by=?
        WHERE id=?
    `, [

        title,
        description || null,
        owner_id || null,
        status,
        priority,
        start_date || null,
        due_date || null,
        assigned_to || null,
        assignedBy,
        id,

    ]);

};

// ==========================================
// DELETE EPIC
// Its Features are NOT deleted -- the
// fk_features_epic FK (ON DELETE SET NULL) detaches
// them back to "no Epic" automatically at the DB
// level, matching the approved "opt-in at every
// level" design (a Feature may exist directly under
// a Project without an Epic).
// ==========================================

const deleteEpic = async (id) => {

    // No DB-level FK can point at 4 different tables, so any Work
    // Item Link involving this Epic (either side) is cleaned up
    // explicitly here -- otherwise it would be left orphaned.
    await deleteLinksForItem("epic", id);

    await pool.query(`DELETE FROM epics WHERE id = ?`, [id]);

};

module.exports = {

    getEpicsByProject,
    getEpicById,
    createEpic,
    updateEpic,
    deleteEpic,
    CROSS_PROJECT_ERROR,
    assertEligibleAssignee,

};
