const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const platformUserService = require("../services/platformUserService");

// ==========================================
// PLATFORM AUTH CONTROLLER (Phase 2B)
//
// Completely isolated from server/controllers/authController.js
// (the existing tenant login). Authenticates ONLY against
// groworgs_platform_db.platform_users -- never queries the
// tenant `users` table, never touches JWT_SECRET.
//
// JWT isolation: signed with a SEPARATE secret
// (PLATFORM_JWT_SECRET, distinct from the tenant JWT_SECRET)
// plus a distinct issuer/audience/type. A wrong-secret token
// fails jwt.verify() outright -- it is not merely rejected by
// a downstream "if (type !== ...)" check, so a tenant token can
// never be mistaken for a platform token (or vice versa) even
// if some future code forgot to check the `type` claim. See
// platformAuthMiddleware.js for the verifying side.
// ==========================================

const PLATFORM_JWT_ISSUER = "groworgs-platform";
const PLATFORM_JWT_AUDIENCE = "groworgs-platform-owner";

const login = async (req, res) => {

    try {

        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email and password are required",
            });
        }

        const platformUser = await platformUserService.getByEmail(email);

        // Same generic message whether the email doesn't exist or the
        // password is wrong -- never reveal which one failed.

        if (!platformUser) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        if (platformUser.status !== "active") {
            return res.status(403).json({
                success: false,
                message: "This Platform Owner account is not active",
            });
        }

        const passwordMatches = await bcrypt.compare(password, platformUser.password_hash);

        if (!passwordMatches) {
            return res.status(401).json({
                success: false,
                message: "Invalid email or password",
            });
        }

        const token = jwt.sign(
            {
                userId: platformUser.id,
                type: "platform_owner",
            },
            process.env.PLATFORM_JWT_SECRET,
            {
                expiresIn: "8h",
                issuer: PLATFORM_JWT_ISSUER,
                audience: PLATFORM_JWT_AUDIENCE,
            }
        );

        return res.json({
            success: true,
            message: "Login successful",
            token,
            platformUser: {
                id: platformUser.id,
                name: platformUser.name,
                email: platformUser.email,
                role: platformUser.role,
            },
        });

    } catch (error) {

        console.error("Platform Login Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Unable to log in",
        });

    }

};

module.exports = {
    login,
    PLATFORM_JWT_ISSUER,
    PLATFORM_JWT_AUDIENCE,
};
