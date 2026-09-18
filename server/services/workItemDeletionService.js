const crypto = require("crypto");

const pool = require("../config/db");

const { deleteEpic: hardDeleteEpic } = require("./epicService");
const { deleteFeature: hardDeleteFeature } = require("./featureService");
const { deleteUserStory: hardDeleteUserStory } = require("./userStoryService");
const { deleteTask: hardDeleteTask } = require("./taskService");
const { deleteSprint: hardDeleteSprint } = require("./sprintService");
const { taskCode } = require("./workItemCodeService");

// ==========================================
// RECYCLE BIN / SOFT-DELETE SERVICE
//
// Owns every Recycle Bin concern for the four work-item types plus
// Sprint in ONE place, rather than duplicating soft-delete/restore/
// permanent-delete logic five times across epicService/featureService/
// userStoryService/taskService/sprintService.
//
// PARENT-DELETE STRATEGY (documented per the spec's Part 22
// requirement, decided before writing this file):
//
//   Deleting Epic/Feature/User Story cascades the SAME soft-delete to
//   every descendant in one transaction (Strategy "move related
//   children to the Recycle Bin together while preserving
//   relationships"). This was chosen over blocking parent deletion
//   while children exist (too restrictive for real cleanup) and is
//   safe specifically BECAUSE it is a soft delete: no FK ON DELETE
//   SET NULL ever fires (that only happens on a real DELETE), so
//   epic_id/feature_id/user_story_id/sprint_id are left completely
//   untouched on every descendant -- the whole subtree's hierarchy is
//   automatically intact and correct the moment any of it is restored,
//   with zero relationship-reconstruction logic needed.
//
//   RESTORE has two forms, both always available:
//     - Individual restore (per-item, unchanged from the original
//       design) -- restores exactly one row, leaving every other
//       row's deleted_at/deleted_by/deleted_batch_id untouched.
//     - "Restore All" (restoreBatch) -- every Epic/Feature/User
//       Story/Task that carries the SAME deleted_batch_id (a UUID
//       generated fresh by softDeleteEpic/softDeleteFeature/
//       softDeleteUserStory at the moment of THAT cascade, and
//       stamped onto every row it touches, itself included) is
//       restored together, in one transaction. A row that was
//       already soft-deleted BEFORE a later cascade runs is excluded
//       from that cascade's SELECT (see the "AND deleted_at IS NULL"
//       guard on every descendant lookup below) and therefore never
//       receives the new batch id -- so "Restore All" for the new
//       cascade can never resurrect a descendant that was deleted
//       independently, earlier, for an unrelated reason. Task never
//       triggers a cascade itself, so a standalone Task delete never
//       gets a batch id (NULL) -- it only ever gets one as a member of
//       an Epic/Feature/User Story's cascade.
//
//   Task is a leaf -- its soft-delete never cascades.
//
//   Sprint is cross-cutting, not hierarchical -- soft-deleting a
//   Sprint does NOT soft-delete its Tasks/User Stories (they belong to
//   the Epic/Feature/User Story hierarchy, not to the Sprint). Instead
//   it DETACHES them back to the Backlog (sprint_id = NULL), the exact
//   same outcome sprintService.completeSprint already produces for a
//   normally-completed sprint. This is DIFFERENT from soft-deleting a
//   Task/User Story that happens to be in a sprint (sprint_id is never
//   touched in that case, so its sprint assignment is preserved and
//   restored automatically). An ACTIVE sprint cannot be deleted at all
//   (must be completed first) -- consistent with this codebase's
//   existing sprint-status restrictions (updateSprint locks a
//   completed sprint; startSprint blocks a second concurrent active
//   sprint) and avoids the alternative of a soft-deleted-but-still-
//   "active" sprint colliding with the DB-level
//   uq_one_active_sprint_per_project constraint.
//
//   PERMANENT delete requires the item to already be soft-deleted
//   (safety guard) and only ever removes that ONE row (reusing each
//   service's existing hard-delete function, which already calls
//   deleteLinksForItem) -- it does not cascade to a still-soft-deleted
//   subtree; each item is purged individually from the Recycle Bin.
// ==========================================

