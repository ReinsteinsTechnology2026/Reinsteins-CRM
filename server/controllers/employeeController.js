const bcrypt = require("bcrypt");
const pool = require("../config/db");
const fs = require("fs");
const path = require("path");

const { tenantUploadUrlPath, UPLOADS_ROOT } = require("../utils/tenantUploadPath");

const {
  validateDepartmentAssignment,
  validateReportingManagerAssignment,
  getDirectReportRows,
  recordOrganizationHistory,
} = require("../services/organizationService");

// ==========================================
// MANAGER-EXIT SAFETY CHECK
// Before resigning/terminating/completing/
// discontinuing someone, block the action if
// they still have active direct reports — those
// must be reassigned to another manager first
// (via PUT /organization/users/:id/reporting-
// manager) rather than being silently left
// pointing at a now-inactive manager.
// ==========================================

async function blockIfHasActiveDirectReports(userId) {

  const reports = await getDirectReportRows(userId);

  if (reports.length === 0) {
    return null;
  }

  const names = reports
    .slice(0, 5)
    .map((r) => `${r.full_name} (${r.employee_id})`)
    .join(", ");

  return (
    `This person still has ${reports.length} active direct report(s) ` +
    `(${names}${reports.length > 5 ? ", ..." : ""}). ` +
    `Please reassign them to another reporting manager before continuing.`
  );

}

const {
  SYSTEM_ACCESS_LEVELS,
} = require("../middleware/accessMiddleware");

// ==========================================
// IDENTIFIER GENERATION (employees + interns)
//
// Format is fixed: <prefix> + a zero-padded 3+
// digit number ("RS001", "INT001", ... "RS010",
// ... "RS100"). The next number is derived from
// the HIGHEST existing numeric portion of
// current <prefix>-matching employee_id values
// (not a row count), so gaps left by former/
// completed/discontinued people are never
// reused. Employee ("RS") and intern ("INT")
// numbering are naturally independent sequences
// — they're just different prefixes within the
// same unique employee_id column, so an "RS..."
// row can never collide with an "INT..." row and
// vice versa.
//
// This alone is only safe for a single request
// at a time — it is also used, with a retry loop
// around the actual INSERT/UPDATE, by
// createEmployee and convertInternToEmployee
// below to stay correct under concurrent
// creation/conversion (see there).
// ==========================================

async function generateNextIdentifier(prefix) {

  const [rows] = await pool.query(
    `
    SELECT employee_id
    FROM users
    WHERE employee_id REGEXP ?
    ORDER BY CAST(SUBSTRING(employee_id, ?) AS UNSIGNED) DESC
    LIMIT 1
    `,
    [
      `^${prefix}[0-9]+$`,
      prefix.length + 1,
    ]
  );

  const highestNumber =
    rows.length > 0
      ? parseInt(rows[0].employee_id.slice(prefix.length), 10)
      : 0;

  const nextNumber = highestNumber + 1;

  return `${prefix}${String(nextNumber).padStart(3, "0")}`;

}

function generateNextEmployeeId() {
  return generateNextIdentifier("RS");
}

function generateNextInternId() {
  return generateNextIdentifier("INT");
}

// ==========================================
// GET NEXT EMPLOYEE/INTERN ID (PREVIEW) - ADMIN
//
// Display-only, for the Add Employee/Add Intern
// modals to show a suggested ID as soon as they
// open. This is NOT reserved and is NOT what
// actually gets stored — createEmployee/
// convertInternToEmployee below regenerate (and
// safely retry) their own ID independently at
// creation time, since two admins could open the
// modal at the same time and both see the same
// preview.
// ==========================================

const getNextEmployeeId = async (req, res) => {
  try {
    const nextEmployeeId = await generateNextEmployeeId();

    return res.status(200).json({
      success: true,
      nextEmployeeId,
    });
  } catch (error) {
    console.error(
      "Get Next Employee ID Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to generate the next employee ID",
    });
  }
};

const getNextInternId = async (req, res) => {
  try {
    const nextInternId = await generateNextInternId();

    return res.status(200).json({
      success: true,
      nextInternId,
    });
  } catch (error) {
    console.error(
      "Get Next Intern ID Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to generate the next intern ID",
    });
  }
};

// ==========================================
// GET ALL EMPLOYEES - ADMIN
// ==========================================

const getEmployees = async (req, res) => {
  try {
    const [employees] = await pool.query(
      `
      SELECT
        u.id,
        u.employee_id,
        u.first_name,
        u.last_name,
        u.full_name,
        u.email,
        u.phone,
        u.address,
        u.date_of_birth,
        u.designation,
        u.emergency_contact,
        u.profile_photo,
        u.role,
        u.status,
        u.employment_type,
        u.employment_status,
        u.joining_date,
        u.last_working_date,
        u.internship_end_date,
        u.mentor_id,
        mentor.full_name AS mentor_name,
        u.stipend,
        u.exited_at,
        u.exit_reason,
        u.exit_notes,
        u.department_id,
        dep.name AS department_name,
        u.reporting_manager_id,
        manager.full_name AS reporting_manager_name,
        manager.employee_id AS reporting_manager_employee_id,
        u.system_access,
        u.project_access_override,
        u.project_access_level,
        u.last_login,
        u.created_at
      FROM users u
      LEFT JOIN users mentor ON mentor.id = u.mentor_id
      LEFT JOIN departments dep ON dep.id = u.department_id
      LEFT JOIN users manager ON manager.id = u.reporting_manager_id
      WHERE u.role = 'employee'
      ORDER BY
        CASE
          WHEN u.status = 'pending' THEN 1
          WHEN u.status = 'active' THEN 2
          ELSE 3
        END,
        u.created_at DESC
      `
    );

    return res.status(200).json({
      success: true,
      employees,
    });
  } catch (error) {
    console.error(
      "Get Employees Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load employees",
    });
  }
};

// ==========================================
// ADMIN CREATE EMPLOYEE
// ==========================================

