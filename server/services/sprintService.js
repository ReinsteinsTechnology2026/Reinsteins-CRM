const pool = require("../config/db");

// ==========================================
// GET ACTIVE SPRINTS ACROSS EVERY PROJECT THE
// USER IS A MEMBER OF (dashboard widget)
// Same membership-EXISTS pattern already used by
// taskService.getAllTasks's PROJECT_MEMBERSHIP_FILTER
// -- self-scoped to the caller, no project-specific
// permission check needed (mirrors getAllTasks,
// which also needs none for the same reason).
// ==========================================

const getActiveSprintsForUser = async (userId) => {

    const [sprints] = await pool.query(`
        SELECT
            s.*,
            p.name AS project_name,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.sprint_id = s.id
            ) AS task_count,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.sprint_id = s.id
                AND t.status = 'closed'
            ) AS closed_task_count

        FROM sprints s
        INNER JOIN projects p
            ON p.id = s.project_id
        WHERE s.status = 'active'
        AND EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = s.project_id
            AND pm.user_id = ?
        )
        ORDER BY s.id DESC
    `, [userId]);

    // task_count/closed_task_count are bigint (COUNT(*)) -- pg
    // returns them as strings, normalize to numbers.
    return sprints.map((s) => ({
        ...s,
        task_count: Number(s.task_count),
        closed_task_count: Number(s.closed_task_count),
    }));

};

// ==========================================
// GET SPRINTS FOR A PROJECT (with rollup stats)
// ==========================================

const getSprintsByProject = async (projectId) => {

    const [sprints] = await pool.query(`
        SELECT
            s.*,
            creator.full_name AS created_by_name,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.sprint_id = s.id
            ) AS task_count,

            (
                SELECT COUNT(*)
                FROM tasks t
                WHERE t.sprint_id = s.id
                AND t.status = 'closed'
            ) AS closed_task_count

        FROM sprints s
        LEFT JOIN users creator
            ON creator.id = s.created_by
        WHERE s.project_id = ?
        ORDER BY
            CASE s.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END,
            s.id DESC
    `, [projectId]);

    // Same bigint-as-string normalization as getActiveSprintsForUser.
    return sprints.map((s) => ({
        ...s,
        task_count: Number(s.task_count),
        closed_task_count: Number(s.closed_task_count),
    }));

};

// ==========================================
// GET ONE SPRINT (with its tasks)
// ==========================================

const getSprintById = async (id) => {

    const [sprints] = await pool.query(`
        SELECT
            s.*,
            p.name AS project_name,
            creator.full_name AS created_by_name
        FROM sprints s
        INNER JOIN projects p
            ON p.id = s.project_id
        LEFT JOIN users creator
            ON creator.id = s.created_by
        WHERE s.id = ?
        LIMIT 1
    `, [id]);

    if (sprints.length === 0) {
        return null;
    }

    const sprint = sprints[0];

    const [tasks] = await pool.query(`
        SELECT
            t.*,
            assignee.full_name AS assigned_to_name
        FROM tasks t
        LEFT JOIN users assignee
            ON assignee.id = t.assigned_to
        WHERE t.sprint_id = ?
        ORDER BY t.id DESC
    `, [id]);

    return {

        ...sprint,

        tasks

    };

};

// ==========================================
// LIGHTWEIGHT PROJECT_ID LOOKUP
// Used by taskManagementController's sprint-
// assignment endpoint to validate the task and
// sprint belong to the same project, without
// pulling the sprint's full task list.
// ==========================================

const getSprintProjectId = async (sprintId) => {

    const [[row]] = await pool.query(
        `SELECT project_id, status, name FROM sprints WHERE id = ? LIMIT 1`,
        [sprintId]
    );

    return row || null;

};

// ==========================================
// CREATE SPRINT
// ==========================================

const DUPLICATE_NAME_ERROR = "DuplicateSprintName";
const INVALID_DATES_ERROR = "InvalidSprintDates";

const createSprint = async (projectId, data, createdBy) => {

    const { name, goal, start_date, end_date } = data;

    if (!name?.trim()) {
        const error = new Error("Sprint name is required");
        error.name = "SprintValidationError";
        throw error;
    }

    if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
        const error = new Error("End date cannot be before start date");
        error.name = INVALID_DATES_ERROR;
        throw error;
    }

    try {

        const [result] = await pool.query(`
            INSERT INTO sprints(
                project_id,
                name,
                goal,
                start_date,
                end_date,
                created_by
            )
            VALUES(?,?,?,?,?,?)
            RETURNING id
        `, [

            projectId,
            name.trim(),
            goal || null,
            start_date || null,
            end_date || null,
            createdBy

        ]);

        return result[0].id;

    } catch (error) {

        if (error.code === "23505") {
            const dupError = new Error("A sprint with this name already exists in this project");
            dupError.name = DUPLICATE_NAME_ERROR;
            throw dupError;
        }

        throw error;

    }

};

