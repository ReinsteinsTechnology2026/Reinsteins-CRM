const crypto = require("crypto");

const { LIMITS } = require("../utils/smartSheetValidation");
const { SmartSheetError, invalid } = require("../utils/smartSheetErrors");

// ==========================================
// SMART SHEETS -- POSTGRESQL STORE
//
// The only file that contains SQL for this feature. `pool` is the tenant-aware pool from
// config/db.js (the same Proxy every controller uses), so each call lands in the CALLER's tenant
// database via the ambient AsyncLocalStorage context -- including calls made from socket handlers,
// which app.js runs inside the socket's tenant context.
//
// CONCURRENCY / "LAST WRITE WINS"
// Every write runs in ONE transaction that starts by locking the spreadsheet's row
// (UPDATE smart_sheets SET revision = revision + 1 ... RETURNING revision). PostgreSQL therefore
// applies all writes to one spreadsheet strictly one after another; the revision a write receives
// is its position in that order. If two people change the same cell at the same moment, the
// transaction that got the HIGHER revision is the one whose value is stored and is also the last
// one broadcast, so every client converges on it. (Whole-cell replacement: the winner's cell
// replaces the loser's cell completely, formatting included.)
//
// A write is committed BEFORE the caller broadcasts it (smartSheetService.applyOperation returns
// only after commit); nothing here ever emits.
//
// The same interface is implemented in memory by _smart_sheets_test_support.js for the tests.
// ==========================================

const CELL_CHUNK = 2000;
const UNIQUE_VIOLATION = "23505";

const toNumber = (value) => (value === null || value === undefined ? value : Number(value));

function likePattern(text) {
    return `%${String(text).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function newWorksheetKey() {
    return `ws${crypto.randomBytes(8).toString("hex")}`;
}

function sheetRow(row) {
    return {
        id: row.id,
        name: row.name,
        status: row.status,
        revision: toNumber(row.revision),
        created_by: row.created_by ?? null,
        created_by_name: row.created_by_name ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at,
        deleted_at: row.deleted_at ?? null,
        source_file_name: row.source_file_name ?? null,
        assigned_count: row.assigned_count === undefined ? undefined : toNumber(row.assigned_count),
        permission: row.permission ?? undefined,
    };
}

async function withTransaction(pool, work) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const result = await work(connection);
        await connection.commit();
        return result;
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_rollbackError) {
            // report the original failure
        }
        throw error;
    } finally {
        connection.release();
    }
}

async function upsertCells(connection, { sheetId, worksheetId, cells, revision, userId }) {
    for (let start = 0; start < cells.length; start += CELL_CHUNK) {
        const chunk = cells.slice(start, start + CELL_CHUNK);
        await connection.query(
            `INSERT INTO smart_sheet_cells (worksheet_id, row_idx, col_idx, sheet_id, cell, revision, updated_by)
             SELECT ?::int, t.r, t.c, ?::int, t.cell::jsonb, ?::bigint, ?::int
             FROM unnest(?::int[], ?::int[], ?::text[]) AS t(r, c, cell)
             ON CONFLICT (worksheet_id, row_idx, col_idx)
             DO UPDATE SET cell = EXCLUDED.cell, revision = EXCLUDED.revision,
                           updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
            [
                worksheetId, sheetId, revision, userId,
                chunk.map((entry) => entry.r),
                chunk.map((entry) => entry.c),
                chunk.map((entry) => JSON.stringify(entry.cell)),
            ]
        );
    }
}

async function deleteCells(connection, { worksheetId, cells }) {
    for (let start = 0; start < cells.length; start += CELL_CHUNK) {
        const chunk = cells.slice(start, start + CELL_CHUNK);
        await connection.query(
            `DELETE FROM smart_sheet_cells
             WHERE worksheet_id = ?::int
               AND (row_idx, col_idx) IN (SELECT t.r, t.c FROM unnest(?::int[], ?::int[]) AS t(r, c))`,
            [worksheetId, chunk.map((entry) => entry.r), chunk.map((entry) => entry.c)]
        );
    }
}

