const jwt = require("jsonwebtoken");

const platformUserService = require("../services/platformUserService");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE, PLATFORM_JWT_ALGORITHM } = require("../controllers/platformAuthController");

// ==========================================
// PLATFORM PROTECT (Phase 2B)
//
// Isolated counterpart to server/middleware/authMiddleware.js's
// `protect` -- that file is completely untouched by this one.
//
// Verifies the token against PLATFORM_JWT_SECRET (never
// JWT_SECRET) with the matching issuer/audience, then re-checks
// the user against groworgs_platform_db.platform_users (never
// the tenant `users` table) to confirm the account still exists
// and is active -- a revoked/deleted Platform Owner's old token
// stops working immediately, it isn't just trusted until expiry.
//
// A tenant JWT (signed with JWT_SECRET, no issuer/audience, no
// `type` claim) fails jwt.verify() here outright -- wrong secret,
// wrong issuer/audience -- before any claim is even inspected.
// The reverse holds in the existing tenant `protect`: a platform
// JWT fails there too, since it's signed with a different secret
// entirely. Neither middleware needs to know the other exists.
// ==========================================

const platformProtect = async (req, res, next) => {

    try {

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Platform authentication required",
            });
        }

        const token = authHeader.split(" ")[1];

        // Phase 14E -- algorithms explicitly pinned to the one this
        // codebase ever signs with (HS256), not left to whatever the
        // token's own header claims. jsonwebtoken already defends
        // against the classic "alg: none" / RS256-key-as-HMAC-secret
        // confusion attacks by default, but pinning explicitly removes
        // any doubt and matches Part E's "algorithm handling is
        // explicit and safe" requirement directly.
        const decoded = jwt.verify(token, process.env.PLATFORM_JWT_SECRET, {
            issuer: PLATFORM_JWT_ISSUER,
            audience: PLATFORM_JWT_AUDIENCE,
            algorithms: [PLATFORM_JWT_ALGORITHM],
        });

        if (decoded.type !== "platform_owner" || !decoded.userId) {
            return res.status(401).json({
                success: false,
                message: "Invalid platform token",
            });
        }

        const platformUser = await platformUserService.getActiveById(decoded.userId);

        if (!platformUser) {
            return res.status(401).json({
                success: false,
                message: "Platform account not found or inactive",
            });
        }

        // Phase 14E -- token versioning. A token signed BEFORE a
        // password change or a 2FA enable/disable carries the OLD
        // tokenVersion and is rejected here, even though it hasn't
        // naturally expired yet -- this is what makes "change my
        // password, log out every other session" actually true
        // without a server-side session/blacklist store. A pre-Phase-
        // 14 token has no tokenVersion claim at all (undefined), which
        // never strictly-equals a real numeric version, so old tokens
        // issued before this migration are correctly invalidated too
        // (the account simply needs a fresh login once).
        if (decoded.tokenVersion !== platformUser.token_version) {
            return res.status(401).json({
                success: false,
                message: "Session expired due to a security change. Please log in again.",
            });
        }

        req.platformUser = platformUser;

        next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message: "Invalid or expired platform authentication token",
        });

    }

};

module.exports = { platformProtect };
