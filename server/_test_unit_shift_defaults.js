// Unit tests for the weekend-default-OFF rule and the shift:updated
// real-time broadcast. No database is needed: pool.query is replaced
// with a FIFO queue of canned responses matching the exact, linear
// query sequence each handler issues on its happy path. Run with:
//   node --test server/_test_unit_shift_defaults.js

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const db = require("./config/db");
const { isWeekendDate, computeDefaultOffDates, resolveShiftRoomPlan } = require("./utils/shiftDefaults");
const { shiftRoom, userRoom } = require("./utils/socketRooms");
const shiftController = require("./controllers/shiftScheduleController");

function installQueue(responses) {
  const queue = [...responses];
  db.query = async () => {
    if (queue.length === 0) throw new Error("unexpected extra pool.query call -- queue exhausted");
    return queue.shift();
  };
}

// Mimics Socket.IO's real chaining shape (io.to(a).to(b).emit(...)
// targets the UNION of a and b) closely enough to assert on: each
// .to() call accumulates one more room before emit() records the
// full set reached by that one call.
function fakeIo() {
  const calls = [];
  function broadcaster(rooms) {
    return {
      to(room) { return broadcaster([...rooms, room]); },
      emit(event, payload) { calls.push({ rooms, event, payload }); },
    };
  }
  return {
    calls,
    io: { to(room) { return broadcaster([room]); } },
  };
}

