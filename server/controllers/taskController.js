const pool = require("../config/db");

const { hasProjectPermission } = require("../services/projectPermissionService");

// ==========================================
// PROJECT PERMISSION GATE (additive only)
//
// This legacy personal-task-tracker controller
// predates the Project module and operates on the
// SAME `tasks` table by `user_id` alone, with no
// awareness of task.project_id -- a project-linked
// task's creator who is later removed from the
// project (or never had edit rights) could otherwise
// still read/edit/complete it here, bypassing the
// entire project membership + permission system used
// everywhere else. This mirrors the exact
// passesProjectPermission pattern already used in
// taskManagementController.js: a non-project task
// (project_id NULL) is completely unaffected; a
// project-linked task additionally requires the given
// permission on top of the existing user_id-ownership
// check below, never in place of it.
// ==========================================

async function passesProjectPermission(userId, task, permissionKey) {

    if (!task.project_id) {
        return true;
    }

    const [[row]] = await pool.query(
        `SELECT project_access_level, is_system_administrator FROM users WHERE id = ? LIMIT 1`,
        [userId]
    );

    return hasProjectPermission(
        { id: userId, accessLevel: row?.project_access_level, isSystemAdministrator: row?.is_system_administrator === true },
        task.project_id,
        permissionKey
    );

}

// Project-linked tasks are only ever included for a caller who is an
// explicit member of that project -- purely additive: it can only
// remove rows a plain `user_id = ?` scoping would otherwise return,
// never add ones it wouldn't. Non-project tasks (project_id IS NULL)
// are completely unaffected. Same rule as taskService.js's
// PROJECT_MEMBERSHIP_FILTER, reused here rather than duplicated logic.
const PROJECT_MEMBERSHIP_FILTER = `
    AND (
        project_id IS NULL
        OR EXISTS (
            SELECT 1 FROM project_members pm
            WHERE pm.project_id = tasks.project_id
            AND pm.user_id = ?
        )
    )
`;

// ==========================================
// EMPLOYEE - CREATE / START TASK
// ==========================================
// ==========================================
// EMPLOYEE - CREATE TASK
// ==========================================

const createTask = async (req, res) => {

    try {

        const userId = req.user.id;

        const {
            taskNumber,
            taskTitle,
            taskDescription,
            priority,
            estimatedHours,
tags,
            status
        } = req.body;

        if (
            !taskNumber ||
            !taskTitle ||
            !taskDescription
        ) {

            return res.status(400).json({
                success:false,
                message:"Please fill all required fields."
            });

        }

        const [result] = await pool.query(

            `
            INSERT INTO tasks
            (
                user_id,
                task_number,
                task_title,
                task_description,
                priority,
                status,
                start_time
            )

            VALUES
            (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                NOW()
            )
            RETURNING id
            `,

            [

                userId,
                taskNumber.trim(),
                taskTitle.trim(),
                taskDescription.trim(),
                priority || "Medium",
                status || "active"

            ]

        );

        const [task] = await pool.query(

            `
            SELECT *
            FROM tasks
            WHERE id=?
            `,

            [result[0].id]

        );

        return res.status(201).json({

            success:true,
            message:"Task created successfully.",
            task:task[0]

        });

    }

    catch(error){

        console.error(error);

        return res.status(500).json({

            success:false,
            message:"Unable to create task."

        });

    }

};

// ==========================================
// EMPLOYEE - GET MY TASKS
// ==========================================

const getMyTasks = async (
  req,
  res
) => {
  try {
    const userId = req.user.id;

    const [tasks] =
      await pool.query(
        `
        SELECT
          id,
          task_title,
          task_description,
          status,
          start_time,
          completed_time,
          created_at,
          updated_at

        FROM tasks

        WHERE user_id = ?
        ${PROJECT_MEMBERSHIP_FILTER}

        ORDER BY
          CASE
            WHEN status = 'in_progress'
            THEN 0
            ELSE 1
          END,
          created_at DESC
        `,
        [userId, userId]
      );

    return res.status(200).json({
      success: true,
      tasks,
    });

  } catch (error) {
    console.error(
      "Get My Tasks Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load tasks",
    });
  }
};

