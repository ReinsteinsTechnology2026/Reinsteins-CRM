const pool = require("../config/db");

// ==========================================
// SHIFT SCHEDULE (Phase 17b)
//
// SHIFT SCHEDULE = what an employee is expected to work.
// ATTENDANCE (attendanceController.js, untouched) = what they
// actually did. Deliberately kept as two separate tables/features --
// this controller never reads or writes the "attendance" table.
//
// Tenant scoping: every query here runs through `pool` from
// config/db.js, the same AsyncLocalStorage-backed tenant-aware proxy
// every other controller in this codebase uses -- it always resolves
// to the CALLER's own tenant database (set by tenantProtect before
// this ever runs). There is no company_id column anywhere in this
// table (see the schema file comment) and no client-supplied tenant
// identifier is ever read -- tenant isolation comes entirely from
// which physical database this connection is pointed at.
// ==========================================

const VALID_STATUSES = ["working", "off", "leave"];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BULK_ENTRIES = 500;

// ==========================================
// SHARED VALIDATION
// Returns { error: "message" } or { clean: {...} }.
// ==========================================

function validateShiftInput(body, { partial = false } = {}) {
    const clean = {};

    if (!partial || body.status !== undefined) {
        const status = String(body.status || "").trim().toLowerCase();
        if (!VALID_STATUSES.includes(status)) {
            return { error: "Invalid status. Use working, off, or leave." };
        }
        clean.status = status;
    }

    if (!partial || body.startTime !== undefined) {
        clean.startTime = body.startTime ? String(body.startTime).trim() : null;
    }

    if (!partial || body.endTime !== undefined) {
        clean.endTime = body.endTime ? String(body.endTime).trim() : null;
    }

    if (clean.startTime && !TIME_PATTERN.test(clean.startTime)) {
        return { error: "Invalid start time. Use HH:MM (24-hour)." };
    }

    if (clean.endTime && !TIME_PATTERN.test(clean.endTime)) {
        return { error: "Invalid end time. Use HH:MM (24-hour)." };
    }

    // A row's effective status after this update determines whether
    // times are required -- for a partial PATCH that only touches
    // notes, status/startTime/endTime may all be absent from `clean`
    // entirely, in which case the caller merges against the existing
    // row before re-checking this invariant (see updateShift below).
    const effectiveStatus = clean.status !== undefined ? clean.status : body.__existingStatus;

    if (effectiveStatus === "working") {
        const effectiveStart = clean.startTime !== undefined ? clean.startTime : body.__existingStartTime;
        const effectiveEnd = clean.endTime !== undefined ? clean.endTime : body.__existingEndTime;

        if (!effectiveStart || !effectiveEnd) {
            return { error: "Start time and end time are required for a working shift." };
        }

        if (effectiveStart >= effectiveEnd) {
            return { error: "Start time must be before end time." };
        }
    } else if (effectiveStatus === "off" || effectiveStatus === "leave") {
        // OFF/LEAVE never carries a time range, regardless of what was
        // submitted -- clear it rather than reject, since a UI simply
        // switching the status dropdown shouldn't also require the
        // user to manually blank out two time fields.
        clean.startTime = null;
        clean.endTime = null;
    }

    if (!partial || body.notes !== undefined) {
        const notes = body.notes === undefined || body.notes === null ? null : String(body.notes).trim();
        clean.notes = notes ? notes.slice(0, 1000) : null;
    }

    return { clean };
}

async function userExistsInTenant(userId) {
    const [rows] = await pool.query(`SELECT id FROM users WHERE id = ? LIMIT 1`, [userId]);
    return rows.length > 0;
}

// ==========================================
// OWNERSHIP MODEL (corrected -- see route file header)
//
// The Shift Schedule is company-wide self-service: every tenant user
// manages their OWN schedule (req.user.id), regardless of
// system_access tier -- Employee through Executive are identical
// here. role='admin' or system_access in ('admin','super_admin') is
// the ONE explicit, narrow override this codebase's existing
// authorization architecture already treats as company-wide
// authority elsewhere (accessMiddleware.js's role==='admin' bypass;
// organizationController.js's setSystemAccess already lets
// system_access='admin' act on ANY employee's record) -- reusing
// that exact same boundary here, rather than also including
// hr/executive, keeps this consistent with what the rest of the app
// already considers "administrative" rather than inventing a new,
// wider one just for shifts.
//
// req.userAccess is set by accessMiddleware.js's requireAccess (here:
// requireActiveUser) BEFORE this controller ever runs -- it is a
// fresh, per-request DB read, never trusted from the JWT.
// ==========================================

