const jwt = require("jsonwebtoken");

// ==========================================
// PROTECT (legacy Reinsteins auth, enhanced -- GrowOrgs Fast
// Completion Phase, Part 3)
//
// The legacy-verification branch below is BYTE-IDENTICAL to this
// function's behavior before this phase: same jwt.verify(token,
// JWT_SECRET) call, same req.user assignment, same next(). A legacy
// Reinsteins token ALWAYS succeeds on this first attempt and never
// reaches the code added below it -- so every existing authenticated
// request (the entire current Reinsteins portal, unmodified frontend
// included) behaves exactly as it did before this phase.
//
// NEW: only when legacy verification fails outright does this fall
// through to tenantProtect (Phase 2F) as a second attempt. This is
// what lets a single `protect` -- used by all 24 existing tenant
// route files, completely unmodified -- also accept the new
// company-aware tenant JWT, without touching a single route or
// controller file. tenantProtect re-verifies against
// TENANT_JWT_SECRET (a different secret entirely), resolves the
// caller's company fresh from the platform DB, and runs the rest of
// the request inside the AsyncLocalStorage context that makes
// config/db.js resolve to that company's own tenant database (see
// config/db.js and tenantAuthMiddleware.js for the mechanism).
//
// A garbage/forged token fails BOTH attempts and still gets the same
// generic 401 as before.
// ==========================================

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const token = authHeader.split(" ")[1];

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (_legacyVerifyError) {
      // Not a valid legacy token -- fall through to the tenant-aware
      // attempt below rather than failing immediately.
    }

    const { tenantProtect } = require("./tenantAuthMiddleware");
    return tenantProtect(req, res, next);

  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired authentication token",
    });
  }
};

const adminOnly = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "Administrator access required",
    });
  }

  next();
};

module.exports = {
  protect,
  adminOnly,
};