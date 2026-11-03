const { smartSheetRoom, userRoom } = require("../utils/socketRooms");
const { SmartSheetError, invalid } = require("../utils/smartSheetErrors");
const { LIMITS, parseSheetId, isPlainObject } = require("../utils/smartSheetValidation");
const { createWindowLimiter } = require("../utils/smartSheetLimiter");
const { describeError } = require("./smartSheetService");

// ==========================================
// SMART SHEETS -- REAL-TIME (Socket.IO)
//
// Client -> server events (each takes an optional ack callback):
//   smartsheet:join   { sheetId }                 -> ack { ok, permission, revision, users, ... }
//   smartsheet:leave  { sheetId }
//   smartsheet:op     { sheetId, op }             -> ack { ok, revision } | { ok:false, code, message }
// Server -> client events:
//   smartsheet:op              { sheetId, revision, op, by:{id,name} }   (to everyone else in the room)
//   smartsheet:presence        { sheetId, users:[{id,name}] }
//   smartsheet:access-revoked  { sheetId, reason }                       (sent to the user's own sockets)
//   smartsheet:access-changed  { sheetId, permission }
//
// THE RULES (each is enforced here and covered by _test_smart_sheets_realtime.js):
//   1. A socket is authenticated before any of this runs (io.use in app.js).
//   2. smartsheet:join re-reads the user's access from the database; no access -> not joined, and
//      the failure looks the same as "no such spreadsheet". Access is checked AGAIN after the
//      join, which closes the window in which an unassign could slip between check and join.
//   3. smartsheet:op re-reads access on EVERY update (service.applyOperation does authorize ->
//      validate -> persist), requires the socket to be in the room, and is rate-limited.
//   4. The change is broadcast ONLY after the database transaction committed. A failed save is
//      never announced.
//   4b. Writes are limited per SOCKET and per USER (summed over all of that user's sockets, keyed by database
//      scope + user id), in operations and in cells, so opening many tabs does not multiply the allowance.
//   4c. An operation may carry an opId. A repeat of an opId the server already saved (a client retry after a
//      lost acknowledgement or a dropped connection) is answered with the original revision and is NOT applied
//      or broadcast again, so a retry can never duplicate a change or overwrite a newer value.
//   5. Persist+broadcast is serialized per spreadsheet inside this process, so other clients see
//      changes in exactly the order the database committed them (the last one received is the
//      database's winner). This relies on one Node process -- the current deployment. Running
//      several processes would need a shared lock/ordering (e.g. the revision) in the adapter.
//   6. Unassigning an employee, archiving or deleting a sheet calls evictUser/evictAll, which
//      removes the sockets from the room immediately.
//
// Room names come only from socketRooms.js, so they carry the tenant slug and can never collide
// across companies.
// ==========================================

const OP_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const DEDUPE_TTL_MS = 10 * 60 * 1000;
const DEDUPE_MAX_ENTRIES = 20000;

// Remembers which opIds were already saved: key -> { revision, at }. Insertion-ordered, so the oldest go first.
function createOpDedupe({ ttlMs = DEDUPE_TTL_MS, max = DEDUPE_MAX_ENTRIES, now = Date.now } = {}) {
    const saved = new Map();
    return {
        get(key) {
            const entry = saved.get(key);
            if (!entry) return null;
            if (now() - entry.at > ttlMs) {
                saved.delete(key);
                return null;
            }
            return entry;
        },
        set(key, revision) {
            saved.delete(key);
            saved.set(key, { revision, at: now() });
            while (saved.size > max) saved.delete(saved.keys().next().value);
        },
        get size() {
            return saved.size;
        },
    };
}

function createUserLimits() {
    return {
        operations: createWindowLimiter({ limit: LIMITS.USER_OPERATIONS, windowMs: LIMITS.USER_OPERATION_WINDOW_MS }),
        cells: createWindowLimiter({ limit: LIMITS.USER_CELLS, windowMs: LIMITS.USER_CELLS_WINDOW_MS }),
    };
}

// Process-wide (one Node process serves every tenant); tests inject their own.
const defaultUserLimits = createUserLimits();
const defaultDedupe = createOpDedupe();

const MAX_JOINED_SHEETS_PER_SOCKET = 5;
const RATE_LIMIT_OPERATIONS = 300;
const RATE_LIMIT_WINDOW_MS = 10 * 1000;

// Per-spreadsheet FIFO queue (single process).
const queues = new Map();

function runExclusive(key, task) {
    const previous = queues.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => {
        if (queues.get(key) === tail) queues.delete(key);
    });
    return run;
}