const createEmployee = async (req, res) => {
  try {
    const {
      fullName,
      email,
      designation,
      password,
      employmentType,
      joiningDate,
      mentorId,
      stipend,
      internshipEndDate,
      notes,
      departmentId,
      reportingManagerId,
      systemAccess,
    } = req.body;

    // Employee/Intern ID is intentionally NOT read from req.body
    // here — it is always generated server-side below, regardless
    // of whatever the frontend sent as a preview. This is what
    // makes the backend the actual source of truth (see
    // generateNextIdentifier's comment above).

    // Defaults to "employee" so the existing Add Employee form
    // (which never sends this field) keeps working unchanged.

    const isIntern =
      employmentType === "intern";

    if (
      !fullName?.trim() ||
      !designation?.trim() ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Full name, designation and password are required",
      });
    }

    // Interns get an explicit, admin-chosen start date (their
    // internship may not begin the day they're added to the
    // system); employees keep the existing "always today" behavior
    // since that form has no such field.

    const cleanedJoiningDate =
      isIntern && joiningDate
        ? joiningDate
        : null;

    const cleanedMentorId =
      isIntern && mentorId
        ? Number(mentorId)
        : null;

    const cleanedStipend =
      isIntern &&
      stipend !== undefined &&
      stipend !== null &&
      stipend !== ""
        ? Number(stipend)
        : null;

    const cleanedInternshipEndDate =
      isIntern &&
      internshipEndDate
        ? internshipEndDate
        : null;

    const cleanedNotes =
      notes?.trim() || null;

    const cleanedEmail =
      email?.trim().toLowerCase() ||
      null;

    // ======================================
    // VALIDATE MENTOR (interns only — a simple
    // existence/active check, not the fuller
    // cycle-aware validation used for
    // reporting_manager_id, since mentor_id is a
    // flat, non-chaining relationship)
    // ======================================

    let validatedMentorId = null;

    if (cleanedMentorId) {

      const [mentorRows] = await pool.query(
        `SELECT id, employment_status FROM users WHERE id = ? LIMIT 1`,
        [cleanedMentorId]
      );

      if (mentorRows.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Selected mentor not found",
        });
      }

      if (mentorRows[0].employment_status !== "active") {
        return res.status(400).json({
          success: false,
          message: "Mentor must be an active user",
        });
      }

      validatedMentorId = cleanedMentorId;

    }

    // ======================================
    // VALIDATE DEPARTMENT + REPORTING MANAGER
    // (applies to both employees and interns)
    // ======================================

    const departmentValidation =
      await validateDepartmentAssignment(departmentId);

    if (!departmentValidation.valid) {
      return res.status(400).json({
        success: false,
        message: departmentValidation.message,
      });
    }

    // A brand-new user can't yet have an id to check for self-
    // reporting/cycles against — pass 0, which can never match a
    // real user id, so only the existence/active checks apply here.

    const managerValidation =
      await validateReportingManagerAssignment(0, reportingManagerId);

    if (!managerValidation.valid) {
      return res.status(400).json({
        success: false,
        message: managerValidation.message,
      });
    }

    // System access is only ever meaningful for employees, never
    // interns. 'super_admin' may only ever be granted by someone who
    // is themselves already a Super Admin (req.userAccess is set by
    // the requireAccess middleware this route runs behind) — this is
    // what stops an HR/Admin caller from privilege-escalating a new
    // hire straight to Super Admin. Anything else defaults to
    // 'employee', matching the column default.

    let cleanedSystemAccess = "employee";

    if (!isIntern && SYSTEM_ACCESS_LEVELS.includes(systemAccess)) {

      if (systemAccess === "super_admin" && req.userAccess?.systemAccess !== "super_admin") {
        return res.status(403).json({
          success: false,
          message: "Only a Super Admin can grant Super Admin access",
        });
      }

      cleanedSystemAccess = systemAccess;

    }

    // ======================================
    // VALIDATE EMAIL
    // ======================================

    if (cleanedEmail) {
      const emailPattern =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (
        !emailPattern.test(
          cleanedEmail
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Please enter a valid email address",
        });
      }
    }

    // ======================================
    // CHECK EMAIL
    // ======================================

    if (cleanedEmail) {
      const [existingEmail] =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE LOWER(email) = ?
          LIMIT 1
          `,
          [cleanedEmail]
        );

      if (
        existingEmail.length > 0
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Email address already exists",
        });
      }
    }

    // ======================================
    // HASH PASSWORD
    // ======================================

    const hashedPassword =
      await bcrypt.hash(
        password,
        12
      );

    // ======================================
    // CREATE EMPLOYEE
    //
    // employee_id has a UNIQUE index (confirmed
    // on the live schema), so this is safe under
    // concurrent creation: if two requests race
    // and both compute the same "next" ID, only
    // one INSERT succeeds — the loser catches
    // ER_DUP_ENTRY on employee_id specifically,
    // recomputes the next ID (now accounting for
    // the row that just won), and retries. A
    // duplicate on the email column is a real
    // validation error, not a race to retry, so
    // it is re-thrown as-is.
    // ======================================

    const MAX_ID_ATTEMPTS = 5;

    let insertResult = null;
    let finalEmployeeId = null;

    for (
      let attempt = 0;
      attempt < MAX_ID_ATTEMPTS;
      attempt += 1
    ) {

      finalEmployeeId =
        isIntern
          ? await generateNextInternId()
          : await generateNextEmployeeId();

      try {

        [insertResult] =
          await pool.query(
            `
            INSERT INTO users
            (
              employee_id,
              full_name,
              email,
              designation,
              password,
              role,
              status,
              employment_type,
              employment_status,
              joining_date,
              internship_end_date,
              mentor_id,
              stipend,
              department_id,
              reporting_manager_id,
              system_access
            )
            VALUES
            (
              ?,
              ?,
              ?,
              ?,
              ?,
              'employee',
              'active',
              ?,
              'active',
              ?,
              ?,
              ?,
              ?,
              ?,
              ?,
              ?
            )
            RETURNING id
            `,
            [
              finalEmployeeId,
              fullName.trim(),
              cleanedEmail,
              designation.trim(),
              hashedPassword,
              isIntern ? "intern" : "employee",
              cleanedJoiningDate || null,
              cleanedInternshipEndDate,
              validatedMentorId,
              cleanedStipend,
              departmentValidation.departmentId,
              managerValidation.managerId,
              cleanedSystemAccess,
            ]
          );

        break;

      } catch (insertError) {

        const isDuplicateEmployeeId =
          insertError.code === "ER_DUP_ENTRY" &&
          insertError.message?.includes(
            "employee_id"
          );

        if (!isDuplicateEmployeeId) {
          throw insertError;
        }

        insertResult = null;
        // loop again with a freshly generated ID

      }

    }

    if (!insertResult) {
      return res.status(500).json({
        success: false,
        message:
          "Unable to generate a unique ID, please try again",
      });
    }

    // ======================================
    // JOINING DATE ON THE users ROW
    // Employees have no explicit start-date
    // input (always "today"), which the original
    // INSERT above didn't set when joining_date
    // wasn't provided — set it explicitly here so
    // both paths end up consistent.
    // ======================================

    if (!cleanedJoiningDate) {
      await pool.query(
        `UPDATE users SET joining_date = CURDATE() WHERE id = ?`,
        [insertResult.insertId]
      );
    }

    // ======================================
    // OPEN THE FIRST EMPLOYMENT HISTORY PERIOD
    // Every later resign/terminate/rehire/
    // complete/discontinue/convert action
    // operates on this same table.
    // ======================================

    await pool.query(
      `
      INSERT INTO employment_history
      (
        user_id,
        employment_type,
        identifier,
        designation,
        start_date,
        end_date,
        employment_status,
        notes
      )
      VALUES
      (
        ?,
        ?,
        ?,
        ?,
        ?,
        NULL,
        'active',
        ?
      )
      `,
      [
        insertResult.insertId,
        isIntern ? "intern" : "employee",
        finalEmployeeId,
        designation.trim(),
        cleanedJoiningDate ||
          new Date()
            .toISOString()
            .slice(0, 10),
        cleanedNotes,
      ]
    );

    return res.status(201).json({
      success: true,
      message:
        isIntern
          ? "Intern created successfully"
          : "Employee created successfully",
      id: insertResult.insertId,
      employeeId: finalEmployeeId,
    });
  } catch (error) {
    console.error(
      "Create Employee Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to create employee",
    });
  }
};

// ==========================================
// ADMIN UPDATE EMPLOYEE
// ==========================================

const updateEmployee = async (req, res) => {
  try {
    const { id } =
      req.params;

    const {
      fullName,
      email,
      designation,
      mentorId,
    } = req.body;

    if (
      !fullName?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Employee name is required",
      });
    }

    const cleanedEmail =
      email?.trim().toLowerCase() ||
      null;

    // ======================================
    // VALIDATE MENTOR (interns) — undefined
    // means "not provided, leave unchanged";
    // null/"" explicitly clears it.
    // ======================================

    let cleanedMentorId;

    if (mentorId !== undefined) {

      if (mentorId === null || mentorId === "") {

        cleanedMentorId = null;

      } else {

        const mentorIdNumber = Number(mentorId);

        if (mentorIdNumber === Number(id)) {
          return res.status(400).json({
            success: false,
            message: "A user cannot be their own mentor",
          });
        }

        const [mentorRows] = await pool.query(
          `SELECT id, employment_status FROM users WHERE id = ? LIMIT 1`,
          [mentorIdNumber]
        );

        if (mentorRows.length === 0) {
          return res.status(400).json({
            success: false,
            message: "Selected mentor not found",
          });
        }

        if (mentorRows[0].employment_status !== "active") {
          return res.status(400).json({
            success: false,
            message: "Mentor must be an active user",
          });
        }

        cleanedMentorId = mentorIdNumber;

      }

    }

    // ======================================
    // VALIDATE EMAIL
    // ======================================

    if (cleanedEmail) {
      const emailPattern =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

      if (
        !emailPattern.test(
          cleanedEmail
        )
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Please enter a valid email address",
        });
      }

      // ====================================
      // CHECK DUPLICATE EMAIL
      // ====================================

      const [duplicateEmail] =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE LOWER(email) = ?
          AND id != ?
          LIMIT 1
          `,
          [
            cleanedEmail,
            id,
          ]
        );

      if (
        duplicateEmail.length > 0
      ) {
        return res.status(409).json({
          success: false,
          message:
            "Email address already exists",
        });
      }
    }

    // ======================================
    // UPDATE EMPLOYEE
    // ======================================

    // Designation is admin-only editable, unlike the employee
    // self-service endpoint (updateMyProfile below), which never
    // reads or updates it. Employee ID is deliberately never part
    // of this UPDATE — existing IDs stay stable once created.

    const cleanedDesignation =
      designation?.trim() ||
      null;

    const [beforeRows] = await pool.query(
      `SELECT designation FROM users WHERE id = ? AND role = 'employee' LIMIT 1`,
      [id]
    );

    const previousDesignation = beforeRows[0]?.designation || null;

    const connection =
      await pool.getConnection();

    let affectedRows = 0;

    try {

      await connection.beginTransaction();

      const [result] =
        cleanedMentorId !== undefined
          ? await connection.query(
              `
              UPDATE users
              SET
                full_name = ?,
                email = ?,
                designation = ?,
                mentor_id = ?
              WHERE id = ?
              AND role = 'employee'
              `,
              [
                fullName.trim(),
                cleanedEmail,
                cleanedDesignation,
                cleanedMentorId,
                id,
              ]
            )
          : await connection.query(
              `
              UPDATE users
              SET
                full_name = ?,
                email = ?,
                designation = ?
              WHERE id = ?
              AND role = 'employee'
              `,
              [
                fullName.trim(),
                cleanedEmail,
                cleanedDesignation,
                id,
              ]
            );

      affectedRows =
        result.affectedRows;

      if (affectedRows > 0) {

        // Keep the CURRENT (open) employment history period's
        // designation in sync with the live value — closed/past
        // periods are never touched, so they still reflect what the
        // designation actually was during that period.

        await connection.query(
          `
          UPDATE employment_history
          SET designation = ?
          WHERE user_id = ?
          AND end_date IS NULL
          `,
          [
            cleanedDesignation,
            id,
          ]
        );

        if (previousDesignation !== cleanedDesignation) {
          await recordOrganizationHistory(connection, {
            userId: id,
            changeType: "designation",
            oldValue: previousDesignation,
            newValue: cleanedDesignation,
            changedBy: req.user.id,
          });
        }

      }

      await connection.commit();

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (
      affectedRows === 0
    ) {
      return res.status(404).json({
        success: false,
        message:
          "Employee not found",
      });
    }

    return res.status(200).json({
      success: true,
      message:
        "Employee updated successfully",
    });
  } catch (error) {
    console.error(
      "Update Employee Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to update employee",
    });
  }
};