const ACTIVE_SPRINT_DELETE_ERROR = "ActiveSprintCannotBeDeleted";
const NOT_SOFT_DELETED_ERROR = "NotInRecycleBin";

async function updateDeletedFlag(conn, table, ids, deletedAt, deletedBy, batchId) {
    if (ids.length === 0) return;
    await conn.query(
        `UPDATE ${table} SET deleted_at = ?, deleted_by = ?, deleted_batch_id = ? WHERE id = ANY(?)`,
        [deletedAt, deletedBy, batchId, ids]
    );
}

// ==========================================
// SOFT DELETE -- EPIC (cascades to Features/User Stories/Tasks)
// ==========================================

const softDeleteEpic = async (epicId, deletedBy) => {

    const conn = await pool.getConnection();

    try {

        await conn.beginTransaction();

        const [[epic]] = await conn.query(
            `SELECT id FROM epics WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [epicId]
        );

        if (!epic) {
            await conn.rollback();
            return null;
        }

        const [features] = await conn.query(
            `SELECT id FROM features WHERE epic_id = ? AND deleted_at IS NULL`,
            [epicId]
        );
        const featureIds = features.map((f) => f.id);

        let storyIds = [];
        if (featureIds.length > 0) {
            const [stories] = await conn.query(
                `SELECT id FROM user_stories WHERE feature_id = ANY(?) AND deleted_at IS NULL`,
                [featureIds]
            );
            storyIds = stories.map((s) => s.id);
        }

        let taskIds = [];
        if (storyIds.length > 0) {
            const [tasks] = await conn.query(
                `SELECT id FROM tasks WHERE user_story_id = ANY(?) AND deleted_at IS NULL`,
                [storyIds]
            );
            taskIds = tasks.map((t) => t.id);
        }

        const now = new Date();
        const batchId = crypto.randomUUID();

        await conn.query(`UPDATE epics SET deleted_at = ?, deleted_by = ?, deleted_batch_id = ? WHERE id = ?`, [now, deletedBy, batchId, epicId]);
        await updateDeletedFlag(conn, "features", featureIds, now, deletedBy, batchId);
        await updateDeletedFlag(conn, "user_stories", storyIds, now, deletedBy, batchId);
        await updateDeletedFlag(conn, "tasks", taskIds, now, deletedBy, batchId);

        await conn.commit();

        return { batchId, featureCount: featureIds.length, userStoryCount: storyIds.length, taskCount: taskIds.length };

    } catch (error) {

        await conn.rollback();
        throw error;

    } finally {

        conn.release();

    }

};

// ==========================================
// SOFT DELETE -- FEATURE (cascades to User Stories/Tasks)
// ==========================================

const softDeleteFeature = async (featureId, deletedBy) => {

    const conn = await pool.getConnection();

    try {

        await conn.beginTransaction();

        const [[feature]] = await conn.query(
            `SELECT id FROM features WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [featureId]
        );

        if (!feature) {
            await conn.rollback();
            return null;
        }

        const [stories] = await conn.query(
            `SELECT id FROM user_stories WHERE feature_id = ? AND deleted_at IS NULL`,
            [featureId]
        );
        const storyIds = stories.map((s) => s.id);

        let taskIds = [];
        if (storyIds.length > 0) {
            const [tasks] = await conn.query(
                `SELECT id FROM tasks WHERE user_story_id = ANY(?) AND deleted_at IS NULL`,
                [storyIds]
            );
            taskIds = tasks.map((t) => t.id);
        }

        const now = new Date();
        const batchId = crypto.randomUUID();

        await conn.query(`UPDATE features SET deleted_at = ?, deleted_by = ?, deleted_batch_id = ? WHERE id = ?`, [now, deletedBy, batchId, featureId]);
        await updateDeletedFlag(conn, "user_stories", storyIds, now, deletedBy, batchId);
        await updateDeletedFlag(conn, "tasks", taskIds, now, deletedBy, batchId);

        await conn.commit();

        return { batchId, userStoryCount: storyIds.length, taskCount: taskIds.length };

    } catch (error) {

        await conn.rollback();
        throw error;

    } finally {

        conn.release();

    }

};