function createPgStore({ pool }) {
    return {
        // The user's account row (role / system_access / employment_status), fresh from the DB.
        async getAccount(userId) {
            const [rows] = await pool.query(
                `SELECT id, role, system_access, employment_status FROM users WHERE id = ? LIMIT 1`,
                [userId]
            );
            return rows[0] || null;
        },

        // Everything resolveAccess() needs, in ONE round trip.
        async getAccessContext(userId, sheetId) {
            const [rows] = await pool.query(
                `SELECT u.id AS user_id, u.role, u.system_access, u.employment_status,
                        s.id AS sheet_id, s.name AS sheet_name, s.status AS sheet_status,
                        s.revision AS sheet_revision, s.deleted_at AS sheet_deleted_at,
                        a.permission AS assignment_permission
                 FROM users u
                 LEFT JOIN smart_sheets s ON s.id = ?
                 LEFT JOIN smart_sheet_access a ON a.sheet_id = s.id AND a.user_id = u.id
                 WHERE u.id = ?
                 LIMIT 1`,
                [sheetId, userId]
            );
            const row = rows[0];
            if (!row) {
                return { account: null, sheet: null, assignment: null };
            }
            return {
                account: { id: row.user_id, role: row.role, system_access: row.system_access, employment_status: row.employment_status },
                sheet: row.sheet_id
                    ? { id: row.sheet_id, name: row.sheet_name, status: row.sheet_status, revision: toNumber(row.sheet_revision), deleted_at: row.sheet_deleted_at }
                    : null,
                assignment: row.assignment_permission ? { permission: row.assignment_permission } : null,
            };
        },

        async listSheetsForAdmin() {
            const [rows] = await pool.query(
                `SELECT s.id, s.name, s.status, s.revision, s.created_by, s.created_at, s.updated_at,
                        s.source_file_name, u.full_name AS created_by_name,
                        (SELECT COUNT(*) FROM smart_sheet_access a WHERE a.sheet_id = s.id) AS assigned_count
                 FROM smart_sheets s
                 LEFT JOIN users u ON u.id = s.created_by
                 WHERE s.deleted_at IS NULL
                 ORDER BY s.updated_at DESC, s.id DESC`
            );
            return rows.map(sheetRow);
        },

        async listSheetsForUser(userId) {
            const [rows] = await pool.query(
                `SELECT s.id, s.name, s.status, s.revision, s.created_by, s.created_at, s.updated_at,
                        u.full_name AS created_by_name, a.permission
                 FROM smart_sheet_access a
                 JOIN smart_sheets s ON s.id = a.sheet_id
                 LEFT JOIN users u ON u.id = s.created_by
                 WHERE a.user_id = ? AND s.status = 'active' AND s.deleted_at IS NULL
                 ORDER BY s.updated_at DESC, s.id DESC`,
                [userId]
            );
            return rows.map(sheetRow);
        },

        async getSheet(sheetId) {
            const [rows] = await pool.query(
                `SELECT s.id, s.name, s.status, s.revision, s.created_by, s.created_at, s.updated_at,
                        s.deleted_at, s.source_file_name, u.full_name AS created_by_name
                 FROM smart_sheets s LEFT JOIN users u ON u.id = s.created_by
                 WHERE s.id = ? LIMIT 1`,
                [sheetId]
            );
            return rows[0] ? sheetRow(rows[0]) : null;
        },

        // worksheets: [{ name, rowCount, columnCount, cells:[{r,c,cell}], layout }]
        async createSheet({ name, userId, worksheets, source = null }) {
            return withTransaction(pool, async (connection) => {
                const [created] = await connection.query(
                    `INSERT INTO smart_sheets (name, created_by, updated_by, source_file_name, source_file_path)
                     VALUES (?, ?, ?, ?, ?) RETURNING id`,
                    [name, userId, userId, source ? source.fileName : null, source ? source.filePath : null]
                );
                const sheetId = created[0].id;

                for (let position = 0; position < worksheets.length; position += 1) {
                    const sheet = worksheets[position];
                    const [inserted] = await connection.query(
                        `INSERT INTO smart_sheet_worksheets (sheet_id, ws_key, name, position, row_count, column_count, layout)
                         VALUES (?, ?, ?, ?, ?, ?, ?::jsonb) RETURNING id`,
                        [
                            sheetId, newWorksheetKey(), sheet.name, position,
                            sheet.rowCount || LIMITS.DEFAULT_ROWS, sheet.columnCount || LIMITS.DEFAULT_COLUMNS,
                            JSON.stringify(sheet.layout || {}),
                        ]
                    );
                    if (sheet.cells && sheet.cells.length) {
                        await upsertCells(connection, {
                            sheetId, worksheetId: inserted[0].id, cells: sheet.cells, revision: 0, userId,
                        });
                    }
                }

                return sheetId;
            });
        },

        // Complete current state: { sheet, worksheets:[{ id, key, name, position, rowCount, columnCount, layout, cells }] }
        async loadWorkbook(sheetId) {
            const sheet = await this.getSheet(sheetId);
            if (!sheet) return null;

            const [worksheetRows] = await pool.query(
                `SELECT id, ws_key, name, position, row_count, column_count, layout
                 FROM smart_sheet_worksheets WHERE sheet_id = ? ORDER BY position, id`,
                [sheetId]
            );
            const [cellRows] = await pool.query(
                `SELECT worksheet_id, row_idx, col_idx, cell FROM smart_sheet_cells
                 WHERE sheet_id = ? ORDER BY worksheet_id, row_idx, col_idx`,
                [sheetId]
            );

            const byWorksheet = new Map();
            for (const row of cellRows) {
                if (!byWorksheet.has(row.worksheet_id)) byWorksheet.set(row.worksheet_id, []);
                byWorksheet.get(row.worksheet_id).push({ r: row.row_idx, c: row.col_idx, cell: row.cell });
            }

            return {
                sheet,
                worksheets: worksheetRows.map((row) => ({
                    id: row.id,
                    key: row.ws_key,
                    name: row.name,
                    position: row.position,
                    rowCount: row.row_count,
                    columnCount: row.column_count,
                    layout: row.layout || {},
                    cells: byWorksheet.get(row.id) || [],
                })),
            };
        },

        // fields: { name?, status? }
        async updateSheet(sheetId, fields, userId) {
            const sets = [];
            const params = [];
            if (fields.name !== undefined) { sets.push("name = ?"); params.push(fields.name); }
            if (fields.status !== undefined) { sets.push("status = ?"); params.push(fields.status); }
            if (sets.length === 0) return false;

            const [rows] = await pool.query(
                `UPDATE smart_sheets SET ${sets.join(", ")}, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND deleted_at IS NULL RETURNING id`,
                [...params, userId, sheetId]
            );
            return rows.length > 0;
        },

        async softDeleteSheet(sheetId, userId) {
            const [rows] = await pool.query(
                `UPDATE smart_sheets SET deleted_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND deleted_at IS NULL RETURNING id`,
                [userId, sheetId]
            );
            return rows.length > 0;
        },

        async listAccess(sheetId) {
            const [rows] = await pool.query(
                `SELECT a.user_id, a.permission, a.granted_at, u.full_name, u.employee_id, u.designation, u.employment_status
                 FROM smart_sheet_access a JOIN users u ON u.id = a.user_id
                 WHERE a.sheet_id = ? ORDER BY u.full_name, u.id`,
                [sheetId]
            );
            return rows;
        },

        // Only ACTIVE accounts can be assigned. Returns the user ids that were granted/updated.
        async grantAccess(sheetId, userIds, permission, grantedBy) {
            const [rows] = await pool.query(
                `INSERT INTO smart_sheet_access (sheet_id, user_id, permission, granted_by)
                 SELECT ?::int, u.id, ?, ?::int FROM users u
                 WHERE u.id = ANY(?::int[]) AND u.employment_status = 'active'
                 ON CONFLICT (sheet_id, user_id)
                 DO UPDATE SET permission = EXCLUDED.permission, granted_by = EXCLUDED.granted_by, granted_at = CURRENT_TIMESTAMP
                 RETURNING user_id`,
                [sheetId, permission, grantedBy, userIds]
            );
            return rows.map((row) => row.user_id);
        },

        async revokeAccess(sheetId, userId) {
            const [rows] = await pool.query(
                `DELETE FROM smart_sheet_access WHERE sheet_id = ? AND user_id = ? RETURNING id`,
                [sheetId, userId]
            );
            return rows.length > 0;
        },

        async searchEmployees(query, limit = 50) {
            const text = String(query || "").trim();
            const params = [];
            let where = `employment_status = 'active'`;
            if (text) {
                where += ` AND (full_name ILIKE ? OR employee_id ILIKE ? OR email ILIKE ?)`;
                const pattern = likePattern(text);
                params.push(pattern, pattern, pattern);
            }
            const [rows] = await pool.query(
                `SELECT id, full_name, employee_id, designation, email FROM users
                 WHERE ${where} ORDER BY full_name, id LIMIT ?`,
                [...params, limit]
            );
            return rows;
        },

        // Applies ONE validated operation and returns { revision } AFTER the transaction commits.
        async applyOperation(sheetId, userId, op) {
            try {
                return await withTransaction(pool, async (connection) => {
                    // Locks the spreadsheet row: all writes to this sheet are serialized here.
                    const [locked] = await connection.query(
                        `UPDATE smart_sheets SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ? AND status = 'active' AND deleted_at IS NULL RETURNING revision`,
                        [userId, sheetId]
                    );
                    if (locked.length === 0) {
                        throw new SmartSheetError(409, "SHEET_NOT_WRITABLE", "This spreadsheet is archived or no longer available.");
                    }
                    const revision = toNumber(locked[0].revision);

                    const findWorksheet = async () => {
                        const [rows] = await connection.query(
                            `SELECT id, name, row_count, column_count, layout FROM smart_sheet_worksheets
                             WHERE sheet_id = ? AND ws_key = ? LIMIT 1`,
                            [sheetId, op.ws]
                        );
                        if (!rows[0]) {
                            throw invalid("WORKSHEET_NOT_FOUND", "That worksheet no longer exists.");
                        }
                        return rows[0];
                    };

                    if (op.type === "cells") {
                        const worksheet = await findWorksheet();
                        const outside = op.cells.find((entry) => entry.r >= worksheet.row_count || entry.c >= worksheet.column_count);
                        if (outside) {
                            throw invalid("INVALID_CELL_COORDINATE", "A cell is outside this worksheet.");
                        }
                        await upsertCells(connection, {
                            sheetId, worksheetId: worksheet.id, cells: op.cells.filter((entry) => entry.cell !== null), revision, userId,
                        });
                        await deleteCells(connection, { worksheetId: worksheet.id, cells: op.cells.filter((entry) => entry.cell === null) });
                    } else if (op.type === "addWorksheet") {
                        const [existingKey] = await connection.query(
                            `SELECT 1 FROM smart_sheet_worksheets WHERE sheet_id = ? AND ws_key = ? LIMIT 1`, [sheetId, op.ws]
                        );
                        if (existingKey.length === 0) {
                            const [counts] = await connection.query(
                                `SELECT COUNT(*) AS total, COALESCE(MAX(position), -1) AS last_position
                                 FROM smart_sheet_worksheets WHERE sheet_id = ?`, [sheetId]
                            );
                            if (toNumber(counts[0].total) >= LIMITS.MAX_WORKSHEETS) {
                                throw invalid("TOO_MANY_WORKSHEETS", `A spreadsheet can have at most ${LIMITS.MAX_WORKSHEETS} worksheets.`);
                            }
                            const [sameName] = await connection.query(
                                `SELECT 1 FROM smart_sheet_worksheets WHERE sheet_id = ? AND lower(name) = lower(?) LIMIT 1`, [sheetId, op.name]
                            );
                            if (sameName.length) {
                                throw new SmartSheetError(409, "WORKSHEET_NAME_EXISTS", "A worksheet with that name already exists.");
                            }
                            const append = toNumber(counts[0].last_position) + 1;
                            const position = op.index === null ? append : Math.min(op.index, append);
                            await connection.query(
                                `UPDATE smart_sheet_worksheets SET position = position + 1 WHERE sheet_id = ? AND position >= ?`, [sheetId, position]
                            );
                            await connection.query(
                                `INSERT INTO smart_sheet_worksheets (sheet_id, ws_key, name, position, row_count, column_count)
                                 VALUES (?, ?, ?, ?, ?, ?)`,
                                [sheetId, op.ws, op.name, position, LIMITS.DEFAULT_ROWS, LIMITS.DEFAULT_COLUMNS]
                            );
                        }
                    } else if (op.type === "renameWorksheet") {
                        const worksheet = await findWorksheet();
                        const [sameName] = await connection.query(
                            `SELECT 1 FROM smart_sheet_worksheets WHERE sheet_id = ? AND lower(name) = lower(?) AND id <> ? LIMIT 1`,
                            [sheetId, op.name, worksheet.id]
                        );
                        if (sameName.length) {
                            throw new SmartSheetError(409, "WORKSHEET_NAME_EXISTS", "A worksheet with that name already exists.");
                        }
                        await connection.query(`UPDATE smart_sheet_worksheets SET name = ? WHERE id = ?`, [op.name, worksheet.id]);
                    } else if (op.type === "layout") {
                        const worksheet = await findWorksheet();
                        const layout = { columnWidths: {}, rowHeights: {}, ...(worksheet.layout || {}) };
                        layout.columnWidths = { ...(layout.columnWidths || {}) };
                        layout.rowHeights = { ...(layout.rowHeights || {}) };
                        for (const [key, value] of Object.entries(op.columnWidths)) {
                            if (value === null) delete layout.columnWidths[key]; else layout.columnWidths[key] = value;
                        }
                        for (const [key, value] of Object.entries(op.rowHeights)) {
                            if (value === null) delete layout.rowHeights[key]; else layout.rowHeights[key] = value;
                        }
                        await connection.query(`UPDATE smart_sheet_worksheets SET layout = ?::jsonb WHERE id = ?`, [JSON.stringify(layout), worksheet.id]);
                    }

                    return { revision };
                });
            } catch (error) {
                if (error && error.code === UNIQUE_VIOLATION) {
                    throw new SmartSheetError(409, "CONFLICT", "That change conflicts with another change. Reload the spreadsheet.");
                }
                throw error;
            }
        },
    };
}

module.exports = { createPgStore, newWorksheetKey };