// ==========================================
// CHANGE EMPLOYEE STATUS - ADMIN
// ==========================================

const changeEmployeeStatus =
  async (req, res) => {
    try {
      const { id } =
        req.params;

      const { status } =
        req.body;

      if (
        ![
          "pending",
          "active",
          "inactive",
        ].includes(status)
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid employee status",
        });
      }

      const [result] =
        await pool.query(
          `
          UPDATE users
          SET status = ?
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            status,
            id,
          ]
        );

      if (
        result.affectedRows === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Employee not found",
        });
      }

      let message =
        "Employee status updated";

      if (
        status === "active"
      ) {
        message =
          "Employee approved and activated successfully";
      }

      if (
        status === "inactive"
      ) {
        message =
          "Employee deactivated successfully";
      }

      return res.status(200).json({
        success: true,
        message,
      });
    } catch (error) {
      console.error(
        "Employee Status Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to update employee status",
      });
    }
  };

// ==========================================
// SHARED EMPLOYEE SNAPSHOT SELECT
// Used to return the updated row after resign/
// terminate/rehire so the frontend can update
// its list state without a full reload.
// ==========================================

const EMPLOYEE_SNAPSHOT_COLUMNS = `
  u.id,
  u.employee_id,
  u.full_name,
  u.email,
  u.phone,
  u.address,
  u.date_of_birth,
  u.designation,
  u.emergency_contact,
  u.profile_photo,
  u.role,
  u.status,
  u.employment_type,
  u.employment_status,
  u.joining_date,
  u.last_working_date,
  u.internship_end_date,
  u.mentor_id,
  mentor.full_name AS mentor_name,
  u.stipend,
  u.exited_at,
  u.exit_reason,
  u.exit_notes,
  u.department_id,
  dep.name AS department_name,
  u.reporting_manager_id,
  manager.full_name AS reporting_manager_name,
  manager.employee_id AS reporting_manager_employee_id,
  u.system_access,
  u.project_access_override,
  u.project_access_level,
  u.last_login,
  u.created_at
`;

async function fetchEmployeeSnapshot(userId) {

  const [rows] = await pool.query(
    `
    SELECT ${EMPLOYEE_SNAPSHOT_COLUMNS}
    FROM users u
    LEFT JOIN users mentor ON mentor.id = u.mentor_id
    LEFT JOIN departments dep ON dep.id = u.department_id
    LEFT JOIN users manager ON manager.id = u.reporting_manager_id
    WHERE u.id = ?
    AND u.role = 'employee'
    LIMIT 1
    `,
    [userId]
  );

  return rows[0] || null;

}

// ==========================================
// MARK EMPLOYEE AS RESIGNED - ADMIN
//
// Employee history (profile, employee_id,
// attendance, tasks, meetings, chat) is never
// deleted here — only the account's login
// gating (status -> 'inactive') and lifecycle
// fields change, and the currently OPEN
// employment_history period is closed out.
// ==========================================

const resignEmployee = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      lastWorkingDate,
      resignationReason,
      exitNotes,
    } = req.body;

    if (!lastWorkingDate) {
      return res.status(400).json({
        success: false,
        message:
          "Last working date is required",
      });
    }

    const cleanedReason =
      resignationReason?.trim() ||
      null;

    const cleanedNotes =
      exitNotes?.trim() ||
      null;

    const activeReportsBlock =
      await blockIfHasActiveDirectReports(id);

    if (activeReportsBlock) {
      return res.status(409).json({
        success: false,
        message: activeReportsBlock,
      });
    }

    const connection =
      await pool.getConnection();

    let outcome = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_status
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        [
          "resigned",
          "terminated",
          "completed",
          "discontinued",
          "converted",
        ].includes(
          existing[0].employment_status
        )
      ) {
        await connection.rollback();
        outcome = "already_left";
      } else {

        await connection.query(
          `
          UPDATE users
          SET
            employment_status = 'resigned',
            status = 'inactive',
            last_working_date = ?,
            exited_at = NOW(),
            exit_reason = ?,
            exit_notes = ?
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            lastWorkingDate,
            cleanedReason,
            cleanedNotes,
            id,
          ]
        );

        await connection.query(
          `
          UPDATE employment_history
          SET
            end_date = ?,
            employment_status = 'resigned',
            exit_reason = ?,
            exit_notes = ?
          WHERE user_id = ?
          AND end_date IS NULL
          `,
          [
            lastWorkingDate,
            cleanedReason,
            cleanedNotes,
            id,
          ]
        );

        await connection.commit();
        outcome = "success";

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    if (outcome === "already_left") {
      return res.status(409).json({
        success: false,
        message:
          "This employee has already left the company",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        "Employee marked as resigned successfully",
      employee,
    });

  } catch (error) {
    console.error(
      "Resign Employee Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to mark employee as resigned",
    });
  }
};