function isAdminTier(req) {
    return req.userAccess?.role === "admin" || ["admin", "super_admin"].includes(req.userAccess?.systemAccess);
}

async function recordShiftHistory({ shiftScheduleId, userId, action, oldValue, updatedByUserId }) {
    // Snapshot fetched fresh here (rather than passed in from the
    // caller) so the history row always reflects exactly what is in
    // the database at the moment of the change, including for
    // "deleted" where oldValue is the caller's last-known row.
    await pool.query(
        `
        INSERT INTO shift_schedule_history
            (shift_schedule_id, user_id, action, old_value, new_value, changed_by)
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
            shiftScheduleId,
            userId,
            action,
            oldValue ? JSON.stringify(oldValue) : null,
            action === "deleted" ? null : JSON.stringify(oldValue?.__newSnapshot || oldValue),
            updatedByUserId,
        ]
    );
}

// ==========================================
// GET /api/shifts?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Any authenticated tenant user. Defaults to the current week
// (Monday-Sunday) when no range is given.
// ==========================================

const getShifts = async (req, res) => {
    try {
        let { startDate, endDate } = req.query;

        if (!startDate || !endDate) {
            const today = new Date();
            const dayOfWeek = today.getDay(); // 0 = Sunday
            const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

            const monday = new Date(today);
            monday.setDate(today.getDate() + diffToMonday);

            const sunday = new Date(monday);
            sunday.setDate(monday.getDate() + 6);

            const toIso = (d) => d.toISOString().slice(0, 10);
            startDate = toIso(monday);
            endDate = toIso(sunday);
        }

        if (!DATE_PATTERN.test(startDate) || !DATE_PATTERN.test(endDate)) {
            return res.status(400).json({
                success: false,
                message: "Invalid date range. Use YYYY-MM-DD for startDate and endDate.",
            });
        }

        if (startDate > endDate) {
            return res.status(400).json({
                success: false,
                message: "startDate must not be after endDate.",
            });
        }

        const [shifts] = await pool.query(
            `
            SELECT
                s.id,
                s.user_id,
                u.full_name,
                u.employee_id,
                u.designation,
                TO_CHAR(s.shift_date, 'YYYY-MM-DD') AS shift_date,
                s.status,
                s.start_time,
                s.end_time,
                s.notes,
                s.created_by,
                s.updated_by,
                s.created_at,
                s.updated_at
            FROM shift_schedules s
            JOIN users u ON u.id = s.user_id
            WHERE s.shift_date >= ? AND s.shift_date <= ?
            ORDER BY u.full_name ASC, s.shift_date ASC
            `,
            [startDate, endDate]
        );

        return res.status(200).json({
            success: true,
            startDate,
            endDate,
            shifts,
        });

    } catch (error) {
        console.error("Get Shifts Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load shift schedule",
        });
    }
};

// ==========================================
// POST /api/shifts
// ==========================================

const createShift = async (req, res) => {
    try {
        const { shiftDate } = req.body;
        const requestedUserId = req.body.userId;

        // Self-service by default: an omitted/blank userId (or one that
        // simply matches the caller) always means "my own schedule".
        // A DIFFERENT userId is only honored for the explicit
        // Admin/Super Admin override -- anyone else supplying one is
        // rejected outright rather than silently overridden, so a
        // frontend bug sending the wrong id fails loudly instead of
        // quietly writing to the wrong (but still just the caller's
        // own) row.
        let userId;

        if (requestedUserId === undefined || requestedUserId === null || requestedUserId === "" || Number(requestedUserId) === Number(req.user.id)) {
            userId = req.user.id;
        } else if (isAdminTier(req)) {
            userId = requestedUserId;
        } else {
            return res.status(403).json({
                success: false,
                message: "You can only create your own schedule entries.",
            });
        }

        if (!userId || !Number.isFinite(Number(userId))) {
            return res.status(400).json({ success: false, message: "A valid employee is required." });
        }

        if (!shiftDate || !DATE_PATTERN.test(shiftDate)) {
            return res.status(400).json({ success: false, message: "A valid date (YYYY-MM-DD) is required." });
        }

        // Also rejects any cross-tenant employee id outright -- this
        // query only ever sees rows in the CALLER's own tenant
        // database, so a user_id from another company simply does not
        // exist here.
        if (!(await userExistsInTenant(userId))) {
            return res.status(400).json({ success: false, message: "Employee not found in this company." });
        }

        const { error, clean } = validateShiftInput(req.body);
        if (error) {
            return res.status(400).json({ success: false, message: error });
        }

        const [existing] = await pool.query(
            `SELECT id FROM shift_schedules WHERE user_id = ? AND shift_date = ? LIMIT 1`,
            [userId, shiftDate]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: "This employee already has a shift entry for that date. Edit the existing entry instead.",
                existingId: existing[0].id,
            });
        }

        const [result] = await pool.query(
            `
            INSERT INTO shift_schedules
                (user_id, shift_date, status, start_time, end_time, notes, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING id
            `,
            [userId, shiftDate, clean.status, clean.startTime, clean.endTime, clean.notes, req.user.id, req.user.id]
        );

        const newId = result[0].id;

        await recordShiftHistory({
            shiftScheduleId: newId,
            userId,
            action: "created",
            oldValue: { shiftDate, ...clean },
            updatedByUserId: req.user.id,
        });

        return res.status(201).json({
            success: true,
            message: "Shift created successfully",
            id: newId,
        });

    } catch (error) {
        console.error("Create Shift Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to create shift",
        });
    }
};

// ==========================================
// PATCH /api/shifts/:id
// Only status/startTime/endTime/notes are editable -- moving a shift
// to a different employee/date is a delete + create (avoids having
// to re-run the duplicate-entry conflict check against a moving
// target).
// ==========================================

const updateShift = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(
            `SELECT id, user_id, shift_date, status, start_time, end_time, notes FROM shift_schedules WHERE id = ? LIMIT 1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Shift entry not found." });
        }

        const existingShift = rows[0];

        // Ownership check: loaded fresh from the tenant-scoped pool
        // above, never trusted from anything the client sent. Only the
        // row's own owner, or the explicit Admin/Super Admin override,
        // may modify it.
        if (Number(existingShift.user_id) !== Number(req.user.id) && !isAdminTier(req)) {
            return res.status(403).json({
                success: false,
                message: "You can only modify your own schedule.",
            });
        }

        const { error, clean } = validateShiftInput(
            {
                ...req.body,
                __existingStatus: existingShift.status,
                __existingStartTime: existingShift.start_time,
                __existingEndTime: existingShift.end_time,
            },
            { partial: true }
        );

        if (error) {
            return res.status(400).json({ success: false, message: error });
        }

        const merged = {
            status: clean.status !== undefined ? clean.status : existingShift.status,
            startTime: clean.startTime !== undefined ? clean.startTime : existingShift.start_time,
            endTime: clean.endTime !== undefined ? clean.endTime : existingShift.end_time,
            notes: clean.notes !== undefined ? clean.notes : existingShift.notes,
        };

        await pool.query(
            `
            UPDATE shift_schedules
            SET status = ?, start_time = ?, end_time = ?, notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            `,
            [merged.status, merged.startTime, merged.endTime, merged.notes, req.user.id, id]
        );

        await recordShiftHistory({
            shiftScheduleId: id,
            userId: existingShift.user_id,
            action: "updated",
            oldValue: {
                status: existingShift.status,
                startTime: existingShift.start_time,
                endTime: existingShift.end_time,
                notes: existingShift.notes,
                __newSnapshot: merged,
            },
            updatedByUserId: req.user.id,
        });

        return res.status(200).json({
            success: true,
            message: "Shift updated successfully",
        });

    } catch (error) {
        console.error("Update Shift Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to update shift",
        });
    }
};