// ==========================================
// SOFT DELETE -- USER STORY (cascades to Tasks)
// ==========================================

const softDeleteUserStory = async (storyId, deletedBy) => {

    const conn = await pool.getConnection();

    try {

        await conn.beginTransaction();

        const [[story]] = await conn.query(
            `SELECT id FROM user_stories WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [storyId]
        );

        if (!story) {
            await conn.rollback();
            return null;
        }

        const [tasks] = await conn.query(
            `SELECT id FROM tasks WHERE user_story_id = ? AND deleted_at IS NULL`,
            [storyId]
        );
        const taskIds = tasks.map((t) => t.id);

        const now = new Date();
        const batchId = crypto.randomUUID();

        await conn.query(`UPDATE user_stories SET deleted_at = ?, deleted_by = ?, deleted_batch_id = ? WHERE id = ?`, [now, deletedBy, batchId, storyId]);
        await updateDeletedFlag(conn, "tasks", taskIds, now, deletedBy, batchId);

        await conn.commit();

        return { batchId, taskCount: taskIds.length };

    } catch (error) {

        await conn.rollback();
        throw error;

    } finally {

        conn.release();

    }

};

// ==========================================
// SOFT DELETE -- TASK (leaf, no cascade)
// ==========================================

const softDeleteTask = async (taskId, deletedBy) => {

    const [result] = await pool.query(
        `UPDATE tasks SET deleted_at = NOW(), deleted_by = ? WHERE id = ? AND deleted_at IS NULL`,
        [deletedBy, taskId]
    );

    return result.affectedRows > 0;

};

// ==========================================
// SOFT DELETE -- SPRINT (detaches its Tasks/User Stories to Backlog;
// blocks while the sprint is active)
// ==========================================

const softDeleteSprint = async (sprintId, deletedBy) => {

    const conn = await pool.getConnection();

    try {

        await conn.beginTransaction();

        const [[sprint]] = await conn.query(
            `SELECT id, status FROM sprints WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
            [sprintId]
        );

        if (!sprint) {
            await conn.rollback();
            return null;
        }

        if (sprint.status === "active") {
            const error = new Error("An active sprint cannot be deleted. Complete it first.");
            error.name = ACTIVE_SPRINT_DELETE_ERROR;
            throw error;
        }

        const [tasks] = await conn.query(
            `SELECT id FROM tasks WHERE sprint_id = ? AND deleted_at IS NULL`,
            [sprintId]
        );
        const taskIds = tasks.map((t) => t.id);

        const [stories] = await conn.query(
            `SELECT id FROM user_stories WHERE sprint_id = ? AND deleted_at IS NULL`,
            [sprintId]
        );
        const storyIds = stories.map((s) => s.id);

        if (taskIds.length > 0) {
            await conn.query(`UPDATE tasks SET sprint_id = NULL WHERE id = ANY(?)`, [taskIds]);
        }

        if (storyIds.length > 0) {
            await conn.query(`UPDATE user_stories SET sprint_id = NULL WHERE id = ANY(?)`, [storyIds]);
        }

        await conn.query(`UPDATE sprints SET deleted_at = NOW(), deleted_by = ? WHERE id = ?`, [deletedBy, sprintId]);

        await conn.commit();

        return { detachedTaskIds: taskIds, detachedUserStoryIds: storyIds };

    } catch (error) {

        await conn.rollback();
        throw error;

    } finally {

        conn.release();

    }

};

// ==========================================
// RESTORE -- INDIVIDUAL (unchanged from the original design). Each
// returns true/false (found-and-restored or not); the caller is
// responsible for the 404 response when false. Clears
// deleted_batch_id too (a restored/active row's old batch id is
// meaningless -- the row is no longer a member of that cascade; a
// future delete always stamps a fresh value regardless).
// ==========================================

async function restoreRow(table, id) {
    const [result] = await pool.query(
        `UPDATE "${table}" SET deleted_at = NULL, deleted_by = NULL, deleted_batch_id = NULL WHERE id = ? AND deleted_at IS NOT NULL`,
        [id]
    );
    return result.affectedRows > 0;
}

