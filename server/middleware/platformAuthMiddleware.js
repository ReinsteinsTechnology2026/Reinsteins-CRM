const jwt = require("jsonwebtoken");

const platformUserService = require("../services/platformUserService");
const { PLATFORM_JWT_ISSUER, PLATFORM_JWT_AUDIENCE } = require("../controllers/platformAuthController");

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

        const decoded = jwt.verify(token, process.env.PLATFORM_JWT_SECRET, {
            issuer: PLATFORM_JWT_ISSUER,
            audience: PLATFORM_JWT_AUDIENCE,
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
