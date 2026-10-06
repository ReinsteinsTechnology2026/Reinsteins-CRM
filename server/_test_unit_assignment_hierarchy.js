// Unit tests for work-item owner/assigned_by preservation, Task assignment
// attribution, hierarchy self-scoping, and route authorization. No database
// is needed: pool.query is replaced with an in-memory fake that dispatches on
// SQL text. Run with:  node --test server/_test_unit_assignment_hierarchy.js

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const db = require("./config/db");
const permissionService = require("./services/projectPermissionService");

// Services destructure this at require time, so stub it before they load.
permissionService.isEligibleProjectAssignee = async () => true;

const { resolveAssignedBy, resolvePreservedId } = require("./utils/assignmentRules");
const epicService = require("./services/epicService");
const featureService = require("./services/featureService");
const userStoryService = require("./services/userStoryService");
const taskService = require("./services/taskService");
const organizationController = require("./controllers/organizationController");
const { protect } = require("./middleware/authMiddleware");
const { requireProjectAccess } = require("./middleware/accessMiddleware");
const organizationRoutes = require("./routes/organizationRoutes");
const featureRoutes = require("./routes/featureRoutes");
const epicRoutes = require("./routes/epicRoutes");

let calls = [];

function installFake(handler) {
  calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return handler(sql, params);
  };
}

function updateCall(table) {
  const call = calls.find((c) => new RegExp(`UPDATE ${table}\\b`).test(c.sql));
  assert.ok(call, `expected an UPDATE on ${table}`);
  return call;
}

describe("assignment rules", () => {
  test("assigned_by is kept when the assignee is unchanged", () => {
    assert.equal(
      resolveAssignedBy({ assignedTo: "7", currentAssignedTo: 7, currentAssignedBy: 3, actorId: 9 }),
      3
    );
  });

  test("assigned_by becomes the actor when the assignee changes", () => {
    assert.equal(
      resolveAssignedBy({ assignedTo: 8, currentAssignedTo: 7, currentAssignedBy: 3, actorId: 9 }),
      9
    );
  });

  test("assigned_by is null when there is no assignee", () => {
    assert.equal(
      resolveAssignedBy({ assignedTo: "", currentAssignedTo: 7, currentAssignedBy: 3, actorId: 9 }),
      null
    );
  });

  test("a new assignment records the actor", () => {
    assert.equal(
      resolveAssignedBy({ assignedTo: 8, currentAssignedTo: undefined, currentAssignedBy: undefined, actorId: 9 }),
      9
    );
  });

  test("owner is preserved when owner_id is not supplied", () => {
    assert.equal(resolvePreservedId(undefined, 4), 4);
  });

  test("owner is cleared only by an explicit null or empty value", () => {
    assert.equal(resolvePreservedId(null, 4), null);
    assert.equal(resolvePreservedId("", 4), null);
  });

  test("an explicitly supplied owner replaces the current one", () => {
    assert.equal(resolvePreservedId(6, 4), 6);
  });
});

describe("Epic update preserves owner and assigned_by", () => {
  const current = { owner_id: 4, assigned_to: 7, assigned_by: 3 };

  function fakeEpic() {
    return installFake((sql) => {
      if (/SELECT owner_id, assigned_to, assigned_by FROM epics/.test(sql)) return [[current]];
      if (/UPDATE epics/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  // UPDATE epics params order: title, description, owner, status, priority,
  // start, due, assigned_to, assigned_by, id
  const OWNER = 2;
  const ASSIGNED_BY = 8;

  test("omitting owner_id keeps the existing owner", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { title: "t", status: "new", priority: "Medium", assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("epics").params[OWNER], 4);
  });

  test("an explicit null owner clears it", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { title: "t", status: "new", priority: "Medium", owner_id: null, assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("epics").params[OWNER], null);
  });

  test("saving without an assignee change keeps the original assigned_by", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { title: "t", status: "new", priority: "Medium", assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("epics").params[ASSIGNED_BY], 3);
  });

  test("changing the assignee records the authenticated actor", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { title: "t", status: "new", priority: "Medium", assigned_to: "8" }, 1, 9);
    assert.equal(updateCall("epics").params[ASSIGNED_BY], 9);
  });

  test("a client-supplied assigned_by is ignored", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { title: "t", status: "new", priority: "Medium", assigned_to: "7", assigned_by: 99 }, 1, 9);
    assert.equal(updateCall("epics").params[ASSIGNED_BY], 3);
  });
});