function makeReq(overrides = {}) {
  const { io } = fakeIo();
  return {
    user: { id: 1 },
    userAccess: { role: "admin", systemAccess: "super_admin" },
    query: {},
    params: {},
    body: {},
    app: { get: () => io },
    ...overrides,
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe("isWeekendDate / computeDefaultOffDates", () => {
  test("Saturday and Sunday are weekend dates", () => {
    assert.equal(isWeekendDate("2026-10-10"), true);  // Saturday
    assert.equal(isWeekendDate("2026-10-11"), true);  // Sunday
  });

  test("Monday through Friday are not weekend dates", () => {
    for (const d of ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]) {
      assert.equal(isWeekendDate(d), false, `${d} should not be a weekend date`);
    }
  });

  test("computeDefaultOffDates returns exactly the Sat/Sun dates in range, across a month boundary", () => {
    // 2026-10-26 (Mon) .. 2026-11-01 (Sun)
    const result = computeDefaultOffDates("2026-10-26", "2026-11-01");
    assert.deepEqual(result, ["2026-10-31", "2026-11-01"]);
  });
});

describe("getShifts includes defaultOffDates", () => {
  test("response defaultOffDates matches the computed weekend dates for the range", async () => {
    installQueue([[[]]]); // the one SELECT shifts query -- no rows
    const req = makeReq({ query: { startDate: "2026-10-05", endDate: "2026-10-11" } });
    const res = makeRes();

    await shiftController.getShifts(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.defaultOffDates, computeDefaultOffDates("2026-10-05", "2026-10-11"));
    assert.deepEqual(res.body.defaultOffDates, ["2026-10-10", "2026-10-11"]);
  });
});

describe("searchShiftEmployees defaults a weekend date with no row to OFF", () => {
  test("no row on a Saturday reports status off, isDefaultOff true", async () => {
    installQueue([
      [[{ id: 5, full_name: "Demo", employee_id: "E5", designation: "Dev", department_id: null, department_name: null }]],
      [[]], // no shift row for that date
    ]);
    const req = makeReq({ query: { q: "Demo", date: "2026-10-10" } });
    const res = makeRes();

    await shiftController.searchShiftEmployees(req, res);

    assert.equal(res.body.results[0].status, "off");
    assert.equal(res.body.results[0].isDefaultOff, true);
  });

  test("no row on a weekday reports status null, isDefaultOff false", async () => {
    installQueue([
      [[{ id: 5, full_name: "Demo", employee_id: "E5", designation: "Dev", department_id: null, department_name: null }]],
      [[]],
    ]);
    const req = makeReq({ query: { q: "Demo", date: "2026-10-07" } });
    const res = makeRes();

    await shiftController.searchShiftEmployees(req, res);

    assert.equal(res.body.results[0].status, null);
    assert.equal(res.body.results[0].isDefaultOff, false);
  });

  test("an explicit weekend row is reported as-is, not as a default", async () => {
    installQueue([
      [[{ id: 5, full_name: "Demo", employee_id: "E5", designation: "Dev", department_id: null, department_name: null }]],
      [[{ user_id: 5, status: "working", start_time: "09:00", end_time: "13:00", notes: null }]],
    ]);
    const req = makeReq({ query: { q: "Demo", date: "2026-10-10" } });
    const res = makeRes();

    await shiftController.searchShiftEmployees(req, res);

    assert.equal(res.body.results[0].status, "working");
    assert.equal(res.body.results[0].isDefaultOff, false);
  });
});

describe("createShift broadcasts shift:updated only after a successful write", () => {
  test("success: broadcasts once, after persistence, to the tenant shift room", async () => {
    installQueue([
      [[{ id: 1 }]], // userExistsInTenant
      [[]],          // duplicate check: none
      [[{ id: 101 }]], // INSERT ... RETURNING id
      [[]],          // history insert
    ]);
    const { io, calls } = fakeIo();
    const req = makeReq({
      body: { shiftDate: "2026-10-10", status: "working", startTime: "09:00", endTime: "13:00", notes: "On-site client visit" },
      app: { get: () => io },
    });
    const res = makeRes();

    await shiftController.createShift(req, res);

    assert.equal(res.statusCode, 201);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      [...calls[0].rooms].sort(),
      [userRoom("reinsteins", 1), shiftRoom("reinsteins")].sort()
    );
    assert.equal(calls[0].event, "shift:updated");
    assert.deepEqual(calls[0].payload, {
      action: "created",
      id: 101,
      userId: 1,
      shiftDate: "2026-10-10",
      status: "working",
      startTime: "09:00",
      endTime: "13:00",
      notes: "On-site client visit",
    });
  });

  test("validation failure: no broadcast", async () => {
    installQueue([[[{ id: 1 }]]]); // userExistsInTenant only -- validation fails before any further query
    const { io, calls } = fakeIo();
    const req = makeReq({
      body: { shiftDate: "2026-10-10", status: "not-a-real-status" },
      app: { get: () => io },
    });
    const res = makeRes();

    await shiftController.createShift(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(calls.length, 0);
  });

  test("duplicate-entry conflict: no broadcast", async () => {
    installQueue([
      [[{ id: 1 }]],      // userExistsInTenant
      [[{ id: 55 }]],     // duplicate check: an existing row
    ]);
    const { io, calls } = fakeIo();
    const req = makeReq({
      body: { shiftDate: "2026-10-10", status: "off" },
      app: { get: () => io },
    });
    const res = makeRes();

    await shiftController.createShift(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(calls.length, 0);
  });
});

describe("updateShift broadcasts the merged values after a successful write", () => {
  test("success: broadcasts the post-merge status/time/notes, keyed by the row's own date", async () => {
    installQueue([
      [[{ id: 7, user_id: 1, shift_date: "2026-10-10", status: "working", start_time: "09:00", end_time: "13:00", notes: "Covering for Priya" }]],
      [[]], // UPDATE
      [[]], // history insert
    ]);
    const { io, calls } = fakeIo();
    const req = makeReq({
      params: { id: "7" },
      body: { status: "off" }, // notes omitted -- must be preserved from the existing row
      app: { get: () => io },
    });
    const res = makeRes();

    await shiftController.updateShift(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].payload, {
      action: "updated",
      id: 7,
      userId: 1,
      shiftDate: "2026-10-10",
      status: "off",
      startTime: null,
      endTime: null,
      notes: "Covering for Priya",
    });
  });

  test("not found: no broadcast", async () => {
    installQueue([[[]]]); // SELECT finds nothing
    const { io, calls } = fakeIo();
    const req = makeReq({ params: { id: "999" }, body: { status: "off" }, app: { get: () => io } });
    const res = makeRes();

    await shiftController.updateShift(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0);
  });
});

describe("deleteShift broadcasts after the row is removed", () => {
  test("success: broadcasts a deleted event with no status/time fields", async () => {
    installQueue([
      [[{ id: 9, user_id: 1, shift_date: "2026-10-10", status: "working", start_time: "09:00", end_time: "13:00", notes: null }]],
      [[]], // history insert (before delete)
      [[]], // DELETE
    ]);
    const { io, calls } = fakeIo();
    const req = makeReq({ params: { id: "9" }, app: { get: () => io } });
    const res = makeRes();

    await shiftController.deleteShift(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].payload, { action: "deleted", id: 9, userId: 1, shiftDate: "2026-10-10" });
  });
});