// ==========================================
// TERMINATE EMPLOYEE - ADMIN
// Same shape as resignEmployee — see the notes
// there. Only employment_status differs
// ('terminated' vs 'resigned'); the reason is
// stored in the same exit_reason column either
// way, since employment_status already
// disambiguates why it's populated.
// ==========================================

const terminateEmployee = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      lastWorkingDate,
      terminationReason,
      exitNotes,
    } = req.body;

    if (!lastWorkingDate) {
      return res.status(400).json({
        success: false,
        message:
          "Last working date is required",
      });
    }

    const cleanedReason =
      terminationReason?.trim() ||
      null;

    const cleanedNotes =
      exitNotes?.trim() ||
      null;

    const activeReportsBlock =
      await blockIfHasActiveDirectReports(id);

    if (activeReportsBlock) {
      return res.status(409).json({
        success: false,
        message: activeReportsBlock,
      });
    }

    const connection =
      await pool.getConnection();

    let outcome = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_status
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        [
          "resigned",
          "terminated",
          "completed",
          "discontinued",
          "converted",
        ].includes(
          existing[0].employment_status
        )
      ) {
        await connection.rollback();
        outcome = "already_left";
      } else {

        await connection.query(
          `
          UPDATE users
          SET
            employment_status = 'terminated',
            status = 'inactive',
            last_working_date = ?,
            exited_at = NOW(),
            exit_reason = ?,
            exit_notes = ?
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            lastWorkingDate,
            cleanedReason,
            cleanedNotes,
            id,
          ]
        );

        await connection.query(
          `
          UPDATE employment_history
          SET
            end_date = ?,
            employment_status = 'terminated',
            exit_reason = ?,
            exit_notes = ?
          WHERE user_id = ?
          AND end_date IS NULL
          `,
          [
            lastWorkingDate,
            cleanedReason,
            cleanedNotes,
            id,
          ]
        );

        await connection.commit();
        outcome = "success";

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    if (outcome === "already_left") {
      return res.status(409).json({
        success: false,
        message:
          "This employee has already left the company",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        "Employee terminated successfully",
      employee,
    });

  } catch (error) {
    console.error(
      "Terminate Employee Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to terminate employee",
    });
  }
};

// ==========================================
// REHIRE EMPLOYEE - ADMIN
//
// Reactivates the SAME employee record/ID —
// never creates a new one — and opens a brand
// new employment_history period, leaving every
// previously closed period untouched. This is
// what keeps prior and current employment
// periods separate instead of overwriting
// history.
// ==========================================

const rehireEmployee = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      designation,
      joiningDate,
      notes,
    } = req.body;

    if (!designation?.trim()) {
      return res.status(400).json({
        success: false,
        message:
          "Designation is required",
      });
    }

    if (!joiningDate) {
      return res.status(400).json({
        success: false,
        message:
          "Joining date is required",
      });
    }

    const cleanedDesignation =
      designation.trim();

    const cleanedNotes =
      notes?.trim() ||
      null;

    const connection =
      await pool.getConnection();

    let outcome = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_type, employment_status, employee_id
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        existing[0].employment_type ===
        "intern"
      ) {
        // Former interns go through rehireIntern (rehire as intern
        // again) or convertInternToEmployee (hire as employee)
        // instead — this endpoint is employee-only, so their
        // employment_type/intern fields are never touched here.
        await connection.rollback();
        outcome = "wrong_type";
      } else if (
        existing[0].employment_status ===
        "active"
      ) {
        await connection.rollback();
        outcome = "already_active";
      } else {

        await connection.query(
          `
          UPDATE users
          SET
            employment_status = 'active',
            status = 'active',
            designation = ?,
            joining_date = ?,
            last_working_date = NULL,
            exited_at = NULL,
            exit_reason = NULL,
            exit_notes = NULL
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            cleanedDesignation,
            joiningDate,
            id,
          ]
        );

        await connection.query(
          `
          INSERT INTO employment_history
          (
            user_id,
            employment_type,
            identifier,
            designation,
            start_date,
            end_date,
            employment_status,
            notes
          )
          VALUES
          (
            ?,
            'employee',
            ?,
            ?,
            ?,
            NULL,
            'active',
            ?
          )
          `,
          [
            id,
            existing[0].employee_id,
            cleanedDesignation,
            joiningDate,
            cleanedNotes,
          ]
        );

        await connection.commit();
        outcome = "success";

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Employee not found",
      });
    }

    if (outcome === "already_active") {
      return res.status(409).json({
        success: false,
        message:
          "This employee is already active",
      });
    }

    if (outcome === "wrong_type") {
      return res.status(409).json({
        success: false,
        message:
          "This person's most recent role was an internship — use Rehire as Intern or Hire as Employee instead",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        "Employee rehired successfully",
      employee,
    });

  } catch (error) {
    console.error(
      "Rehire Employee Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to rehire employee",
    });
  }
};

