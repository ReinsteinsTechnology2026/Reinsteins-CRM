const pool = require("../config/db");

const { deleteLinksForItem } = require("./workItemLinkService");

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

            (
                SELECT COUNT(*)
                FROM features f
                WHERE f.epic_id = e.id
            ) AS feature_count

        FROM epics e
        LEFT JOIN users owner
            ON owner.id = e.owner_id
        LEFT JOIN users creator
            ON creator.id = e.created_by
        WHERE e.project_id = ?
        ORDER BY e.id DESC
    `, [projectId]);

    return epics;

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
            creator.full_name AS created_by_name
        FROM epics e
        INNER JOIN projects p
            ON p.id = e.project_id
        LEFT JOIN users owner
            ON owner.id = e.owner_id
        LEFT JOIN users creator
            ON creator.id = e.created_by
        WHERE e.id = ?
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
    } = data;

    const [result] = await pool.query(`
        INSERT INTO epics(
            project_id,
            title,
            description,
            owner_id,
            created_by,
            status,
            priority,
            start_date,
            due_date
        )
        VALUES(?,?,?,?,?,?,?,?,?)
    `, [

        projectId,
        title,
        description || null,
        owner_id || null,
        createdBy,
        status || "new",
        priority || "Medium",
        start_date || null,
        due_date || null,

    ]);

    return result.insertId;

};

// ==========================================
// UPDATE EPIC
// ==========================================

const updateEpic = async (id, data) => {

    const {
        title,
        description,
        owner_id,
        status,
        priority,
        start_date,
        due_date,
    } = data;

    await pool.query(`
        UPDATE epics
        SET
            title=?,
            description=?,
            owner_id=?,
            status=?,
            priority=?,
            start_date=?,
            due_date=?
        WHERE id=?
    `, [

        title,
        description || null,
        owner_id || null,
        status,
        priority,
        start_date || null,
        due_date || null,
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

};