const restoreEpic = (id) => restoreRow("epics", id);
const restoreFeature = (id) => restoreRow("features", id);
const restoreUserStory = (id) => restoreRow("user_stories", id);
const restoreTask = (id) => restoreRow("tasks", id);
const restoreSprint = (id) => restoreRow("sprints", id);

// ==========================================
// RESTORE ALL (a cascade-deleted group, identified by deleted_batch_id)
//
// getBatchMembership resolves exactly which rows (and which types)
// carry this batch id, scoped to the given project -- used by the
// controller to check permission for EVERY type actually present
// before restoring anything (e.g. a batch containing a Task must
// still require TASK_DELETE, not just EPIC_DELETE, even though the
// Epic is the batch's "root"). restoreBatch then restores all of
// them in one transaction; a row belonging to a DIFFERENT batch (or
// already restored) is never touched.
// ==========================================

async function getBatchMembership(batchId, projectId) {

    const [epics] = await pool.query(
        `SELECT id FROM epics WHERE deleted_batch_id = ? AND project_id = ? AND deleted_at IS NOT NULL`,
        [batchId, projectId]
    );
    const [features] = await pool.query(
        `SELECT id FROM features WHERE deleted_batch_id = ? AND project_id = ? AND deleted_at IS NOT NULL`,
        [batchId, projectId]
    );
    const [userStories] = await pool.query(
        `SELECT id FROM user_stories WHERE deleted_batch_id = ? AND project_id = ? AND deleted_at IS NOT NULL`,
        [batchId, projectId]
    );
    const [tasks] = await pool.query(
        `SELECT id FROM tasks WHERE deleted_batch_id = ? AND project_id = ? AND deleted_at IS NOT NULL`,
        [batchId, projectId]
    );

    return {
        epicIds: epics.map((r) => r.id),
        featureIds: features.map((r) => r.id),
        userStoryIds: userStories.map((r) => r.id),
        taskIds: tasks.map((r) => r.id),
    };

}

async function restoreBatch(batchId, membership) {

    const conn = await pool.getConnection();

    try {

        await conn.beginTransaction();

        async function restoreIds(table, ids) {
            if (ids.length === 0) return;
            await conn.query(
                `UPDATE "${table}" SET deleted_at = NULL, deleted_by = NULL, deleted_batch_id = NULL WHERE id = ANY(?) AND deleted_batch_id = ?`,
                [ids, batchId]
            );
        }

        await restoreIds("epics", membership.epicIds);
        await restoreIds("features", membership.featureIds);
        await restoreIds("user_stories", membership.userStoryIds);
        await restoreIds("tasks", membership.taskIds);

        await conn.commit();

    } catch (error) {

        await conn.rollback();
        throw error;

    } finally {

        conn.release();

    }

}

// ==========================================
// PERMANENT DELETE
// Requires the row to already be soft-deleted (never permanently
// deletes something still active/visible) -- reuses each service's
// existing hard-delete function unchanged (already calls
// deleteLinksForItem).
// ==========================================

async function assertSoftDeleted(table, id) {

    const [[row]] = await pool.query(
        `SELECT id FROM "${table}" WHERE id = ? AND deleted_at IS NOT NULL LIMIT 1`,
        [id]
    );

    if (!row) {
        const error = new Error("This item is not in the Recycle Bin");
        error.name = NOT_SOFT_DELETED_ERROR;
        throw error;
    }

}

const permanentlyDeleteEpic = async (id) => {
    await assertSoftDeleted("epics", id);
    await hardDeleteEpic(id);
};

const permanentlyDeleteFeature = async (id) => {
    await assertSoftDeleted("features", id);
    await hardDeleteFeature(id);
};

const permanentlyDeleteUserStory = async (id) => {
    await assertSoftDeleted("user_stories", id);
    await hardDeleteUserStory(id);
};

const permanentlyDeleteTask = async (id) => {
    await assertSoftDeleted("tasks", id);
    await hardDeleteTask(id);
};

