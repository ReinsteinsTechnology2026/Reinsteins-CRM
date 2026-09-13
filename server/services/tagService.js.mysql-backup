const pool = require("../config/db");

const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_TASK = 10;

// ==========================================
// VALIDATE + NORMALIZE
// Trims, rejects empty/whitespace-only, enforces
// the DB's 50-char limit, dedupes case-insensitively
// within this request, and caps the count per task.
// The tags.name UNIQUE constraint (case-insensitive
// collation) remains the final protection against
// duplicate rows across concurrent requests.
// ==========================================

function normalizeTagNames(rawNames) {

    if (!rawNames) {
        return [];
    }

    const list = Array.isArray(rawNames) ? rawNames : [rawNames];

    const seen = new Set();
    const normalized = [];

    for (const raw of list) {

        if (typeof raw !== "string") {
            continue;
        }

        const trimmed = raw.trim();

        if (!trimmed) {
            continue;
        }

        if (trimmed.length > MAX_TAG_LENGTH) {
            const error = new Error(`Tag "${trimmed.slice(0, 20)}..." exceeds the ${MAX_TAG_LENGTH}-character limit`);
            error.name = "TagValidationError";
            throw error;
        }

        const key = trimmed.toLowerCase();

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        normalized.push(trimmed);

    }

    if (normalized.length > MAX_TAGS_PER_TASK) {
        const error = new Error(`A task can have at most ${MAX_TAGS_PER_TASK} tags`);
        error.name = "TagValidationError";
        throw error;
    }

    return normalized;

}

// ==========================================
// FIND OR CREATE (atomic, race-safe)
// INSERT ... ON DUPLICATE KEY UPDATE is the
// standard MySQL get-or-create idiom -- avoids a
// separate SELECT-then-INSERT race between
// concurrent requests creating the same tag. The
// existing row's casing wins if one already exists
// (case-insensitive collation on tags.name).
// ==========================================

async function findOrCreateTags(names) {

    const results = [];

    for (const name of names) {

        await pool.query(
            `
            INSERT INTO tags (name)
            VALUES (?)
            ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)
            `,
            [name]
        );

        const [[row]] = await pool.query(
            `SELECT id, name FROM tags WHERE id = LAST_INSERT_ID()`
        );

        results.push(row);

    }

    return results;

}

// ==========================================
// SET TASK TAGS (replace-all, matches how the
// rest of the create/edit task form already saves
// as one batch on submit)
// ==========================================

async function setTaskTags(taskId, rawNames) {

    const names = normalizeTagNames(rawNames);

    const tags = await findOrCreateTags(names);

    await pool.query(`DELETE FROM task_tags WHERE task_id = ?`, [taskId]);

    if (tags.length === 0) {
        return [];
    }

    const values = tags.map((tag) => [taskId, tag.id]);

    await pool.query(
        `INSERT IGNORE INTO task_tags (task_id, tag_id) VALUES ?`,
        [values]
    );

    return tags;

}

// ==========================================
// BATCH FETCH (one query, avoids N+1 across a
// task list)
// ==========================================

async function getTagsForTaskIds(taskIds) {

    if (!taskIds || taskIds.length === 0) {
        return {};
    }

    const placeholders = taskIds.map(() => "?").join(",");

    const [rows] = await pool.query(
        `
        SELECT tt.task_id, tg.id, tg.name
        FROM task_tags tt
        JOIN tags tg ON tg.id = tt.tag_id
        WHERE tt.task_id IN (${placeholders})
        ORDER BY tg.name
        `,
        taskIds
    );

    const byTaskId = {};

    for (const row of rows) {
        if (!byTaskId[row.task_id]) {
            byTaskId[row.task_id] = [];
        }
        byTaskId[row.task_id].push({ id: row.id, name: row.name });
    }

    return byTaskId;

}

// ==========================================
// ATTACH taskTags TO A LIST OF TASK OBJECTS
// (mutates and returns the same array; each task
// gets `taskTags: []` if it has none)
// ==========================================

async function attachTagsToTasks(tasks) {

    if (!tasks || tasks.length === 0) {
        return tasks;
    }

    const taskIds = tasks.map((t) => t.id);

    const byTaskId = await getTagsForTaskIds(taskIds);

    for (const task of tasks) {
        task.taskTags = byTaskId[task.id] || [];
    }

    return tasks;

}

// ==========================================
// SEARCH / LIST (autocomplete) -- name-only,
// no task/project/creator metadata exposed.
// ==========================================

async function searchTags(query) {

    const trimmed = (query || "").trim();

    if (trimmed) {

        const [rows] = await pool.query(
            `SELECT id, name FROM tags WHERE name LIKE ? ORDER BY name LIMIT 20`,
            [`%${trimmed}%`]
        );

        return rows;

    }

    const [rows] = await pool.query(
        `SELECT id, name FROM tags ORDER BY name LIMIT 100`
    );

    return rows;

}

module.exports = {
    MAX_TAG_LENGTH,
    MAX_TAGS_PER_TASK,
    normalizeTagNames,
    findOrCreateTags,
    setTaskTags,
    getTagsForTaskIds,
    attachTagsToTasks,
    searchTags,
};