// ==========================================
// COMPLETE INTERNSHIP - ADMIN
// Same shape as resignEmployee/terminateEmployee
// — see the notes there. employment_status
// becomes 'completed'; there is no separate
// "reason" input for a successful completion
// (only a completion date + optional notes), so
// exit_reason is left NULL here.
// ==========================================

const completeInternship = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      completionDate,
      completionNotes,
    } = req.body;

    if (!completionDate) {
      return res.status(400).json({
        success: false,
        message:
          "Completion date is required",
      });
    }

    const cleanedNotes =
      completionNotes?.trim() ||
      null;

    const activeReportsBlock =
      await blockIfHasActiveDirectReports(id);

    if (activeReportsBlock) {
      return res.status(409).json({
        success: false,
        message: activeReportsBlock,
      });
    }

    const connection =
      await pool.getConnection();

    let outcome = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_type, employment_status
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        existing[0].employment_type !==
        "intern"
      ) {
        await connection.rollback();
        outcome = "wrong_type";
      } else if (
        [
          "completed",
          "discontinued",
          "terminated",
          "converted",
        ].includes(
          existing[0].employment_status
        )
      ) {
        await connection.rollback();
        outcome = "already_left";
      } else {

        await connection.query(
          `
          UPDATE users
          SET
            employment_status = 'completed',
            status = 'inactive',
            last_working_date = ?,
            exited_at = NOW(),
            exit_reason = NULL,
            exit_notes = ?
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            completionDate,
            cleanedNotes,
            id,
          ]
        );

        await connection.query(
          `
          UPDATE employment_history
          SET
            end_date = ?,
            employment_status = 'completed',
            exit_reason = NULL,
            exit_notes = ?
          WHERE user_id = ?
          AND end_date IS NULL
          `,
          [
            completionDate,
            cleanedNotes,
            id,
          ]
        );

        await connection.commit();
        outcome = "success";

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Intern not found",
      });
    }

    if (outcome === "wrong_type") {
      return res.status(409).json({
        success: false,
        message:
          "This person is not currently an intern",
      });
    }

    if (outcome === "already_left") {
      return res.status(409).json({
        success: false,
        message:
          "This internship has already ended",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        "Internship marked as completed successfully",
      employee,
    });

  } catch (error) {
    console.error(
      "Complete Internship Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to complete internship",
    });
  }
};

// ==========================================
// DISCONTINUE INTERNSHIP - ADMIN
// Same shape as resignEmployee — see the notes
// there. employment_status becomes
// 'discontinued'.
// ==========================================

const discontinueInternship = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      lastWorkingDate,
      reason,
      notes,
    } = req.body;

    if (!lastWorkingDate) {
      return res.status(400).json({
        success: false,
        message:
          "Last working date is required",
      });
    }

    const cleanedReason =
      reason?.trim() ||
      null;

    const cleanedNotes =
      notes?.trim() ||
      null;

    const activeReportsBlock =
      await blockIfHasActiveDirectReports(id);

    if (activeReportsBlock) {
      return res.status(409).json({
        success: false,
        message: activeReportsBlock,
      });
    }

    const connection =
      await pool.getConnection();

    let outcome = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_type, employment_status
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        existing[0].employment_type !==
        "intern"
      ) {
        await connection.rollback();
        outcome = "wrong_type";
      } else if (
        [
          "completed",
          "discontinued",
          "terminated",
          "converted",
        ].includes(
          existing[0].employment_status
        )
      ) {
        await connection.rollback();
        outcome = "already_left";
      } else {

        await connection.query(
          `
          UPDATE users
          SET
            employment_status = 'discontinued',
            status = 'inactive',
            last_working_date = ?,
            exited_at = NOW(),
            exit_reason = ?,
            exit_notes = ?
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            lastWorkingDate,
            cleanedReason,
            cleanedNotes,
            id,
          ]
        );

        await connection.query(
          `
          UPDATE employment_history
          SET
            end_date = ?,
            employment_status = 'discontinued',
            exit_reason = ?,
            exit_notes = ?
          WHERE user_id = ?
          AND end_date IS NULL
          `,
          [
            lastWorkingDate,
            cleanedReason,
            cleanedNotes,
            id,
          ]
        );

        await connection.commit();
        outcome = "success";

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Intern not found",
      });
    }

    if (outcome === "wrong_type") {
      return res.status(409).json({
        success: false,
        message:
          "This person is not currently an intern",
      });
    }

    if (outcome === "already_left") {
      return res.status(409).json({
        success: false,
        message:
          "This internship has already ended",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        "Internship discontinued successfully",
      employee,
    });

  } catch (error) {
    console.error(
      "Discontinue Internship Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to discontinue internship",
    });
  }
};

