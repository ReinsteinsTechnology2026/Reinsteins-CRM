const bcrypt = require("bcrypt");

const platformUserService = require("./services/platformUserService");

// ==========================================
// CREATE PLATFORM OWNER (Phase 2B)
//
// Safe, repeatable way to create a real GrowOrgs Platform Owner
// account. Reads credentials from environment variables set in
// your OWN shell for this one command only -- nothing is
// hardcoded in source, nothing is written to .env, and the
// password is never logged or printed at any point.
//
// This script only ever writes to groworgs_platform_db.platform_users.
// It never opens a connection to the tenant database and never
// touches the tenant `users` table.
//
// USAGE (PowerShell):
//
//   $env:PLATFORM_OWNER_NAME  = "Your Name"
//   $env:PLATFORM_OWNER_EMAIL = "you@yourcompany.com"
//   $env:PLATFORM_OWNER_PASSWORD = "a-strong-password-you-choose"
//   node _create_platform_owner.js
//
// Then clear them from your shell history/session if you're on a
// shared machine:
//
//   Remove-Item Env:\PLATFORM_OWNER_PASSWORD
//
// Safe to re-run -- if the email already exists, it stops with a
// clear message and creates nothing (the platform_users.email
// UNIQUE constraint is the backstop either way).
// ==========================================

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

(async () => {

    const name = process.env.PLATFORM_OWNER_NAME;
    const email = process.env.PLATFORM_OWNER_EMAIL;
    const password = process.env.PLATFORM_OWNER_PASSWORD;

    if (!name || !email || !password) {
        console.error(
            "Missing required environment variables. Set PLATFORM_OWNER_NAME, " +
            "PLATFORM_OWNER_EMAIL, and PLATFORM_OWNER_PASSWORD in your shell " +
            "before running this script (see the usage comment at the top of this file)."
        );
        process.exit(1);
    }

    if (!EMAIL_PATTERN.test(email)) {
        console.error("PLATFORM_OWNER_EMAIL does not look like a valid email address.");
        process.exit(1);
    }

    if (password.length < 10) {
        console.error("PLATFORM_OWNER_PASSWORD must be at least 10 characters.");
        process.exit(1);
    }

    try {

        const passwordHash = await bcrypt.hash(password, 12);

        const created = await platformUserService.create({
            name,
            email,
            passwordHash,
            role: "platform_owner",
        });

        console.log("\nPlatform Owner created successfully.");
        console.log(`  id:    ${created.id}`);
        console.log(`  name:  ${created.name}`);
        console.log(`  email: ${created.email}`);
        console.log(`  role:  ${created.role}`);
        console.log("\n(Password not shown -- it was hashed and never logged.)");

        process.exit(0);

    } catch (error) {

        if (error.code === "PLATFORM_USER_EMAIL_TAKEN") {
            console.error(`\nA platform user with email "${email}" already exists. Nothing was created.`);
            process.exit(1);
        }

        console.error("Failed to create Platform Owner:", error.message);
        process.exit(1);

    }

})();