// ==========================================
// DELETE /api/shifts/:id
// ==========================================

const deleteShift = async (req, res) => {
    try {
        const { id } = req.params;

        const [rows] = await pool.query(
            `SELECT id, user_id, TO_CHAR(shift_date, 'YYYY-MM-DD') AS shift_date, status, start_time, end_time, notes FROM shift_schedules WHERE id = ? LIMIT 1`,
            [id]
        );

        if (rows.length === 0) {
            return res.status(404).json({ success: false, message: "Shift entry not found." });
        }

        const existingShift = rows[0];

        if (Number(existingShift.user_id) !== Number(req.user.id) && !isAdminTier(req)) {
            return res.status(403).json({
                success: false,
                message: "You can only delete your own schedule.",
            });
        }

        // Recorded BEFORE the delete, not after: shift_schedule_id's FK
        // requires the row it references to exist AT INSERT TIME. The
        // column is nullable with ON DELETE SET NULL precisely so that
        // deleting the shift right after this then nulls out THIS same
        // history row's reference automatically -- the audit entry
        // survives, only the (now-meaningless) foreign key does not.
        await recordShiftHistory({
            shiftScheduleId: id,
            userId: existingShift.user_id,
            action: "deleted",
            oldValue: {
                shiftDate: existingShift.shift_date,
                status: existingShift.status,
                startTime: existingShift.start_time,
                endTime: existingShift.end_time,
                notes: existingShift.notes,
            },
            updatedByUserId: req.user.id,
        });

        await pool.query(`DELETE FROM shift_schedules WHERE id = ?`, [id]);

        return res.status(200).json({
            success: true,
            message: "Shift deleted successfully",
        });

    } catch (error) {
        console.error("Delete Shift Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to delete shift",
        });
    }
};