// ==========================================
// UPDATE SPRINT (planning/active only — a
// completed sprint's details are locked)
// ==========================================

const updateSprint = async (id, data) => {

    const { name, goal, start_date, end_date } = data;

    if (!name?.trim()) {
        const error = new Error("Sprint name is required");
        error.name = "SprintValidationError";
        throw error;
    }

    if (start_date && end_date && new Date(end_date) < new Date(start_date)) {
        const error = new Error("End date cannot be before start date");
        error.name = INVALID_DATES_ERROR;
        throw error;
    }

    try {

        await pool.query(`
            UPDATE sprints
            SET
                name=?,
                goal=?,
                start_date=?,
                end_date=?
            WHERE id=?
            AND status != 'completed'
        `, [

            name.trim(),
            goal || null,
            start_date || null,
            end_date || null,
            id

        ]);

    } catch (error) {

        if (error.code === "23505") {
            const dupError = new Error("A sprint with this name already exists in this project");
            dupError.name = DUPLICATE_NAME_ERROR;
            throw dupError;
        }

        throw error;

    }

};

// ==========================================
// START SPRINT
// Only one active sprint per project — checked
// here (clear error message) AND backstopped by
// the uq_one_active_sprint_per_project DB index
// (see schema) in case of a race.
// ==========================================

const ALREADY_ACTIVE_ERROR = "AnotherSprintActive";

const startSprint = async (id, projectId) => {

    const [[existingActive]] = await pool.query(`
        SELECT id, name FROM sprints
        WHERE project_id = ? AND status = 'active' AND id != ?
        LIMIT 1
    `, [projectId, id]);

    if (existingActive) {
        const error = new Error(`"${existingActive.name}" is already active. Complete it before starting another sprint.`);
        error.name = ALREADY_ACTIVE_ERROR;
        throw error;
    }

    try {

        await pool.query(`
            UPDATE sprints
            SET status = 'active'
            WHERE id = ?
            AND status = 'planning'
        `, [id]);

    } catch (error) {

        if (error.code === "23505") {
            const dupError = new Error("Another sprint became active just now. Please refresh and try again.");
            dupError.name = ALREADY_ACTIVE_ERROR;
            throw dupError;
        }

        throw error;

    }

};

// ==========================================
// COMPLETE SPRINT
// Transactional: flips status to 'completed' AND
// returns every non-closed task in this sprint to
// the Backlog (sprint_id = NULL) atomically. Closed
// tasks are left attached for history.
//
// The moved task ids are captured before the UPDATE
// so the caller can log a "Removed from sprint" task
// activity entry for each one, same as a manual
// remove -- this is a bulk/automatic move, but it's
// still a real removal from the sprint and should
// leave the same audit trail.
// ==========================================

const completeSprint = async (id) => {

    const conn = await pool.getConnection();

    try {

        await conn.beginTransaction();

        const [movedTasks] = await conn.query(`
            SELECT id FROM tasks
            WHERE sprint_id = ?
            AND status != 'closed'
        `, [id]);

        await conn.query(`
            UPDATE tasks
            SET sprint_id = NULL
            WHERE sprint_id = ?
            AND status != 'closed'
        `, [id]);

        await conn.query(`
            UPDATE sprints
            SET status = 'completed'
            WHERE id = ?
        `, [id]);

        await conn.commit();

        return { movedTaskIds: movedTasks.map((row) => row.id) };

    } catch (error) {

        await conn.rollback();
        throw error;

    } finally {

        conn.release();

    }

};

// ==========================================
// DELETE SPRINT
// fk_tasks_sprint (ON DELETE SET NULL) guarantees
// its tasks return to Backlog at the DB level
// regardless — no manual UPDATE needed first.
// ==========================================

const deleteSprint = async (id) => {

    await pool.query(`DELETE FROM sprints WHERE id = ?`, [id]);

};

module.exports = {

    DUPLICATE_NAME_ERROR,
    INVALID_DATES_ERROR,
    ALREADY_ACTIVE_ERROR,

    getSprintsByProject,
    getActiveSprintsForUser,
    getSprintById,
    getSprintProjectId,
    createSprint,
    updateSprint,
    startSprint,
    completeSprint,
    deleteSprint

};
