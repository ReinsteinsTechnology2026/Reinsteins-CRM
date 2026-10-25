const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const pool = require("../config/db");
const { SCOPES, signChallenge } = require("../utils/passwordChangeChallenge");
const { readChallenge, applyForcedPasswordChange } = require("../services/forcedPasswordChangeService");
const { describePasswordPolicy } = require("../utils/passwordPolicy");

// ==========================================
// LOGIN
// ==========================================

const login = async (req, res) => {
  try {
    const {
      employeeId,
      password,
    } = req.body;

    if (
      !employeeId ||
      !password
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Employee ID and password are required",
      });
    }

    // Phase 17c: accepts the same submitted value as either an
    // employee ID or a company email address, same widening as
    // tenantAuthController.js's login.
    const loginIdentifier =
      String(employeeId).trim();

    const [users] =
      await pool.query(
        `
        SELECT
          id,
          employee_id,
          full_name,
          email,
          password,
          role,
          designation,
          status,
          employment_status,
          system_access,
          project_access_override,
          must_change_password
        FROM users
        WHERE employee_id = ? OR LOWER(email) = LOWER(?)
        LIMIT 1
        `,
        [
          loginIdentifier,
          loginIdentifier,
        ]
      );

    if (
      users.length === 0
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid Employee ID or password",
      });
    }

    const user =
      users[0];

    // employment_status is checked in addition to (not instead of)
    // the existing status check — resign/terminate always also set
    // status='inactive', so this is defense in depth rather than
    // the only gate, in case the two ever fall out of sync.

    if (
      user.status !==
        "active" ||
      (user.employment_status &&
        user.employment_status !==
          "active")
    ) {
      return res.status(403).json({
        success: false,
        message:
          "Your WorkHub account is no longer active. Please contact your administrator.",
      });
    }

    const passwordMatches =
      await bcrypt.compare(
        password,
        user.password
      );

    if (
      !passwordMatches
    ) {
      return res.status(401).json({
        success: false,
        message:
          "Invalid Employee ID or password",
      });
    }

    // Mandatory password change: a temporary password buys only a short-lived,
    // single-purpose challenge -- no session. `protect` rejects that token, so no normal API
    // is reachable until the password has been replaced (utils/passwordChangeChallenge.js).
    if (user.must_change_password === true) {
      return res.status(200).json({
        success: true,
        passwordChangeRequired: true,
        challengeToken: signChallenge({
          scope: SCOPES.LEGACY,
          userId: user.id,
          passwordHash: user.password,
        }),
        passwordPolicy: describePasswordPolicy(),
        user: {
          fullName: user.full_name,
          employeeId: user.employee_id,
        },
      });
    }

    const token =
      jwt.sign(
        {
          id:
            user.id,

          employeeId:
            user.employee_id,

          role:
            user.role,
        },

        process.env.JWT_SECRET,

        {
          expiresIn:
            "8h",
        }
      );

    await pool.query(
      `
      UPDATE users
      SET last_login = NOW()
      WHERE id = ?
      `,
      [
        user.id,
      ]
    );

    return res.status(200).json({
      success: true,

      message:
        "Login successful",

      token,

      user: {
        id:
          user.id,

        employeeId:
          user.employee_id,

        fullName:
          user.full_name,

       email: user.email,

designation: user.designation,

role: user.role,

        systemAccess:
          user.system_access,

        projectAccessOverride:
          user.project_access_override,
      },
    });
  } catch (error) {
    console.error(
      "Login Error:",
      error
    );

    return res.status(500).json({
      success: false,

      message:
        "Internal server error",
    });
  }
};

// ==========================================
// REGISTER EMPLOYEE
// ==========================================

const registerEmployee =
  async (req, res) => {
    try {
      const {
        firstName,
        lastName,
        password,
        confirmPassword,
      } = req.body;

      if (
        !firstName ||
        !lastName ||
        !password ||
        !confirmPassword
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "All fields are required",
          });
      }

      if (
        password !==
        confirmPassword
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Passwords do not match",
          });
      }

      if (
        password.length <
        8
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Password must contain at least 8 characters",
          });
      }

      const connection =
        await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [lastEmployees] =
          await connection.query(
            `
            SELECT employee_id
            FROM users
            WHERE role = 'employee'
            AND employee_id LIKE 'RS%'
            ORDER BY
              CAST(
                SUBSTRING(
                  employee_id,
                  3
                )
                AS INTEGER
              ) DESC
            LIMIT 1
            FOR UPDATE
            `
          );

        let nextNumber =
          1;

        if (
          lastEmployees.length >
          0
        ) {
          const lastNumber =
            parseInt(
              lastEmployees[0]
                .employee_id
                .substring(2),

              10
            );

          nextNumber =
            lastNumber +
            1;
        }

        const employeeId =
          "RS" +
          String(
            nextNumber
          ).padStart(
            3,
            "0"
          );

        const fullName =
          `${firstName.trim()} ${lastName.trim()}`;

        const hashedPassword =
          await bcrypt.hash(
            password,
            12
          );

        await connection.query(
          `
          INSERT INTO users
          (
            employee_id,
            first_name,
            last_name,
            full_name,
            email,
            password,
            role,
            status
          )
          VALUES
          (
            ?,
            ?,
            ?,
            ?,
            NULL,
            ?,
            'employee',
            'pending'
          )
          `,
          [
            employeeId,

            firstName.trim(),

            lastName.trim(),

            fullName,

            hashedPassword,
          ]
        );

        await connection.commit();

        return res
          .status(201)
          .json({
            success:
              true,

            message:
              "Account created successfully. Waiting for administrator approval.",

            employeeId,

            status:
              "pending",
          });
      } catch (error) {
        await connection.rollback();

        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error(
        "Employee Registration Error:",
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          message:
            "Unable to create employee account",
        });
    }
  };