// ==========================================
// POST /api/shifts/bulk
// Weekly-grid save / "copy week" support -- upserts each entry
// (create if no row exists for that user+date, otherwise update).
// Bounded to MAX_BULK_ENTRIES to prevent an accidental/abusive
// oversized payload; each entry is validated the same way as the
// single-entry endpoints, and one bad entry does not abort the rest
// -- the response reports per-entry success/failure so the UI can
// show exactly what did and didn't save.
// ==========================================

const bulkSaveShifts = async (req, res) => {
    try {
        const { shifts } = req.body;

        if (!Array.isArray(shifts) || shifts.length === 0) {
            return res.status(400).json({ success: false, message: "No shift entries provided." });
        }

        if (shifts.length > MAX_BULK_ENTRIES) {
            return res.status(400).json({
                success: false,
                message: `Cannot save more than ${MAX_BULK_ENTRIES} entries at once.`,
            });
        }

        const results = [];
        const bulkIsAdminTier = isAdminTier(req);

        for (const entry of shifts) {
            const { userId, shiftDate } = entry || {};

            if (!userId || !Number.isFinite(Number(userId)) || !shiftDate || !DATE_PATTERN.test(shiftDate)) {
                results.push({ userId, shiftDate, success: false, message: "Invalid employee or date." });
                continue;
            }

            if (Number(userId) !== Number(req.user.id) && !bulkIsAdminTier) {
                results.push({ userId, shiftDate, success: false, message: "You can only save your own schedule entries." });
                continue;
            }

            if (!(await userExistsInTenant(userId))) {
                results.push({ userId, shiftDate, success: false, message: "Employee not found in this company." });
                continue;
            }

            const { error, clean } = validateShiftInput(entry);

            if (error) {
                results.push({ userId, shiftDate, success: false, message: error });
                continue;
            }

            const [existing] = await pool.query(
                `SELECT id, status, start_time, end_time, notes FROM shift_schedules WHERE user_id = ? AND shift_date = ? LIMIT 1`,
                [userId, shiftDate]
            );

            if (existing.length > 0) {
                const existingShift = existing[0];

                await pool.query(
                    `
                    UPDATE shift_schedules
                    SET status = ?, start_time = ?, end_time = ?, notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    `,
                    [clean.status, clean.startTime, clean.endTime, clean.notes, req.user.id, existingShift.id]
                );

                await recordShiftHistory({
                    shiftScheduleId: existingShift.id,
                    userId,
                    action: "updated",
                    oldValue: {
                        status: existingShift.status,
                        startTime: existingShift.start_time,
                        endTime: existingShift.end_time,
                        notes: existingShift.notes,
                        __newSnapshot: clean,
                    },
                    updatedByUserId: req.user.id,
                });

                results.push({ userId, shiftDate, success: true, id: existingShift.id, action: "updated" });

            } else {

                const [result] = await pool.query(
                    `
                    INSERT INTO shift_schedules
                        (user_id, shift_date, status, start_time, end_time, notes, created_by, updated_by)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    RETURNING id
                    `,
                    [userId, shiftDate, clean.status, clean.startTime, clean.endTime, clean.notes, req.user.id, req.user.id]
                );

                const newId = result[0].id;

                await recordShiftHistory({
                    shiftScheduleId: newId,
                    userId,
                    action: "created",
                    oldValue: { shiftDate, ...clean },
                    updatedByUserId: req.user.id,
                });

                results.push({ userId, shiftDate, success: true, id: newId, action: "created" });
            }
        }

        const failureCount = results.filter((r) => !r.success).length;

        return res.status(failureCount === results.length ? 400 : 200).json({
            success: failureCount === 0,
            message:
                failureCount === 0
                    ? "All shift entries saved successfully"
                    : `${results.length - failureCount} of ${results.length} entries saved; ${failureCount} failed`,
            results,
        });

    } catch (error) {
        console.error("Bulk Save Shifts Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to save shift entries",
        });
    }
};

module.exports = {
    getShifts,
    createShift,
    updateShift,
    deleteShift,
    bulkSaveShifts,
};