describe("bulkSaveShifts broadcasts per successful entry only", () => {
  test("one created, one updated, one invalid: exactly two broadcasts", async () => {
    installQueue([
      // entry 1 (new): userExistsInTenant, existing-check (none), INSERT, history
      [[{ id: 1 }]],
      [[]],
      [[{ id: 201 }]],
      [[]],
      // entry 2 (existing): userExistsInTenant, existing-check (found), UPDATE, history
      [[{ id: 1 }]],
      [[{ id: 202, status: "working", start_time: "09:00", end_time: "13:00", notes: null }]],
      [[]],
      [[]],
    ]);
    const { io, calls } = fakeIo();
    const req = makeReq({
      body: {
        shifts: [
          { userId: 1, shiftDate: "2026-10-05", status: "off" },
          { userId: 1, shiftDate: "2026-10-06", status: "off" },
          { userId: 1, shiftDate: "", status: "off" }, // invalid: no date
        ],
      },
      app: { get: () => io },
    });
    const res = makeRes();

    await shiftController.bulkSaveShifts(req, res);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].payload.action, "created");
    assert.equal(calls[1].payload.action, "updated");
    assert.equal(res.body.results.filter((r) => !r.success).length, 1);
  });
});

describe("tenant isolation of the broadcast room", () => {
  test("room name is built from the ambient tenant context, defaulting to reinsteins", async () => {
    installQueue([
      [[{ id: 1 }]],
      [[]],
      [[{ id: 301 }]],
      [[]],
    ]);
    const { io, calls } = fakeIo();
    const req = makeReq({
      body: { shiftDate: "2026-10-10", status: "off" },
      app: { get: () => io },
    });

    await db.__runWithTenantContext({ companySlug: "acmeco", tenantPool: null }, async () => {
      await shiftController.createShift(req, makeRes());
    });

    assert.deepEqual([...calls[0].rooms].sort(), ["tenant:acmeco:shifts", "tenant:acmeco:user:1"].sort());
    assert.ok(!calls[0].rooms.includes(shiftRoom("reinsteins")), "must not reach the reinsteins room");
    assert.ok(!calls[0].rooms.includes(userRoom("reinsteins", 1)), "must not reach a reinsteins user room");
  });
});

// ==========================================
// REALTIME RECIPIENT AUTHORIZATION
// Mirrors app.js's connect-time room plan (resolveShiftRoomPlan) and
// shiftScheduleController.js's broadcast targeting (userRoom(affected
// user) + the broad shiftRoom) without needing a live Socket.IO
// server: simulateRoomsJoined reproduces exactly what app.js computes
// for a given socket's role/team, and wouldReceive checks that set
// against the exact two rooms broadcastShiftUpdate always targets.
// Together they prove end-to-end delivery, the same way the server
// itself computes it in two separate places.
// ==========================================

