const express = require("express");

const {
  login,
  forceChangePassword,
  registerEmployee,
  changePassword,
} = require(
  "../controllers/authController"
);

const {
  protect,
  adminOnly,
} = require(
  "../middleware/authMiddleware"
);

const { authLoginLimiter } = require("../middleware/rateLimiters");

const router =
  express.Router();

// ==========================================
// EMPLOYEE REGISTRATION
// ==========================================

router.post(
  "/register-employee",
  registerEmployee
);

// ==========================================
// LOGIN
// ==========================================

router.post(
  "/login",
  authLoginLimiter,
  login
);

// ==========================================
// CHANGE PASSWORD
// LOGGED-IN USER ONLY
// ==========================================

// Mandatory first-login password change: authenticated by the challenge token from login, not
// by `protect` (there is no session yet); same brute-force limiter as login.
router.post(
  "/force-change-password",
  authLoginLimiter,
  forceChangePassword
);


router.put(
  "/change-password",
  protect,
  changePassword
);

// ==========================================
// VERIFY AUTHENTICATION
// ==========================================

router.get(
  "/verify",
  protect,
  (req, res) => {
    return res
      .status(200)
      .json({
        success: true,

        message:
          "Authentication token is valid",

        user:
          req.user,
      });
  }
);

// ==========================================
// VERIFY ADMIN ACCESS
// ==========================================

router.get(
  "/admin-verify",
  protect,
  adminOnly,
  (req, res) => {
    return res
      .status(200)
      .json({
        success: true,

        message:
          "Administrator access verified",

        user:
          req.user,
      });
  }
);

// ==========================================
// EXPORT ROUTER
// ==========================================

module.exports =
  router;