// ==========================================
// CHANGE PASSWORD
// LOGGED-IN USER
// ==========================================

const changePassword =
  async (req, res) => {
    try {
      const userId =
        req.user.id;

      const {
        currentPassword,
        newPassword,
        confirmPassword,
      } = req.body;

      // ======================================
      // VALIDATION
      // ======================================

      if (
        !currentPassword ||
        !newPassword ||
        !confirmPassword
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Current password, new password and confirm password are required",
          });
      }

      if (
        newPassword !==
        confirmPassword
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "New password and confirm password do not match",
          });
      }

      if (
        newPassword.length <
        8
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "New password must contain at least 8 characters",
          });
      }

      // ======================================
      // GET CURRENT USER
      // ======================================

      const [users] =
        await pool.query(
          `
          SELECT
            id,
            password
          FROM users
          WHERE id = ?
          LIMIT 1
          `,
          [
            userId,
          ]
        );

      if (
        users.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            success:
              false,

            message:
              "User account not found",
          });
      }

      const user =
        users[0];

      // ======================================
      // VERIFY CURRENT PASSWORD
      // ======================================

      const currentPasswordMatches =
        await bcrypt.compare(
          currentPassword,
          user.password
        );

      if (
        !currentPasswordMatches
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "Current password is incorrect",
          });
      }

      // ======================================
      // PREVENT SAME PASSWORD
      // ======================================

      const samePassword =
        await bcrypt.compare(
          newPassword,
          user.password
        );

      if (
        samePassword
      ) {
        return res
          .status(400)
          .json({
            success:
              false,

            message:
              "New password cannot be the same as your current password",
          });
      }

      // ======================================
      // HASH NEW PASSWORD
      // ======================================

      const hashedPassword =
        await bcrypt.hash(
          newPassword,
          12
        );

      // ======================================
      // UPDATE PASSWORD
      // ======================================

      await pool.query(
        `
        UPDATE users
        SET password = ?
        WHERE id = ?
        `,
        [
          hashedPassword,
          userId,
        ]
      );

      return res
        .status(200)
        .json({
          success:
            true,

          message:
            "Password changed successfully",
        });
    } catch (error) {
      console.error(
        "Change Password Error:",
        error
      );

      return res
        .status(500)
        .json({
          success:
            false,

          message:
            "Unable to change password",
        });
    }
  };

// ==========================================
// FORCED PASSWORD CHANGE (legacy login)
//
// POST /api/auth/force-change-password
//   Authorization: Bearer <challengeToken from login>
//   body: { temporaryPassword, newPassword, confirmPassword }
//
// Not behind `protect`: the caller has no session yet. Authenticated by the challenge token
// only; the user comes from that token, never from the body. On success a normal session is
// issued, exactly as login would have.
// ==========================================

const forceChangePassword = async (req, res) => {
  try {
    const challenge = readChallenge(req, SCOPES.LEGACY);

    if (challenge.error) {
      return res.status(challenge.error.status).json(challenge.error.body);
    }

    const { temporaryPassword, newPassword, confirmPassword } = req.body || {};

    const result = await applyForcedPasswordChange({
      pool,
      claims: challenge.claims,
      temporaryPassword,
      newPassword,
      confirmPassword,
    });

    if (!result.user) {
      return res.status(result.status).json(result.body);
    }

    const [rows] = await pool.query(
      `SELECT id, employee_id, full_name, email, role, designation, system_access, project_access_override
       FROM users WHERE id = ? LIMIT 1`,
      [result.user.id]
    );
    const user = rows[0];

    const token = jwt.sign(
      { id: user.id, employeeId: user.employee_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "8h" }
    );

    await pool.query(`UPDATE users SET last_login = NOW() WHERE id = ?`, [user.id]);

    return res.status(200).json({
      success: true,
      message: "Password changed successfully.",
      token,
      user: {
        id: user.id,
        employeeId: user.employee_id,
        fullName: user.full_name,
        email: user.email,
        designation: user.designation,
        role: user.role,
        systemAccess: user.system_access,
        projectAccessOverride: user.project_access_override,
      },
    });
  } catch (error) {
    console.error("Force Change Password Error:", error.message);
    return res.status(500).json({ success: false, message: "Unable to change the password." });
  }
};

// ==========================================
// EXPORT CONTROLLERS
// ==========================================

module.exports = {
  login,
  forceChangePassword,
  registerEmployee,
  changePassword,
};