describe("Epic assigned_to partial-update protection", () => {
  const current = { owner_id: 4, assigned_to: 7, assigned_by: 3 };
  const base = { title: "t", status: "new", priority: "Medium" };
  const ASSIGNED_TO = 7;
  const ASSIGNED_BY = 8;
  const OWNER = 2;

  function fakeEpic() {
    return installFake((sql) => {
      if (/SELECT owner_id, assigned_to, assigned_by FROM epics/.test(sql)) return [[current]];
      if (/UPDATE epics/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  test("omitted assigned_to preserves the existing assignee and assigned_by", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { ...base, title: "renamed" }, 1, 9);
    const p = updateCall("epics").params;
    assert.equal(p[ASSIGNED_TO], 7);
    assert.equal(p[ASSIGNED_BY], 3);
    assert.equal(p[OWNER], 4);
  });

  test("explicit null or empty assigned_to clears the assignee", async () => {
    for (const cleared of [null, ""]) {
      fakeEpic();
      await epicService.updateEpic(5, { ...base, assigned_to: cleared }, 1, 9);
      const p = updateCall("epics").params;
      assert.equal(p[ASSIGNED_TO], null, `assigned_to ${JSON.stringify(cleared)} should clear`);
      assert.equal(p[ASSIGNED_BY], null, `assigned_by ${JSON.stringify(cleared)} should clear`);
    }
  });

  test("changed assigned_to updates assigned_by to the actor", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { ...base, assigned_to: 8 }, 1, 9);
    const p = updateCall("epics").params;
    assert.equal(p[ASSIGNED_TO], 8);
    assert.equal(p[ASSIGNED_BY], 9);
  });

  test("unrelated update preserves assigned_to, assigned_by, and owner", async () => {
    fakeEpic();
    await epicService.updateEpic(5, { ...base, title: "renamed", status: "active", assigned_to: "7" }, 1, 9);
    const p = updateCall("epics").params;
    assert.equal(String(p[ASSIGNED_TO]), "7");
    assert.equal(p[ASSIGNED_BY], 3);
    assert.equal(p[OWNER], 4);
  });
});