function reply(ack, body) {
    if (typeof ack === "function") {
        try {
            ack(body);
        } catch (_error) {
            // a misbehaving client callback must not break the server
        }
    }
}

function failure(error) {
    return { ok: false, ...describeError(error) };
}

// Everyone currently in the room, one entry per person (several tabs collapse to one).
async function getPresence(io, room, { excludeSocketId } = {}) {
    const sockets = await io.in(room).fetchSockets();
    const people = new Map();
    for (const remote of sockets) {
        if (remote.id === excludeSocketId) continue;
        const person = remote.data && remote.data.smartSheetUser;
        if (person) people.set(String(person.id), { id: person.id, name: person.name });
    }
    return [...people.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function broadcastPresence(io, room, sheetId, options) {
    const users = await getPresence(io, room, options);
    io.to(room).emit("smartsheet:presence", { sheetId, users });
    return users;
}

function makeRateLimiter(limit = RATE_LIMIT_OPERATIONS, windowMs = RATE_LIMIT_WINDOW_MS) {
    let windowStart = Date.now();
    let count = 0;
    return () => {
        const now = Date.now();
        if (now - windowStart >= windowMs) {
            windowStart = now;
            count = 0;
        }
        count += 1;
        return count <= limit;
    };
}

// Registers the three events on one connected socket. `onTenantEvent` is app.js's wrapper that
// runs the handler inside the socket's tenant database context (so the store resolves to the right
// tenant); tests pass a plain socket.on adapter.
function registerSmartSheetHandlers({
    io, socket, onTenantEvent, roomScope, service, rateLimit,
    userLimits = defaultUserLimits, dedupe = defaultDedupe,
}) {
    const user = { id: socket.user.id, name: socket.user.fullName };
    socket.data.smartSheetUser = user;
    const allowOperation = makeRateLimiter(rateLimit && rateLimit.limit, rateLimit && rateLimit.windowMs);
    const joined = new Set();

    const leaveRoom = async (sheetId, { announce = true } = {}) => {
        const room = smartSheetRoom(roomScope, sheetId);
        joined.delete(sheetId);
        await socket.leave(room);
        if (announce) await broadcastPresence(io, room, sheetId);
    };

    onTenantEvent("smartsheet:join", async (payload, ack) => {
        try {
            if (!isPlainObject(payload)) throw invalid("INVALID_SHEET_ID", "Invalid spreadsheet id.");
            const sheetId = parseSheetId(payload.sheetId);

            // Forget sheets this socket was removed from (unassigned / archived) before counting.
            for (const openId of [...joined]) {
                if (!socket.rooms.has(smartSheetRoom(roomScope, openId))) joined.delete(openId);
            }

            if (!joined.has(sheetId) && joined.size >= MAX_JOINED_SHEETS_PER_SOCKET) {
                throw new SmartSheetError(429, "TOO_MANY_OPEN_SHEETS", "Too many spreadsheets are open in this tab.");
            }

            await service.authorizeJoin(user.id, sheetId);

            const room = smartSheetRoom(roomScope, sheetId);
            await socket.join(room);
            joined.add(sheetId);

            // Close the check-then-join window: an unassign committed in between must not leave this
            // socket in the room.
            let info;
            try {
                info = await service.authorizeJoin(user.id, sheetId);
            } catch (error) {
                await leaveRoom(sheetId, { announce: false });
                throw error;
            }

            const users = await broadcastPresence(io, room, sheetId);
            reply(ack, { ok: true, sheetId, permission: info.permission, canManage: info.canManage, revision: info.revision, users });
        } catch (error) {
            reply(ack, failure(error));
        }
    });

    onTenantEvent("smartsheet:leave", async (payload, ack) => {
        try {
            if (isPlainObject(payload)) {
                const sheetId = parseSheetId(payload.sheetId);
                if (joined.has(sheetId)) await leaveRoom(sheetId);
            }
            reply(ack, { ok: true });
        } catch (error) {
            reply(ack, failure(error));
        }
    });

    onTenantEvent("smartsheet:op", async (payload, ack) => {
        try {
            if (!isPlainObject(payload)) throw invalid("INVALID_OPERATION", "Invalid change.");
            const sheetId = parseSheetId(payload.sheetId);
            const room = smartSheetRoom(roomScope, sheetId);

            if (!joined.has(sheetId) || !socket.rooms.has(room)) {
                throw new SmartSheetError(409, "NOT_JOINED", "This spreadsheet is not open. Reload it to continue editing.");
            }
            if (!allowOperation()) {
                throw new SmartSheetError(429, "RATE_LIMITED", "You are making changes too quickly. Please slow down.", { retryAfterMs: 2000 });
            }

            // Per-USER limits across all of this user's sockets (a new tab does not get a fresh allowance).
            const userKey = `${roomScope}:${user.id}`;
            const operationsAllowance = userLimits.operations.hit(userKey);
            const cellCount = payload.op && Array.isArray(payload.op.cells) ? Math.min(payload.op.cells.length, LIMITS.MAX_CELLS_PER_OPERATION + 1) : 0;
            const cellsAllowance = cellCount > 0 ? userLimits.cells.hit(userKey, cellCount) : { allowed: true };
            if (!operationsAllowance.allowed || !cellsAllowance.allowed) {
                const retryAfterMs = Math.max(operationsAllowance.retryAfterMs || 0, cellsAllowance.retryAfterMs || 0);
                throw new SmartSheetError(429, "RATE_LIMITED", "You are making changes too quickly. Please slow down.", { retryAfterMs });
            }

            // Optional idempotency key (see rule 4c).
            let dedupeKey = null;
            if (payload.opId !== undefined) {
                if (typeof payload.opId !== "string" || !OP_ID_PATTERN.test(payload.opId)) {
                    throw invalid("INVALID_OPERATION", "Invalid change.");
                }
                dedupeKey = `${roomScope}:${sheetId}:${user.id}:${payload.opId}`;
            }

            // persist (inside applyOperation, after authorize + validate) -> then broadcast
            const result = await runExclusive(room, async () => {
                const prior = dedupeKey && dedupe.get(dedupeKey);
                if (prior) return { revision: prior.revision, duplicate: true }; // already saved: answer, do not redo
                const saved = await service.applyOperation(user.id, sheetId, payload.op);
                if (dedupeKey) dedupe.set(dedupeKey, saved.revision);
                socket.to(room).emit("smartsheet:op", {
                    sheetId,
                    revision: saved.revision,
                    op: saved.operation,
                    by: { id: user.id, name: user.name },
                });
                return saved;
            });

            reply(ack, result.duplicate ? { ok: true, revision: result.revision, duplicate: true } : { ok: true, revision: result.revision });
        } catch (error) {
            // Lost access mid-session: drop the socket from the room too.
            if (error instanceof SmartSheetError && error.code === "NOT_FOUND") {
                const sheetId = Number(payload && payload.sheetId);
                if (joined.has(sheetId)) {
                    await leaveRoom(sheetId).catch(() => {});
                }
                socket.emit("smartsheet:access-revoked", { sheetId, reason: "no_access" });
            }
            reply(ack, failure(error));
        }
    });

    socket.on("disconnecting", () => {
        for (const sheetId of joined) {
            const room = smartSheetRoom(roomScope, sheetId);
            getPresence(io, room, { excludeSocketId: socket.id })
                .then((users) => io.to(room).emit("smartsheet:presence", { sheetId, users }))
                .catch(() => {});
        }
    });
}

// ---- called by the REST controller after the database change committed ----

// One employee was unassigned: every socket that user has open leaves the room NOW.
async function evictUser(io, roomScope, sheetId, userId, reason = "unassigned") {
    const room = smartSheetRoom(roomScope, sheetId);
    const personal = userRoom(roomScope, userId);
    io.to(personal).emit("smartsheet:access-revoked", { sheetId: Number(sheetId), reason });
    io.in(personal).socketsLeave(room);
    await broadcastPresence(io, room, Number(sheetId));
}

// The sheet was archived or deleted: nobody stays in the room.
async function evictAll(io, roomScope, sheetId, reason = "closed") {
    const room = smartSheetRoom(roomScope, sheetId);
    io.to(room).emit("smartsheet:access-revoked", { sheetId: Number(sheetId), reason });
    io.in(room).socketsLeave(room);
}

// A grant changed (e.g. edit -> view): tell that user's open tabs, no eviction needed because every
// update is re-checked anyway.
function notifyAccessChanged(io, roomScope, sheetId, userId, permission) {
    io.to(userRoom(roomScope, userId)).emit("smartsheet:access-changed", { sheetId: Number(sheetId), permission });
}

module.exports = {
    registerSmartSheetHandlers,
    createUserLimits,
    createOpDedupe,
    evictUser,
    evictAll,
    notifyAccessChanged,
    getPresence,
    runExclusive,
    MAX_JOINED_SHEETS_PER_SOCKET,
};