const permanentlyDeleteSprint = async (id) => {
    await assertSoftDeleted("sprints", id);
    await hardDeleteSprint(id);
};

// ==========================================
// RECYCLE BIN LISTING (project-scoped)
// Every soft-deleted row across all five types for this project,
// tagged with type + enough context (parent title, sprint, deleted
// by/when) to identify and restore it, per the spec's metadata list.
// ==========================================

const getRecycleBinForProject = async (projectId) => {

    const [epics] = await pool.query(`
        SELECT
            e.id, e.epic_code AS code, e.title, e.status, e.project_id,
            e.deleted_at, e.deleted_by, e.deleted_batch_id, u.full_name AS deleted_by_name
        FROM epics e
        LEFT JOIN users u ON u.id = e.deleted_by
        WHERE e.project_id = ? AND e.deleted_at IS NOT NULL
        ORDER BY e.deleted_at DESC
    `, [projectId]);

    const [features] = await pool.query(`
        SELECT
            f.id, f.feature_code AS code, f.title, f.status, f.project_id,
            f.epic_id, epic.title AS epic_title,
            f.deleted_at, f.deleted_by, f.deleted_batch_id, u.full_name AS deleted_by_name
        FROM features f
        LEFT JOIN epics epic ON epic.id = f.epic_id
        LEFT JOIN users u ON u.id = f.deleted_by
        WHERE f.project_id = ? AND f.deleted_at IS NOT NULL
        ORDER BY f.deleted_at DESC
    `, [projectId]);

    const [userStories] = await pool.query(`
        SELECT
            us.id, us.story_code AS code, us.title, us.status, us.project_id,
            us.feature_id, feature.title AS feature_title,
            us.sprint_id, sp.name AS sprint_name,
            us.deleted_at, us.deleted_by, us.deleted_batch_id, u.full_name AS deleted_by_name
        FROM user_stories us
        LEFT JOIN features feature ON feature.id = us.feature_id
        LEFT JOIN sprints sp ON sp.id = us.sprint_id
        LEFT JOIN users u ON u.id = us.deleted_by
        WHERE us.project_id = ? AND us.deleted_at IS NOT NULL
        ORDER BY us.deleted_at DESC
    `, [projectId]);

    const [tasks] = await pool.query(`
        SELECT
            t.id, t.task_number, t.task_title AS title, t.status, t.project_id,
            t.user_story_id, us.title AS user_story_title,
            t.sprint_id, sp.name AS sprint_name,
            t.deleted_at, t.deleted_by, t.deleted_batch_id, u.full_name AS deleted_by_name
        FROM tasks t
        LEFT JOIN user_stories us ON us.id = t.user_story_id
        LEFT JOIN sprints sp ON sp.id = t.sprint_id
        LEFT JOIN users u ON u.id = t.deleted_by
        WHERE t.project_id = ? AND t.deleted_at IS NOT NULL
        ORDER BY t.deleted_at DESC
    `, [projectId]);

    for (const task of tasks) {
        task.code = taskCode(task);
    }

    const [sprints] = await pool.query(`
        SELECT
            s.id, s.name AS title, s.status, s.project_id,
            s.deleted_at, s.deleted_by, u.full_name AS deleted_by_name
        FROM sprints s
        LEFT JOIN users u ON u.id = s.deleted_by
        WHERE s.project_id = ? AND s.deleted_at IS NOT NULL
        ORDER BY s.deleted_at DESC
    `, [projectId]);

    return { epics, features, userStories, tasks, sprints };

};

module.exports = {

    ACTIVE_SPRINT_DELETE_ERROR,
    NOT_SOFT_DELETED_ERROR,

    softDeleteEpic,
    softDeleteFeature,
    softDeleteUserStory,
    softDeleteTask,
    softDeleteSprint,

    restoreEpic,
    restoreFeature,
    restoreUserStory,
    restoreTask,
    restoreSprint,

    getBatchMembership,
    restoreBatch,

    permanentlyDeleteEpic,
    permanentlyDeleteFeature,
    permanentlyDeleteUserStory,
    permanentlyDeleteTask,
    permanentlyDeleteSprint,

    getRecycleBinForProject,

};