// ==========================================
// CONVERT INTERN TO EMPLOYEE - ADMIN
//
// The SAME users row/id is reused — never a new
// account. The current (intern) employment_
// history period is closed with
// employment_status='converted', WITHOUT
// touching its own employment_type/identifier
// snapshot ('intern'/INT###), which is exactly
// what keeps the old Intern ID visible in
// history afterward. A brand new "RS" employee_id
// is then generated and applied directly to the
// row (with the same duplicate-key retry safety
// net createEmployee uses), and a new OPEN
// employment_history period is opened under
// employment_type='employee' with that new ID.
//
// Works whether the intern is currently active or
// already former (completed/discontinued/
// terminated) — this also serves Part 10's
// "Hire as Employee" action for former interns,
// so there is only one conversion endpoint.
// ==========================================

const convertInternToEmployee = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      designation,
      joiningDate,
      notes,
    } = req.body;

    if (!designation?.trim()) {
      return res.status(400).json({
        success: false,
        message:
          "Designation is required",
      });
    }

    if (!joiningDate) {
      return res.status(400).json({
        success: false,
        message:
          "Employee joining date is required",
      });
    }

    const cleanedDesignation =
      designation.trim();

    const cleanedNotes =
      notes?.trim() ||
      null;

    const connection =
      await pool.getConnection();

    let outcome = null;

    let newEmployeeId = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_type
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        existing[0].employment_type !==
        "intern"
      ) {
        await connection.rollback();
        outcome = "wrong_type";
      } else {

        // Close the internship period (a no-op if it was already
        // closed, e.g. converting a former intern) — its
        // employment_type/identifier snapshot is left untouched.

        await connection.query(
          `
          UPDATE employment_history
          SET
            end_date = CURDATE(),
            employment_status = 'converted'
          WHERE user_id = ?
          AND end_date IS NULL
          `,
          [id]
        );

        const MAX_ID_ATTEMPTS = 5;

        let applied = false;

        for (
          let attempt = 0;
          attempt < MAX_ID_ATTEMPTS;
          attempt += 1
        ) {

          newEmployeeId =
            await generateNextEmployeeId();

          try {

            await connection.query(
              `
              UPDATE users
              SET
                employee_id = ?,
                employment_type = 'employee',
                employment_status = 'active',
                status = 'active',
                designation = ?,
                joining_date = ?,
                last_working_date = NULL,
                exited_at = NULL,
                exit_reason = NULL,
                exit_notes = NULL,
                internship_end_date = NULL,
                mentor_id = NULL,
                stipend = NULL
              WHERE id = ?
              AND role = 'employee'
              `,
              [
                newEmployeeId,
                cleanedDesignation,
                joiningDate,
                id,
              ]
            );

            applied = true;
            break;

          } catch (updateError) {

            const isDuplicateEmployeeId =
              updateError.code === "ER_DUP_ENTRY" &&
              updateError.message?.includes(
                "employee_id"
              );

            if (!isDuplicateEmployeeId) {
              throw updateError;
            }

            // loop again with a freshly generated ID

          }

        }

        if (!applied) {
          await connection.rollback();
          outcome = "id_generation_failed";
        } else {

          await connection.query(
            `
            INSERT INTO employment_history
            (
              user_id,
              employment_type,
              identifier,
              designation,
              start_date,
              end_date,
              employment_status,
              notes
            )
            VALUES
            (
              ?,
              'employee',
              ?,
              ?,
              ?,
              NULL,
              'active',
              ?
            )
            `,
            [
              id,
              newEmployeeId,
              cleanedDesignation,
              joiningDate,
              cleanedNotes,
            ]
          );

          await connection.commit();
          outcome = "success";

        }

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Intern not found",
      });
    }

    if (outcome === "wrong_type") {
      return res.status(409).json({
        success: false,
        message:
          "This person is not currently an intern",
      });
    }

    if (outcome === "id_generation_failed") {
      return res.status(500).json({
        success: false,
        message:
          "Unable to generate a unique employee ID, please try again",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        `Intern converted to employee successfully (${newEmployeeId})`,
      employee,
    });

  } catch (error) {
    console.error(
      "Convert Intern To Employee Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to convert intern to employee",
    });
  }
};

