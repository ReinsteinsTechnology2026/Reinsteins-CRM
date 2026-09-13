const pool = require("../config/db");

// ==========================================
// WORK ITEM LINK SERVICE
//
// Generic Epic/Feature/User Story/Task relationship
// engine (work_item_links table). Deliberately generic
// at the DATA layer per the approved design -- but v1
// UI only ever creates task<->task links (TaskWorkspace).
// Nothing here assumes the caller is a task; the type
// whitelist below is what actually enforces "only these
// four tables are ever touched" -- there is no raw
// string ever interpolated into SQL that didn't first
// pass through this same fixed lookup.
//
// Relationship types are intentionally NOT parent/child
// -- that hierarchy already exists as real FKs
// (epics.id <- features.epic_id <- ... ) and is never
// duplicated here.
// ==========================================

const ITEM_TABLES = {
    epic: { table: "epics", titleCol: "title" },
    feature: { table: "features", titleCol: "title" },
    user_story: { table: "user_stories", titleCol: "title" },
    task: { table: "tasks", titleCol: "task_title" },
};

const LINK_TYPES = ["related", "blocks"];

class WorkItemLinkError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "WorkItemLinkError";
        this.code = code;
    }
}

// ==========================================
// RESOLVE ONE ITEM (existence + its REAL project_id +
// display fields) -- this is the single source of truth
// every validation below reads from. Never trusts
// anything the client claims about the item.
// ==========================================

const resolveItem = async (type, id) => {

    const meta = ITEM_TABLES[type];

    if (!meta || !id) {
        return null;
    }

    if (type === "task") {

        const [[row]] = await pool.query(
            `SELECT id, project_id, task_title AS title, task_number, status, assigned_to, assigned_by
             FROM tasks WHERE id = ? LIMIT 1`,
            [id]
        );

        return row || null;

    }

    const [[row]] = await pool.query(
        `SELECT id, project_id, ${meta.titleCol} AS title, status
         FROM ${meta.table} WHERE id = ? LIMIT 1`,
        [id]
    );

    return row || null;

};

// ==========================================
// GET LINKS FOR ONE ITEM
// Returns { blocks: [...], blockedBy: [...], related: [...] }
// -- the "blocked by" side is DERIVED here from the same
// forward "blocks" rows (no inverse row is ever stored).
// ==========================================

const getLinksForItem = async (type, id) => {

    const [rows] = await pool.query(
        `
        SELECT *
        FROM work_item_links
        WHERE (source_type = ? AND source_id = ?)
           OR (target_type = ? AND target_id = ?)
        ORDER BY created_at DESC
        `,
        [type, id, type, id]
    );

    const blocks = [];
    const blockedBy = [];
    const related = [];

    for (const row of rows) {

        const isSource = row.source_type === type && Number(row.source_id) === Number(id);

        const otherType = isSource ? row.target_type : row.source_type;
        const otherId = isSource ? row.target_id : row.source_id;

        const other = await resolveItem(otherType, otherId);

        // A link may point at an item that no longer exists only if
        // the delete-cleanup step was somehow skipped -- treat as
        // stale and omit rather than surface a broken row.
        if (!other) continue;

        const entry = {
            linkId: row.id,
            itemType: otherType,
            itemId: otherId,
            title: other.title,
            taskNumber: other.task_number,
            status: other.status,
        };

        if (row.link_type === "related") {
            related.push(entry);
        } else if (row.link_type === "blocks") {
            if (isSource) {
                blocks.push(entry);
            } else {
                blockedBy.push(entry);
            }
        }

    }

    return { blocks, blockedBy, related };

};

// ==========================================
// CREATE LINK
// Full validation chain per the approved security model.
// Returns { id, source, target } (resolved display data
// for both sides) so the controller can log task activity
// without a second round trip.
// ==========================================

