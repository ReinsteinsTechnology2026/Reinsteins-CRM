const pool = require("../config/db");

const MAX_TAG_LENGTH = 50;
const MAX_TAGS_PER_TASK = 10;

// ==========================================
// VALIDATE + NORMALIZE
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
            const error = new Error(
                `Tag "${trimmed.slice(0, 20)}..." exceeds the ${MAX_TAG_LENGTH}-character limit`
            );
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
        const error = new Error(
            `A task can have at most ${MAX_TAGS_PER_TASK} tags`
        );
        error.name = "TagValidationError";
        throw error;
    }

    return normalized;
}

// ==========================================
// FIND OR CREATE
// PostgreSQL version.
//
// INSERT ... ON CONFLICT handles concurrent
// requests safely.
//
// RETURNING gives us the row ID directly,
// replacing MySQL LAST_INSERT_ID().
// ==========================================

async function findOrCreateTags(names) {

    const results = [];

    for (const name of names) {

        const [rows] = await pool.query(
            `
            INSERT INTO tags (name)
            VALUES (?)
            ON CONFLICT (name)
            DO UPDATE SET name = EXCLUDED.name
            RETURNING id, name
            `,
            [name]
        );

        results.push(rows[0]);
    }

    return results;
}

// ==========================================
// SET TASK TAGS
// Replace all tags for the task.
// ==========================================

async function setTaskTags(taskId, rawNames) {

    const names = normalizeTagNames(rawNames);

    const tags = await findOrCreateTags(names);

    await pool.query(
        `DELETE FROM task_tags WHERE task_id = ?`,
        [taskId]
    );

    if (tags.length === 0) {
        return [];
    }

    for (const tag of tags) {

        await pool.query(
            `
            INSERT INTO task_tags (task_id, tag_id)
            VALUES (?, ?)
            ON CONFLICT (task_id, tag_id)
            DO NOTHING
            `,
            [taskId, tag.id]
        );
    }

    return tags;
}

// ==========================================
// BATCH FETCH
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

        byTaskId[row.task_id].push({
            id: row.id,
            name: row.name
        });
    }

    return byTaskId;
}

// ==========================================
// ATTACH taskTags TO TASK OBJECTS
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
// SEARCH / LIST
// ==========================================

async function searchTags(query) {

    const trimmed = (query || "").trim();

    if (trimmed) {

        const [rows] = await pool.query(
            `
            SELECT id, name
            FROM tags
            WHERE name ILIKE ?
            ORDER BY name
            LIMIT 20
            `,
            [`%${trimmed}%`]
        );

        return rows;
    }

    const [rows] = await pool.query(
        `
        SELECT id, name
        FROM tags
        ORDER BY name
        LIMIT 100
        `
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