// ==========================================
// REHIRE INTERN - ADMIN
//
// Reuses the SAME Intern ID the person already
// has (it was never reassigned and never will
// be) rather than generating a new one — see
// generateNextIdentifier's comment for why
// former IDs are never recycled to a DIFFERENT
// person; reusing this person's own existing ID
// for their own new period isn't that case.
// Opens a brand new employment_history period,
// leaving every previously closed period
// untouched.
// ==========================================

const rehireIntern = async (req, res) => {
  try {

    const { id } = req.params;

    const {
      designation,
      joiningDate,
      notes,
    } = req.body;

    if (!designation?.trim()) {
      return res.status(400).json({
        success: false,
        message:
          "Designation is required",
      });
    }

    if (!joiningDate) {
      return res.status(400).json({
        success: false,
        message:
          "Joining date is required",
      });
    }

    const cleanedDesignation =
      designation.trim();

    const cleanedNotes =
      notes?.trim() ||
      null;

    const connection =
      await pool.getConnection();

    let outcome = null;

    try {

      await connection.beginTransaction();

      const [existing] =
        await connection.query(
          `
          SELECT id, employment_type, employment_status, employee_id
          FROM users
          WHERE id = ?
          AND role = 'employee'
          FOR UPDATE
          `,
          [id]
        );

      if (existing.length === 0) {
        await connection.rollback();
        outcome = "not_found";
      } else if (
        existing[0].employment_type !==
        "intern"
      ) {
        await connection.rollback();
        outcome = "wrong_type";
      } else if (
        existing[0].employment_status ===
        "active"
      ) {
        await connection.rollback();
        outcome = "already_active";
      } else {

        await connection.query(
          `
          UPDATE users
          SET
            employment_status = 'active',
            status = 'active',
            designation = ?,
            joining_date = ?,
            last_working_date = NULL,
            exited_at = NULL,
            exit_reason = NULL,
            exit_notes = NULL
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            cleanedDesignation,
            joiningDate,
            id,
          ]
        );

        await connection.query(
          `
          INSERT INTO employment_history
          (
            user_id,
            employment_type,
            identifier,
            designation,
            start_date,
            end_date,
            employment_status,
            notes
          )
          VALUES
          (
            ?,
            'intern',
            ?,
            ?,
            ?,
            NULL,
            'active',
            ?
          )
          `,
          [
            id,
            existing[0].employee_id,
            cleanedDesignation,
            joiningDate,
            cleanedNotes,
          ]
        );

        await connection.commit();
        outcome = "success";

      }

    } catch (transactionError) {
      await connection.rollback();
      throw transactionError;
    } finally {
      connection.release();
    }

    if (outcome === "not_found") {
      return res.status(404).json({
        success: false,
        message: "Intern not found",
      });
    }

    if (outcome === "wrong_type") {
      return res.status(409).json({
        success: false,
        message:
          "This person's most recent role was an employee — use Rehire Employee or Convert to Employee instead",
      });
    }

    if (outcome === "already_active") {
      return res.status(409).json({
        success: false,
        message:
          "This intern is already active",
      });
    }

    const employee =
      await fetchEmployeeSnapshot(id);

    return res.status(200).json({
      success: true,
      message:
        "Intern rehired successfully",
      employee,
    });

  } catch (error) {
    console.error(
      "Rehire Intern Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to rehire intern",
    });
  }
};

// ==========================================
// GET EMPLOYMENT HISTORY - ADMIN
// All periods for one employee, most recent
// first.
// ==========================================

const getEmploymentHistory = async (req, res) => {
  try {

    const { id } = req.params;

    const [history] =
      await pool.query(
        `
        SELECT
          id,
          user_id,
          employment_type,
          identifier,
          designation,
          start_date,
          end_date,
          employment_status,
          notes,
          exit_reason,
          exit_notes,
          created_at,
          updated_at
        FROM employment_history
        WHERE user_id = ?
        ORDER BY start_date DESC, id DESC
        `,
        [id]
      );

    return res.status(200).json({
      success: true,
      history,
    });

  } catch (error) {
    console.error(
      "Get Employment History Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load employment history",
    });
  }
};

// ==========================================
// GET MY PROFILE - EMPLOYEE
// ==========================================

const getMyProfile =
  async (req, res) => {
    try {
      const userId =
        req.user.id;

      const [users] =
        await pool.query(
          `
          SELECT
            id,
            employee_id,
            first_name,
            last_name,
            full_name,
            email,
            phone,
            address,
            date_of_birth,
            designation,
            emergency_contact,
            profile_photo,
            role,
            status,
            last_login,
            created_at,
            updated_at
          FROM users
          WHERE id = ?
          AND role = 'employee'
          LIMIT 1
          `,
          [userId]
        );

      if (
        users.length === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Employee profile not found",
        });
      }

      return res.status(200).json({
        success: true,
        profile:
          users[0],
      });
    } catch (error) {
      console.error(
        "Get My Profile Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to load profile",
      });
    }
  };

// ==========================================
// UPDATE MY PROFILE - EMPLOYEE
// ==========================================

const updateMyProfile =
  async (req, res) => {
    try {
      const userId =
        req.user.id;

      const {
        fullName,
        email,
        phone,
        address,
        dateOfBirth,
        emergencyContact,
      } = req.body;

      // employee_id/employeeId and designation are deliberately
      // never read from req.body here — this is the employee's own
      // self-service profile update, and both fields are admin-
      // managed. Even if a request includes them (e.g. a manually
      // crafted API call), they are ignored: this destructure never
      // captures them, and the UPDATE below never sets them.

      // ====================================
      // VALIDATE FULL NAME
      // ====================================

      if (
        !fullName?.trim()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Full name is required",
        });
      }

      // ====================================
      // CLEAN EMAIL
      // ====================================

      const cleanedEmail =
        email?.trim().toLowerCase() ||
        null;

      // ====================================
      // VALIDATE EMAIL
      // ====================================

      if (cleanedEmail) {
        const emailPattern =
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (
          !emailPattern.test(
            cleanedEmail
          )
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Please enter a valid email address",
          });
        }

        // ==================================
        // CHECK DUPLICATE EMAIL
        // ==================================

        const [existingEmail] =
          await pool.query(
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = ?
            AND id != ?
            LIMIT 1
            `,
            [
              cleanedEmail,
              userId,
            ]
          );

        if (
          existingEmail.length > 0
        ) {
          return res.status(409).json({
            success: false,
            message:
              "This email address is already used by another account",
          });
        }
      }

      // ====================================
      // UPDATE PROFILE
      // ====================================

      const [result] =
        await pool.query(
          `
          UPDATE users
          SET
            full_name = ?,
            email = ?,
            phone = ?,
            address = ?,
            date_of_birth = ?,
            emergency_contact = ?
          WHERE id = ?
          AND role = 'employee'
          `,
          [
            fullName.trim(),
            cleanedEmail,
            phone?.trim() ||
              null,
            address?.trim() ||
              null,
            dateOfBirth ||
              null,
            emergencyContact?.trim() ||
              null,
            userId,
          ]
        );

      if (
        result.affectedRows === 0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "Employee profile not found",
        });
      }

      // ====================================
      // GET UPDATED PROFILE
      // ====================================

      const [updatedProfile] =
        await pool.query(
          `
          SELECT
            id,
            employee_id,
            first_name,
            last_name,
            full_name,
            email,
            phone,
            address,
            date_of_birth,
            designation,
            emergency_contact,
            profile_photo,
            role,
            status,
            last_login,
            created_at,
            updated_at
          FROM users
          WHERE id = ?
          AND role = 'employee'
          LIMIT 1
          `,
          [userId]
        );

      return res.status(200).json({
        success: true,
        message:
          "Profile updated successfully",
        profile:
          updatedProfile[0],
      });
    } catch (error) {
      console.error(
        "Update My Profile Error:",
        error
      );

      return res.status(500).json({
        success: false,
        message:
          "Unable to update profile",
      });
    }
  };