const createLink = async ({ sourceType, sourceId, targetType, targetId, linkType, createdBy }) => {

    if (!ITEM_TABLES[sourceType] || !ITEM_TABLES[targetType]) {
        throw new WorkItemLinkError("INVALID_TYPE", "Unknown work item type");
    }

    if (!LINK_TYPES.includes(linkType)) {
        throw new WorkItemLinkError("INVALID_TYPE", "Unknown relationship type");
    }

    const source = await resolveItem(sourceType, sourceId);

    if (!source) {
        throw new WorkItemLinkError("NOT_FOUND", "Source work item does not exist");
    }

    const target = await resolveItem(targetType, targetId);

    if (!target) {
        throw new WorkItemLinkError("NOT_FOUND", "Target work item does not exist");
    }

    if (!source.project_id || !target.project_id) {
        throw new WorkItemLinkError(
            "NOT_PROJECT_LINKED",
            "Legacy work items that are not linked to a project cannot be related"
        );
    }

    if (Number(source.project_id) !== Number(target.project_id)) {
        throw new WorkItemLinkError(
            "CROSS_PROJECT",
            "Both work items must belong to the same project"
        );
    }

    if (sourceType === targetType && Number(sourceId) === Number(targetId)) {
        throw new WorkItemLinkError("SELF_LINK", "A work item cannot be related to itself");
    }

    // Duplicate check. "related" is symmetric -- A-related-B and
    // B-related-A represent the SAME relationship, so both
    // directions are checked. "blocks" is directional -- only the
    // exact same direction counts as a duplicate (the reverse
    // direction is a circular-block case, handled separately below).
    const duplicateParams = linkType === "related"
        ? [
            sourceType, sourceId, targetType, targetId, linkType,
            targetType, targetId, sourceType, sourceId, linkType,
        ]
        : [sourceType, sourceId, targetType, targetId, linkType];

    const duplicateQuery = linkType === "related"
        ? `
            SELECT id FROM work_item_links
            WHERE (source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND link_type = ?)
               OR (source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND link_type = ?)
            LIMIT 1
        `
        : `
            SELECT id FROM work_item_links
            WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND link_type = ?
            LIMIT 1
        `;

    const [[existingDuplicate]] = await pool.query(duplicateQuery, duplicateParams);

    if (existingDuplicate) {
        throw new WorkItemLinkError("DUPLICATE", "This relationship already exists");
    }

    if (linkType === "blocks") {

        const [[inverseBlock]] = await pool.query(
            `
            SELECT id FROM work_item_links
            WHERE source_type = ? AND source_id = ? AND target_type = ? AND target_id = ? AND link_type = 'blocks'
            LIMIT 1
            `,
            [targetType, targetId, sourceType, sourceId]
        );

        if (inverseBlock) {
            throw new WorkItemLinkError(
                "CIRCULAR_BLOCK",
                "This would create a direct circular blocking relationship"
            );
        }

    }

    const [result] = await pool.query(
        `
        INSERT INTO work_item_links
            (source_type, source_id, target_type, target_id, link_type, project_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        RETURNING id
        `,
        [sourceType, sourceId, targetType, targetId, linkType, source.project_id, createdBy]
    );

    return { id: result[0].id, source, target };

};

// ==========================================
// GET ONE LINK ROW (for delete-time resolution --
// source/target/project are always re-read fresh from
// this row, never trusted from the client's :id alone)
// ==========================================

const getLinkById = async (linkId) => {

    const [[row]] = await pool.query(
        `SELECT * FROM work_item_links WHERE id = ? LIMIT 1`,
        [linkId]
    );

    return row || null;

};

// ==========================================
// DELETE LINK (by its own id)
// Returns the resolved source/target display data (for
// activity logging) before removing the row.
// ==========================================

const deleteLink = async (linkId) => {

    const link = await getLinkById(linkId);

    if (!link) {
        return null;
    }

    const source = await resolveItem(link.source_type, link.source_id);
    const target = await resolveItem(link.target_type, link.target_id);

    await pool.query(`DELETE FROM work_item_links WHERE id = ?`, [linkId]);

    return { link, source, target };

};

// ==========================================
// DELETE ALL LINKS INVOLVING ONE ITEM
// Called from the existing Epic/Feature/User Story/Task
// delete services -- there is no DB-level FK that can
// point at 4 different tables from one column, so this
// explicit step is what prevents orphaned rows (per the
// approved design; the alternative -- leaving them, like
// notifications.reference_id already does -- was
// explicitly rejected for this feature).
// ==========================================

const deleteLinksForItem = async (type, id) => {

    await pool.query(
        `
        DELETE FROM work_item_links
        WHERE (source_type = ? AND source_id = ?)
           OR (target_type = ? AND target_id = ?)
        `,
        [type, id, type, id]
    );

};

module.exports = {
    WorkItemLinkError,
    ITEM_TABLES,
    LINK_TYPES,
    resolveItem,
    getLinksForItem,
    createLink,
    getLinkById,
    deleteLink,
    deleteLinksForItem,
};
