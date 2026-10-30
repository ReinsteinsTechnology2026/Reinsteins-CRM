const { smartSheetRoom, userRoom } = require("../utils/socketRooms");
const { SmartSheetError, invalid } = require("../utils/smartSheetErrors");
const { parseSheetId, isPlainObject } = require("../utils/smartSheetValidation");
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
    const { code, message, status } = describeError(error);
    return { ok: false, code, message, status };
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
function registerSmartSheetHandlers({ io, socket, onTenantEvent, companySlug, service, rateLimit }) {
    const user = { id: socket.user.id, name: socket.user.fullName };
    socket.data.smartSheetUser = user;
    const allowOperation = makeRateLimiter(rateLimit && rateLimit.limit, rateLimit && rateLimit.windowMs);
    const joined = new Set();

    const leaveRoom = async (sheetId, { announce = true } = {}) => {
        const room = smartSheetRoom(companySlug, sheetId);
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
                if (!socket.rooms.has(smartSheetRoom(companySlug, openId))) joined.delete(openId);
            }

            if (!joined.has(sheetId) && joined.size >= MAX_JOINED_SHEETS_PER_SOCKET) {
                throw new SmartSheetError(429, "TOO_MANY_OPEN_SHEETS", "Too many spreadsheets are open in this tab.");
            }

            await service.authorizeJoin(user.id, sheetId);

            const room = smartSheetRoom(companySlug, sheetId);
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
            const room = smartSheetRoom(companySlug, sheetId);

            if (!joined.has(sheetId) || !socket.rooms.has(room)) {
                throw new SmartSheetError(409, "NOT_JOINED", "This spreadsheet is not open. Reload it to continue editing.");
            }
            if (!allowOperation()) {
                throw new SmartSheetError(429, "RATE_LIMITED", "You are making changes too quickly. Please slow down.");
            }

            // persist (inside applyOperation, after authorize + validate) -> then broadcast
            const result = await runExclusive(room, async () => {
                const saved = await service.applyOperation(user.id, sheetId, payload.op);
                socket.to(room).emit("smartsheet:op", {
                    sheetId,
                    revision: saved.revision,
                    op: saved.operation,
                    by: { id: user.id, name: user.name },
                });
                return saved;
            });

            reply(ack, { ok: true, revision: result.revision });
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
            const room = smartSheetRoom(companySlug, sheetId);
            getPresence(io, room, { excludeSocketId: socket.id })
                .then((users) => io.to(room).emit("smartsheet:presence", { sheetId, users }))
                .catch(() => {});
        }
    });
}

// ---- called by the REST controller after the database change committed ----

// One employee was unassigned: every socket that user has open leaves the room NOW.
async function evictUser(io, companySlug, sheetId, userId, reason = "unassigned") {
    const room = smartSheetRoom(companySlug, sheetId);
    const personal = userRoom(companySlug, userId);
    io.to(personal).emit("smartsheet:access-revoked", { sheetId: Number(sheetId), reason });
    io.in(personal).socketsLeave(room);
    await broadcastPresence(io, room, Number(sheetId));
}

// The sheet was archived or deleted: nobody stays in the room.
async function evictAll(io, companySlug, sheetId, reason = "closed") {
    const room = smartSheetRoom(companySlug, sheetId);
    io.to(room).emit("smartsheet:access-revoked", { sheetId: Number(sheetId), reason });
    io.in(room).socketsLeave(room);
}

// A grant changed (e.g. edit -> view): tell that user's open tabs, no eviction needed because every
// update is re-checked anyway.
function notifyAccessChanged(io, companySlug, sheetId, userId, permission) {
    io.to(userRoom(companySlug, userId)).emit("smartsheet:access-changed", { sheetId: Number(sheetId), permission });
}

module.exports = {
    registerSmartSheetHandlers,
    evictUser,
    evictAll,
    notifyAccessChanged,
    getPresence,
    runExclusive,
    MAX_JOINED_SHEETS_PER_SOCKET,
};