describe("realtime recipient authorization (manager/admin/tenant scoping)", () => {
  // Every socket always joins its own personal room, unconditionally,
  // regardless of tier (app.js, pre-existing code this task did not
  // change) -- simulateRoomsJoined models that plus whatever
  // resolveShiftRoomPlan adds on top.
  function simulateRoomsJoined(user, companySlug, directReportIds = []) {
    const rooms = new Set([userRoom(companySlug, user.id)]);
    const plan = resolveShiftRoomPlan(user, directReportIds);
    if (plan.joinBroadRoom) rooms.add(shiftRoom(companySlug));
    for (const watchedId of plan.watchUserIds) rooms.add(userRoom(companySlug, watchedId));
    return rooms;
  }

  function broadcastTargets(companySlug, affectedUserId) {
    return [userRoom(companySlug, affectedUserId), shiftRoom(companySlug)];
  }

  function wouldReceive(joinedRooms, targetRooms) {
    return targetRooms.some((room) => joinedRooms.has(room));
  }

  const SLUG = "acme";
  const admin = { id: 1, role: "admin", systemAccess: "employee" };
  const manager1 = { id: 2, role: "employee", systemAccess: "manager" }; // reports: 10, 11
  const manager2 = { id: 3, role: "employee", systemAccess: "manager" }; // reports: 12
  const plainEmployee = { id: 20, role: "employee", systemAccess: "employee" }; // no manager relevant here
  const manager1Reports = [10, 11];
  const manager2Reports = [12];

  test("a manager receives events for their own direct reports", () => {
    const joined = simulateRoomsJoined(manager1, SLUG, manager1Reports);
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, 10)), "manager1 must receive an event for report 10");
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, 11)), "manager1 must receive an event for report 11");
  });

  test("a manager receives events for their own shift too", () => {
    const joined = simulateRoomsJoined(manager1, SLUG, manager1Reports);
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, manager1.id)), "manager1 must receive their own event");
  });

  test("a manager does NOT receive events for another manager's team", () => {
    const joined = simulateRoomsJoined(manager1, SLUG, manager1Reports);
    assert.equal(wouldReceive(joined, broadcastTargets(SLUG, 12)), false, "manager1 must not receive manager2's report's event");
  });

  test("a manager does NOT receive events for an unrelated employee with no shared manager", () => {
    const joined = simulateRoomsJoined(manager1, SLUG, manager1Reports);
    assert.equal(wouldReceive(joined, broadcastTargets(SLUG, plainEmployee.id)), false);
  });

  test("a manager does NOT join the broad tenant-wide room", () => {
    const joined = simulateRoomsJoined(manager1, SLUG, manager1Reports);
    assert.ok(!joined.has(shiftRoom(SLUG)), "manager must not be in the broad room");
  });

  test("an administrator receives events for every employee, matching their unrestricted REST access", () => {
    const joined = simulateRoomsJoined(admin, SLUG, []);
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, 10)));
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, 12)));
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, plainEmployee.id)));
  });

  test("a plain employee (not manager, not admin) does NOT receive events for other employees -- only their own", () => {
    // Being able to PULL any one employee's shift via an explicit
    // ?userId=/search REST call is not the same as being PUSHED a
    // standing broadcast for every employee, unasked -- see
    // resolveShiftRoomPlan's own comment for why this is deliberately
    // narrower than REST's on-demand lookup allowance.
    const joined = simulateRoomsJoined(plainEmployee, SLUG, []);
    assert.equal(wouldReceive(joined, broadcastTargets(SLUG, 10)), false, "must not receive an unrelated colleague's event");
    assert.equal(wouldReceive(joined, broadcastTargets(SLUG, 12)), false);
    assert.ok(!joined.has(shiftRoom(SLUG)), "must not join the broad room");
    assert.ok(wouldReceive(joined, broadcastTargets(SLUG, plainEmployee.id)), "still always receives their own event");
  });

  test("role==='admin' takes precedence over systemAccess==='manager' (matches isAdminTier's own precedence)", () => {
    const adminAndManager = { id: 4, role: "admin", systemAccess: "manager" };
    const joined = simulateRoomsJoined(adminAndManager, SLUG, []);
    assert.ok(joined.has(shiftRoom(SLUG)), "must be treated as admin-tier, not manager-tier");
  });

  test("cross-tenant delivery is structurally impossible: room names never collide across companies", () => {
    const otherSlug = "other-co";
    const otherAdminJoined = simulateRoomsJoined({ id: 1, role: "admin", systemAccess: "employee" }, otherSlug, []);
    const acmeTargets = broadcastTargets(SLUG, 10);

    assert.equal(wouldReceive(otherAdminJoined, acmeTargets), false, "a different tenant's admin must never receive acme's event");
    assert.notEqual(shiftRoom(SLUG), shiftRoom(otherSlug));
    assert.notEqual(userRoom(SLUG, 10), userRoom(otherSlug, 10));
  });

  test("create/update/delete/bulk-save all use the identical recipient-targeting shape", async () => {
    // One assertion per write path, each run end-to-end through the
    // real controller (not the simulation above), confirming every
    // call site reaches the SAME two rooms via the SAME shared
    // broadcastShiftUpdate helper -- not four independently-written,
    // possibly-inconsistent targeting implementations.
    const affectedUserId = 77;

    installQueue([[[{ id: affectedUserId }]], [[]], [[{ id: 900 }]], [[]]]);
    let { io, calls } = fakeIo();
    await shiftController.createShift(
      makeReq({ body: { userId: affectedUserId, shiftDate: "2026-10-10", status: "off" }, app: { get: () => io } }),
      makeRes()
    );
    assert.deepEqual([...calls[0].rooms].sort(), [userRoom("reinsteins", affectedUserId), shiftRoom("reinsteins")].sort());

    installQueue([
      [[{ id: 900, user_id: affectedUserId, shift_date: "2026-10-10", status: "off", start_time: null, end_time: null, notes: null }]],
      [[]],
      [[]],
    ]);
    ({ io, calls } = fakeIo());
    await shiftController.updateShift(
      makeReq({ params: { id: "900" }, body: { status: "leave" }, app: { get: () => io } }),
      makeRes()
    );
    assert.deepEqual([...calls[0].rooms].sort(), [userRoom("reinsteins", affectedUserId), shiftRoom("reinsteins")].sort());

    installQueue([
      [[{ id: 900, user_id: affectedUserId, shift_date: "2026-10-10", status: "leave", start_time: null, end_time: null, notes: null }]],
      [[]],
      [[]],
    ]);
    ({ io, calls } = fakeIo());
    await shiftController.deleteShift(
      makeReq({ params: { id: "900" }, app: { get: () => io } }),
      makeRes()
    );
    assert.deepEqual([...calls[0].rooms].sort(), [userRoom("reinsteins", affectedUserId), shiftRoom("reinsteins")].sort());

    installQueue([[[{ id: affectedUserId }]], [[]], [[{ id: 901 }]], [[]]]);
    ({ io, calls } = fakeIo());
    await shiftController.bulkSaveShifts(
      makeReq({
        body: { shifts: [{ userId: affectedUserId, shiftDate: "2026-10-11", status: "off" }] },
        app: { get: () => io },
      }),
      makeRes()
    );
    assert.deepEqual([...calls[0].rooms].sort(), [userRoom("reinsteins", affectedUserId), shiftRoom("reinsteins")].sort());
  });

  test("an admin editing their own shift: exactly one .emit() call spanning both rooms, not two", () => {
    // The only tier whose own personal room AND the broad room can
    // both be targeted by the same event (admin-tier always joins the
    // broad room). Socket.IO's own BroadcastOperator.to() accumulates
    // rooms into a Set and issues one broadcast across the union
    // (verified directly against the installed package -- see this
    // repo's node_modules/socket.io/dist/broadcast-operator.js and
    // node_modules/socket.io-adapter/dist/in-memory-adapter.js's
    // apply(), which tracks one Set of socket ids across all targeted
    // rooms and skips any id already delivered to) -- so a single
    // .emit() call across the union, which is what this asserts for
    // broadcastShiftUpdate, is the complete precondition for "no
    // duplicate delivery" to hold; no retry/second emit exists here.
    const adminId = 1;
    installQueue([[[{ id: adminId }]], [[]], [[{ id: 950 }]], [[]]]);
    const { io, calls } = fakeIo();

    return shiftController
      .createShift(
        makeReq({ body: { userId: adminId, shiftDate: "2026-10-10", status: "off" }, app: { get: () => io } }),
        makeRes()
      )
      .then(() => {
        assert.equal(calls.length, 1, "must be exactly one emit call, not one per room");
        assert.deepEqual([...calls[0].rooms].sort(), [userRoom("reinsteins", adminId), shiftRoom("reinsteins")].sort());
      });
  });
});