// ==========================================
// UPLOAD PROFILE PHOTO - EMPLOYEE
// ==========================================

const uploadMyProfilePhoto =
  async (req, res) => {
    try {
      const userId =
        req.user.id;

      // ====================================
      // CHECK UPLOADED FILE
      // ====================================

      if (!req.file) {
        return res.status(400).json({
          success: false,
          message:
            "Please select a profile photo",
        });
      }

      // ====================================
      // GET EXISTING PROFILE PHOTO
      // ====================================

      const [users] =
        await pool.query(
          `
          SELECT
            profile_photo
          FROM users
          WHERE id = ?
          AND role = 'employee'
          LIMIT 1
          `,
          [userId]
        );

      if (
        users.length === 0
      ) {
        if (
          fs.existsSync(
            req.file.path
          )
        ) {
          fs.unlinkSync(
            req.file.path
          );
        }

        return res.status(404).json({
          success: false,
          message:
            "Employee profile not found",
        });
      }

      const oldProfilePhoto =
        users[0].profile_photo;

      // ====================================
      // SAVE PHOTO URL
      // ====================================

      const profilePhoto =
        tenantUploadUrlPath("profiles", req.file.filename);

      await pool.query(
        `
        UPDATE users
        SET profile_photo = ?
        WHERE id = ?
        AND role = 'employee'
        `,
        [
          profilePhoto,
          userId,
        ]
      );

      // ====================================
      // DELETE OLD PROFILE PHOTO
      // ====================================

      if (
        oldProfilePhoto
      ) {
        // Resolve against the uploads root directly (not just the
        // basename + a hardcoded flat directory) -- oldProfilePhoto
        // may be either a legacy flat path (uploads/profiles/...) or
        // a new tenant-prefixed one (uploads/tenant_<slug>/profiles/...),
        // and this must correctly locate either.
        const oldPhotoPath =
          path.join(
            UPLOADS_ROOT,
            oldProfilePhoto.replace(/^\/uploads\//, "")
          );

        // Defense in depth: never unlink anything outside the
        // uploads root, regardless of what oldProfilePhoto contains.
        const isInsideUploads =
          oldPhotoPath === UPLOADS_ROOT ||
          oldPhotoPath.startsWith(UPLOADS_ROOT + path.sep);

        if (
          isInsideUploads &&
          fs.existsSync(
            oldPhotoPath
          )
        ) {
          try {
            fs.unlinkSync(
              oldPhotoPath
            );
          } catch (
            deleteError
          ) {
            console.error(
              "Unable to delete old profile photo:",
              deleteError
            );
          }
        }
      }

      // ====================================
      // GET UPDATED PROFILE
      // ====================================

      const [updatedProfile] =
        await pool.query(
          `
          SELECT
            id,
            employee_id,
            full_name,
            email,
            phone,
            address,
            date_of_birth,
            designation,
            emergency_contact,
            profile_photo,
            role,
            status
          FROM users
          WHERE id = ?
          AND role = 'employee'
          LIMIT 1
          `,
          [userId]
        );

      return res.status(200).json({
        success: true,
        message:
          "Profile photo updated successfully",
        profilePhoto,
        profile:
          updatedProfile[0],
      });
    } catch (error) {
      console.error(
        "Upload Profile Photo Error:",
        error
      );

      // ====================================
      // REMOVE FAILED UPLOAD
      // ====================================

      if (
        req.file?.path &&
        fs.existsSync(
          req.file.path
        )
      ) {
        try {
          fs.unlinkSync(
            req.file.path
          );
        } catch (
          deleteError
        ) {
          console.error(
            "Unable to remove failed upload:",
            deleteError
          );
        }
      }

      return res.status(500).json({
        success: false,
        message:
          "Unable to upload profile photo",
      });
    }
  };

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getEmployees,
  createEmployee,
  updateEmployee,
  changeEmployeeStatus,
  getMyProfile,
  updateMyProfile,
  uploadMyProfilePhoto,
  getNextEmployeeId,
  getNextInternId,
  resignEmployee,
  terminateEmployee,
  rehireEmployee,
  getEmploymentHistory,
  completeInternship,
  discontinueInternship,
  convertInternToEmployee,
  rehireIntern,
};