describe("Feature assigned_to partial-update protection", () => {
  const current = { owner_id: 4, assigned_to: 7, assigned_by: 3 };
  const base = { title: "t", status: "new", priority: "Medium", epic_id: null };
  const ASSIGNED_TO = 8;
  const ASSIGNED_BY = 9;
  const OWNER = 2;

  function fakeFeature() {
    return installFake((sql) => {
      if (/SELECT owner_id, assigned_to, assigned_by FROM features/.test(sql)) return [[current]];
      if (/UPDATE features/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  test("omitted assigned_to preserves the existing assignee and assigned_by", async () => {
    fakeFeature();
    await featureService.updateFeature(5, { ...base, title: "renamed" }, 1, 9);
    const p = updateCall("features").params;
    assert.equal(p[ASSIGNED_TO], 7);
    assert.equal(p[ASSIGNED_BY], 3);
    assert.equal(p[OWNER], 4);
  });

  test("explicit null or empty assigned_to clears the assignee", async () => {
    for (const cleared of [null, ""]) {
      fakeFeature();
      await featureService.updateFeature(5, { ...base, assigned_to: cleared }, 1, 9);
      const p = updateCall("features").params;
      assert.equal(p[ASSIGNED_TO], null, `assigned_to ${JSON.stringify(cleared)} should clear`);
      assert.equal(p[ASSIGNED_BY], null, `assigned_by ${JSON.stringify(cleared)} should clear`);
    }
  });

  test("changed assigned_to updates assigned_by to the actor", async () => {
    fakeFeature();
    await featureService.updateFeature(5, { ...base, assigned_to: 8 }, 1, 9);
    const p = updateCall("features").params;
    assert.equal(p[ASSIGNED_TO], 8);
    assert.equal(p[ASSIGNED_BY], 9);
  });

  test("unrelated update preserves assigned_to, assigned_by, and owner", async () => {
    fakeFeature();
    await featureService.updateFeature(5, { ...base, title: "renamed", status: "active", assigned_to: "7" }, 1, 9);
    const p = updateCall("features").params;
    assert.equal(String(p[ASSIGNED_TO]), "7");
    assert.equal(p[ASSIGNED_BY], 3);
    assert.equal(p[OWNER], 4);
  });
});

describe("Feature update preserves owner and assigned_by", () => {
  const current = { owner_id: 4, assigned_to: 7, assigned_by: 3 };

  function fakeFeature() {
    return installFake((sql) => {
      if (/SELECT owner_id, assigned_to, assigned_by FROM features/.test(sql)) return [[current]];
      if (/UPDATE features/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  // UPDATE features params order: title, description, owner, status, priority,
  // start, due, epic_id, assigned_to, assigned_by, id
  const OWNER = 2;
  const ASSIGNED_BY = 9;

  test("omitting owner_id keeps the existing owner", async () => {
    fakeFeature();
    await featureService.updateFeature(5, { title: "t", status: "new", priority: "Medium", epic_id: null, assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("features").params[OWNER], 4);
  });

  test("unchanged assignee keeps assigned_by, changed assignee records actor", async () => {
    fakeFeature();
    await featureService.updateFeature(5, { title: "t", status: "new", priority: "Medium", epic_id: null, assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("features").params[ASSIGNED_BY], 3);

    fakeFeature();
    await featureService.updateFeature(5, { title: "t", status: "new", priority: "Medium", epic_id: null, assigned_to: "8" }, 1, 9);
    assert.equal(updateCall("features").params[ASSIGNED_BY], 9);
  });
});

describe("User Story update preserves owner and assigned_by", () => {
  const current = { owner_id: 4, assigned_to: 7, assigned_by: 3 };

  function fakeStory() {
    return installFake((sql) => {
      if (/SELECT owner_id, assigned_to, assigned_by FROM user_stories/.test(sql)) return [[current]];
      if (/UPDATE user_stories/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  // UPDATE user_stories params order: title, description, owner, status,
  // priority, start, due, tags, feature_id, assigned_to, assigned_by, id
  const OWNER = 2;
  const ASSIGNED_BY = 10;

  test("omitting owner_id keeps the existing owner", async () => {
    fakeStory();
    await userStoryService.updateUserStory(5, { title: "t", status: "new", priority: "Medium", feature_id: null, assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("user_stories").params[OWNER], 4);
  });

  test("unchanged assignee keeps assigned_by, changed assignee records actor", async () => {
    fakeStory();
    await userStoryService.updateUserStory(5, { title: "t", status: "new", priority: "Medium", feature_id: null, assigned_to: "7" }, 1, 9);
    assert.equal(updateCall("user_stories").params[ASSIGNED_BY], 3);

    fakeStory();
    await userStoryService.updateUserStory(5, { title: "t", status: "new", priority: "Medium", feature_id: null, assigned_to: "8" }, 1, 9);
    assert.equal(updateCall("user_stories").params[ASSIGNED_BY], 9);
  });
});

describe("User Story assigned_to partial-update protection", () => {
  const current = { owner_id: 4, assigned_to: 7, assigned_by: 3 };
  const base = { title: "t", status: "new", priority: "Medium", feature_id: null };
  const ASSIGNED_TO = 9;
  const ASSIGNED_BY = 10;
  const OWNER = 2;

  function fakeStory() {
    return installFake((sql) => {
      if (/SELECT owner_id, assigned_to, assigned_by FROM user_stories/.test(sql)) return [[current]];
      if (/UPDATE user_stories/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  test("omitted assigned_to preserves the existing assignee and assigned_by", async () => {
    fakeStory();
    await userStoryService.updateUserStory(5, { ...base, title: "renamed" }, 1, 9);
    const p = updateCall("user_stories").params;
    assert.equal(p[ASSIGNED_TO], 7);
    assert.equal(p[ASSIGNED_BY], 3);
    assert.equal(p[OWNER], 4);
  });

  test("explicit null or empty assigned_to clears the assignee", async () => {
    for (const cleared of [null, ""]) {
      fakeStory();
      await userStoryService.updateUserStory(5, { ...base, assigned_to: cleared }, 1, 9);
      const p = updateCall("user_stories").params;
      assert.equal(p[ASSIGNED_TO], null, `assigned_to ${JSON.stringify(cleared)} should clear`);
      assert.equal(p[ASSIGNED_BY], null, `assigned_by ${JSON.stringify(cleared)} should clear`);
    }
  });

  test("changed assigned_to updates assigned_by to the actor", async () => {
    fakeStory();
    await userStoryService.updateUserStory(5, { ...base, assigned_to: 8 }, 1, 9);
    const p = updateCall("user_stories").params;
    assert.equal(p[ASSIGNED_TO], 8);
    assert.equal(p[ASSIGNED_BY], 9);
  });

  test("unrelated update preserves assigned_to, assigned_by, and owner", async () => {
    fakeStory();
    await userStoryService.updateUserStory(5, { ...base, title: "renamed", status: "active", assigned_to: "7" }, 1, 9);
    const p = updateCall("user_stories").params;
    assert.equal(String(p[ASSIGNED_TO]), "7");
    assert.equal(p[ASSIGNED_BY], 3);
    assert.equal(p[OWNER], 4);
  });
});

describe("Task assignment attribution", () => {
  const current = { assigned_to: 7, assigned_by: 3 };

  function fakeTask() {
    return installFake((sql) => {
      if (/SELECT assigned_to, assigned_by FROM tasks/.test(sql)) return [[current]];
      if (/UPDATE tasks|INSERT INTO task_assignments/.test(sql)) return [{ affectedRows: 1 }];
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  const baseTask = {
    title: "t",
    description: "d",
    priority: "Medium",
    status: "todo",
    due_date: null,
    estimated_hours: null,
    tags: null,
  };

  // UPDATE tasks (updateTask) params: title, description, assigned_to,
  // assigned_by, priority, status, due, estimated_hours, tags, id
  const TASK_ASSIGNED_BY = 3;

  test("saving unrelated Task fields keeps assigned_by", async () => {
    fakeTask();
    await taskService.updateTask(11, { ...baseTask, assigned_to: 7 }, 9);
    assert.equal(updateCall("tasks").params[TASK_ASSIGNED_BY], 3);
  });

  test("omitting assigned_to preserves the existing assignee", async () => {
    fakeTask();
    await taskService.updateTask(11, { ...baseTask, title: "renamed" }, 9);
    const params = updateCall("tasks").params;
    assert.equal(params[2], 7);
    assert.equal(params[3], 3);
  });

  test("explicit null or empty assigned_to clears the assignee", async () => {
    for (const cleared of [null, ""]) {
      fakeTask();
      await taskService.updateTask(11, { ...baseTask, assigned_to: cleared }, 9);
      const params = updateCall("tasks").params;
      assert.equal(params[2], null, `assigned_to ${JSON.stringify(cleared)} should clear`);
      assert.equal(params[3], null, `assigned_by ${JSON.stringify(cleared)} should clear`);
    }
  });

  test("a changed assigned_to updates the assignee and records the actor", async () => {
    fakeTask();
    await taskService.updateTask(11, { ...baseTask, assigned_to: 8 }, 9);
    const params = updateCall("tasks").params;
    assert.equal(params[2], 8);
    assert.equal(params[3], 9);
  });

  test("an unrelated update preserves both assigned_to and assigned_by", async () => {
    fakeTask();
    await taskService.updateTask(11, { ...baseTask, title: "renamed", priority: "High" }, 9);
    const params = updateCall("tasks").params;
    assert.equal(params[2], 7);
    assert.equal(params[3], 3);
  });

  test("editing assigned_to records the authenticated actor", async () => {
    fakeTask();
    await taskService.updateTask(11, { ...baseTask, assigned_to: 8 }, 9);
    assert.equal(updateCall("tasks").params[TASK_ASSIGNED_BY], 9);
  });

  test("assignTask records the actor on reassignment and keeps it otherwise", async () => {
    fakeTask();
    await taskService.assignTask(11, 8, 9);
    assert.deepEqual(updateCall("tasks").params, [8, 9, 11]);

    fakeTask();
    await taskService.assignTask(11, 7, 9);
    assert.deepEqual(updateCall("tasks").params, [7, 3, 11]);
  });

  test("transferTask records the transferring actor as assigned_by", async () => {
    fakeTask();
    await taskService.transferTask(11, 9, 8, "note");
    assert.deepEqual(updateCall("tasks").params, [8, 9, 11]);
  });
});

describe("hierarchy endpoint", () => {
  // CEO(1) -> CTO(2) -> Manager(3) -> {Employee(4), Peer(5)}
  // Loop(20) -> Loop(21) -> Loop(20) exercises the cycle guard.
  const people = {
    1: { id: 1, full_name: "CEO", designation: "CEO", department_name: "Exec", reporting_manager_id: null, employment_status: "active", employee_id: "E1" },
    2: { id: 2, full_name: "CTO", designation: "CTO", department_name: "Tech", reporting_manager_id: 1, employment_status: "active", employee_id: "E2" },
    3: { id: 3, full_name: "Manager", designation: "Mgr", department_name: "Tech", reporting_manager_id: 2, employment_status: "active", employee_id: "E3" },
    4: { id: 4, full_name: "Employee", designation: "Dev", department_name: "Tech", reporting_manager_id: 3, employment_status: "active", employee_id: "E4" },
    5: { id: 5, full_name: "Peer", designation: "Dev", department_name: "Tech", reporting_manager_id: 3, employment_status: "active", employee_id: "E5" },
    20: { id: 20, full_name: "LoopA", designation: "x", department_name: null, reporting_manager_id: 21, employment_status: "active", employee_id: "L1" },
    21: { id: 21, full_name: "LoopB", designation: "x", department_name: null, reporting_manager_id: 20, employment_status: "active", employee_id: "L2" },
  };

  const ALLOWED_NODE_FIELDS = new Set([
    "id", "employee_id", "full_name", "designation", "employment_type", "employment_status",
    "department_id", "department_name", "direct_report_count",
  ]);

  function nodeFor(row) {
    return {
      id: row.id,
      employee_id: row.employee_id,
      full_name: row.full_name,
      designation: row.designation,
      employment_type: "full_time",
      employment_status: row.employment_status,
      department_id: 1,
      department_name: row.department_name,
      direct_report_count: Object.values(people).filter(
        (p) => p.reporting_manager_id === row.id && p.employment_status === "active"
      ).length,
    };
  }

  // Dispatches the three query shapes used by getMyHierarchy / fetchOrgNodes.
  function fakeOrg() {
    return installFake((sql, params) => {
      if (/SELECT reporting_manager_id FROM users WHERE id = \?/.test(sql)) {
        const row = people[params[0]];
        return [row ? [{ reporting_manager_id: row.reporting_manager_id }] : []];
      }
      if (/u\.id = \?/.test(sql)) {
        const row = people[params[0]];
        return [row && row.employment_status === "active" ? [nodeFor(row)] : []];
      }
      if (/u\.reporting_manager_id = \? AND u\.id <> \?/.test(sql)) {
        const [managerId, selfId] = params;
        return [Object.values(people)
          .filter((p) => p.reporting_manager_id === managerId && p.id !== selfId)
          .map(nodeFor)];
      }
      if (/u\.reporting_manager_id = \?/.test(sql)) {
        return [Object.values(people)
          .filter((p) => p.reporting_manager_id === params[0] && p.employment_status === "active")
          .map(nodeFor)];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
  }

  function run(userId, extra = {}) {
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    return organizationController.getMyHierarchy(
      { user: { id: userId }, ...extra },
      res
    ).then(() => res);
  }

  test("returns the chain top-down, peers, and direct reports for the caller", async () => {
    fakeOrg();
    const res = await run(4);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.self.id, 4);
    assert.deepEqual(res.body.managers.map((m) => m.id), [1, 2, 3]);
    assert.deepEqual(res.body.peers.map((p) => p.id), [5]);
    assert.deepEqual(res.body.directReports, []);
  });

  test("a manager sees their own direct reports", async () => {
    fakeOrg();
    const res = await run(3);
    assert.deepEqual(res.body.directReports.map((r) => r.id).sort(), [4, 5]);
  });

  test("request-supplied ids cannot change whose hierarchy is returned", async () => {
    fakeOrg();
    const res = await run(4, { query: { userId: "1" }, params: { id: "1" }, body: { userId: 1 } });
    assert.equal(res.body.self.id, 4);
    const firstSelfCall = calls.find((c) => /u\.id = \?/.test(c.sql));
    assert.deepEqual(firstSelfCall.params, [4]);
  });

  test("nodes contain only the approved non-sensitive fields", async () => {
    fakeOrg();
    const res = await run(4);
    const nodes = [res.body.self, ...res.body.managers, ...res.body.peers, ...res.body.directReports];
    for (const node of nodes) {
      for (const key of Object.keys(node)) {
        assert.ok(ALLOWED_NODE_FIELDS.has(key), `unexpected field in hierarchy node: ${key}`);
      }
    }
  });

  test("a reporting loop terminates", async () => {
    fakeOrg();
    people[20].reporting_manager_id = 21;
    const res = await run(20);
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.managers.length <= 1);
  });

  test("an unknown or inactive caller gets 404, not another person's data", async () => {
    fakeOrg();
    const res = await run(9999);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.self, undefined);
  });
});

describe("route authorization", () => {
  function routeFor(router, path, method) {
    const layer = router.stack.find(
      (l) => l.route && l.route.path === path && l.route.methods[method]
    );
    assert.ok(layer, `route ${method.toUpperCase()} ${path} not found`);
    return layer.route.stack.map((s) => s.handle);
  }

  test("GET /organization/my-hierarchy requires authentication only", () => {
    const handles = routeFor(organizationRoutes, "/my-hierarchy", "get");
    assert.ok(handles.includes(protect), "my-hierarchy must run protect");
    assert.equal(handles.length, 2, "my-hierarchy must be protect plus the handler, with no role gate");
  });

  test("GET /features/:id runs protect and project access before the handler", () => {
    const handles = routeFor(featureRoutes, "/:id", "get");
    assert.equal(handles[0], protect);
    assert.equal(handles[1], requireProjectAccess);
    assert.equal(handles.length, 4);
  });

  test("GET /epics/:id runs protect and project access before the handler", () => {
    const handles = routeFor(epicRoutes, "/:id", "get");
    assert.equal(handles[0], protect);
    assert.equal(handles[1], requireProjectAccess);
    assert.equal(handles.length, 4);
  });
});
