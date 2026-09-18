const pool = require("../config/db");

// ==========================================
// WORK ITEM CODE GENERATION
//
// Backend-generated, concurrency-safe, never-manually-entered,
// never-duplicating, edit-stable identifiers for Epic/Feature/User
// Story (EPIC-001/FEAT-001/US-001) and Task (TASK-001, display-only --
// see taskCode() below).
//
// Same proven pattern as employeeController.js's
// generateNextIdentifier (Phase 17c): a regex-anchored lookup with an
// EXPLICIT ::integer cast on the SUBSTRING start position (without it,
// PostgreSQL's parameter-type inference silently breaks the ORDER BY
// once 2+ matching rows exist -- see that function's own comment for
// the full story). Sequences are per-tenant (company-wide), not
// per-project, so a code is unambiguous across every project in the
// tenant.
// ==========================================

const CODE_CONFIGS = {
    epic: { table: "epics", column: "epic_code", prefix: "EPIC" },
    feature: { table: "features", column: "feature_code", prefix: "FEAT" },
    user_story: { table: "user_stories", column: "story_code", prefix: "US" },
};

async function generateNextCode(type) {

    const config = CODE_CONFIGS[type];

    if (!config) {
        throw new Error(`Unknown work item type for code generation: ${type}`);
    }

    const { table, column, prefix } = config;

    const [rows] = await pool.query(
        `
        SELECT ${column}
        FROM ${table}
        WHERE ${column} ~ ?
        ORDER BY CAST(SUBSTRING(${column}, ?::integer) AS INTEGER) DESC
        LIMIT 1
        `,
        [`^${prefix}-[0-9]+$`, prefix.length + 2]
    );

    const highestNumber = rows.length > 0
        ? parseInt(String(rows[0][column]).slice(prefix.length + 1), 10)
        : 0;

    return `${prefix}-${String(highestNumber + 1).padStart(3, "0")}`;

}

// ==========================================
// CREATE-WITH-RETRY
// epic_code/feature_code/story_code are UNIQUE-constrained -- on a
// 23505 conflict (two concurrent creates racing for the same next
// number), regenerate and retry. Mirrors the retry-on-23505 loop
// employeeController.js's createEmployee/convertInternToEmployee
// already use around generateNextIdentifier for exactly the same
// reason.
// ==========================================

async function createWithGeneratedCode(type, insertFn) {

    const MAX_ATTEMPTS = 5;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {

        const code = await generateNextCode(type);

        try {

            return await insertFn(code);

        } catch (error) {

            if (error.code === "23505" && attempt < MAX_ATTEMPTS) {
                continue;
            }

            throw error;

        }

    }

}

// ==========================================
// TASK NUMBER GENERATION
//
// Fixes the pre-existing bug in taskService.createTask /
// userStoryService.createTaskForUserStory: both previously read
// `ORDER BY id DESC LIMIT 1` and assumed the most-recently-INSERTED
// row also held the highest task_number -- wrong the moment a task is
// deleted, or the legacy free-text task_number entry point
// (taskController.js, unrelated to TechOps, intentionally left
// untouched) stores a non-sequential value. This instead takes the
// MAX over every row whose task_number is purely numeric, which is
// correct regardless of insertion/deletion order.
//
// The stored value stays a bare number (e.g. "47"), unchanged for
// every existing task -- see taskCode() below for the "TASK-XXX"
// *display* format, applied only to project-linked tasks so the
// legacy non-project flow's task_number values are never touched or
// reinterpreted.
// ==========================================

async function generateNextTaskNumber() {

    const [rows] = await pool.query(`
        SELECT task_number
        FROM tasks
        WHERE task_number ~ '^[0-9]+$'
        ORDER BY CAST(task_number AS INTEGER) DESC
        LIMIT 1
    `);

    const highestNumber = rows.length > 0 ? parseInt(rows[0].task_number, 10) : 0;

    return String(highestNumber + 1);

}

// ==========================================
// TASK DISPLAY CODE
// "TASK-001" for a project-linked task with a numeric task_number;
// null otherwise (legacy non-project tasks keep displaying their raw
// task_number, unchanged, wherever the frontend already does that).
// ==========================================

function taskCode(task) {

    if (!task || !task.project_id || task.task_number == null) {
        return null;
    }

    const numeric = String(task.task_number);

    if (!/^[0-9]+$/.test(numeric)) {
        return null;
    }

    return `TASK-${numeric.padStart(3, "0")}`;

}

module.exports = {
    generateNextCode,
    createWithGeneratedCode,
    generateNextTaskNumber,
    taskCode,
};