// ==========================================
// EMPLOYEE - UPDATE TASK DESCRIPTION
// ==========================================

const updateTask = async (
  req,
  res
) => {
  try {
    const userId = req.user.id;

    const taskId =
      req.params.id;

    const {
      taskTitle,
      taskDescription,
    } = req.body;

    const [tasks] =
      await pool.query(
        `
        SELECT *
        FROM tasks
        WHERE id = ?
        AND user_id = ?
        LIMIT 1
        `,
        [
          taskId,
          userId,
        ]
      );

    if (tasks.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Task not found",
      });
    }

    if (
      tasks[0].status ===
      "closed"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Completed tasks cannot be updated",
      });
    }

    if (!await passesProjectPermission(userId, tasks[0], "TASK_EDIT")) {
      return res.status(403).json({
        success: false,
        message:
          "You do not have permission to edit this task",
      });
    }

    const updatedTitle =
      taskTitle?.trim() ||
      tasks[0].task_title;

    const updatedDescription =
      taskDescription?.trim() ||
      tasks[0].task_description;

    await pool.query(
      `
      UPDATE tasks
      SET
        task_title = ?,
        task_description = ?
      WHERE id = ?
      AND user_id = ?
      `,
      [
        updatedTitle,
        updatedDescription,
        taskId,
        userId,
      ]
    );

    return res.status(200).json({
      success: true,
      message:
        "Task updated successfully",
    });

  } catch (error) {
    console.error(
      "Update Task Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to update task",
    });
  }
};

// ==========================================
// EMPLOYEE - COMPLETE TASK
// ==========================================

const completeTask = async (
  req,
  res
) => {
  try {
    const userId = req.user.id;

    const taskId =
      req.params.id;

    const [tasks] =
      await pool.query(
        `
        SELECT *
        FROM tasks
        WHERE id = ?
        AND user_id = ?
        LIMIT 1
        `,
        [
          taskId,
          userId,
        ]
      );

    if (tasks.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          "Task not found",
      });
    }

    if (
      tasks[0].status ===
      "closed"
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Task is already completed",
      });
    }

    if (!await passesProjectPermission(userId, tasks[0], "TASK_CHANGE_STATUS")) {
      return res.status(403).json({
        success: false,
        message:
          "You do not have permission to change this task's status",
      });
    }

    await pool.query(
      `
      UPDATE tasks

      SET
        status = 'closed',
        completed_time = NOW()

      WHERE id = ?
      AND user_id = ?
      `,
      [
        taskId,
        userId,
      ]
    );

    return res.status(200).json({
      success: true,
      message:
        "Task completed successfully",
    });

  } catch (error) {
    console.error(
      "Complete Task Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to complete task",
    });
  }
};

// ==========================================
// ADMIN - GET ALL EMPLOYEE TASKS
// ==========================================

const getAdminTasks = async (
  req,
  res
) => {
  try {
    const [tasks] =
      await pool.query(
        `
        SELECT
          t.id,
          t.task_title,
          t.task_description,
          t.status,
          t.start_time,
          t.completed_time,
          t.created_at,

          u.id AS user_id,
          u.employee_id,
          u.full_name

        FROM tasks t

        INNER JOIN users u
          ON t.user_id = u.id

        WHERE
          u.role = 'employee'
          AND (
            t.project_id IS NULL
            OR EXISTS (
              SELECT 1 FROM project_members pm
              WHERE pm.project_id = t.project_id
              AND pm.user_id = ?
            )
          )

        ORDER BY
          CASE
            WHEN t.status =
              'in_progress'
            THEN 0
            ELSE 1
          END,
          t.created_at DESC
        `,
        [req.user.id]
      );

    const inProgress =
      tasks.filter(
        (task) =>
          task.status ===
          "in_progress"
      ).length;

    const completed =
      tasks.filter(
        (task) =>
          task.status ===
          "closed"
      ).length;

    return res.status(200).json({
      success: true,

      summary: {
        totalTasks:
          tasks.length,

        inProgress,

        completed,
      },

      tasks,
    });

  } catch (error) {
    console.error(
      "Admin Tasks Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load employee tasks",
    });
  }
};

module.exports = {
  createTask,
  getMyTasks,
  updateTask,
  completeTask,
  getAdminTasks,
};