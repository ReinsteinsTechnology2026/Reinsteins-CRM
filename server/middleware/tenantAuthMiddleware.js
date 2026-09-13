const jwt = require("jsonwebtoken");

const platformCompanyService = require("../services/platformCompanyService");
const { getTenantPoolForCompany } = require("../config/tenantConnectionManager");
const { TENANT_JWT_ISSUER, TENANT_JWT_AUDIENCE } = require("../controllers/tenantAuthController");
const { __runWithTenantContext: runWithTenantContext } = require("../config/db");

// ==========================================
// TENANT PROTECT (Phase 2F)
//
// Isolated counterpart to server/middleware/authMiddleware.js's
// `protect` (untouched) and server/middleware/platformAuthMiddleware.js's
// `platformProtect` (also untouched). Verifies a tenant-aware JWT and
// resolves fresh, request-time company + tenant-database context --
// it never trusts the token's claims alone for database selection.
//
// Flow:
//   1. verify signature against TENANT_JWT_SECRET + issuer/audience
//      (wrong secret -- a Reinsteins token or a Platform token --
//      fails here outright, before any claim is read)
//   2. verify type === "tenant_user"
//   3. re-fetch the company FRESH from groworgs_platform_db by
//      decoded.companyId (not by trusting decoded.companySlug alone)
//   4. cross-check company.company_slug === decoded.companySlug --
//      if a company were ever renamed after a token was issued, a
//      stale token is refused rather than resolved against the new
//      slug
//   5. verify company.status === 'active'
//   6. resolve the tenant pool via getTenantPoolForCompany(), which
//      independently re-validates tenant_db_name every time
//   7. re-query the tenant user by decoded.userId in that fresh pool,
//      confirming the account still exists and is active -- a
//      deactivated user's old token stops working immediately
//
// Attaches:
//   req.tenantCompany -- { id, company_name, company_slug, status,
//                          access_type, tenant_db_name } (a name, not
//                          a credential -- host/user/password are
//                          never stored on this row at all)
//   req.tenantDb       -- the resolved tenant connection pool
//   req.user           -- { id, employeeId, role, systemAccess }
//
// Nothing in the request body or query string can influence which
// company/database this middleware resolves -- only the token can.
// ==========================================

const tenantProtect = async (req, res, next) => {

    try {

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({ success: false, message: "Authentication required" });
        }

        const token = authHeader.split(" ")[1];

        // Phase 14E -- algorithm explicitly pinned, same reasoning as
        // platformAuthMiddleware.js.
        const decoded = jwt.verify(token, process.env.TENANT_JWT_SECRET, {
            issuer: TENANT_JWT_ISSUER,
            audience: TENANT_JWT_AUDIENCE,
            algorithms: ["HS256"],
        });

        if (decoded.type !== "tenant_user" || !decoded.userId || !decoded.companyId || !decoded.companySlug) {
            return res.status(401).json({ success: false, message: "Invalid tenant token" });
        }

        const company = await platformCompanyService.getCompanyById(decoded.companyId);

        if (
            !company ||
            company.company_slug !== decoded.companySlug ||
            !platformCompanyService.isCompanyAccessAllowed(company)
        ) {
            // Phase 8: extends the existing status check with
            // subscription enforcement (cancelled/expired status, or a
            // trial/subscription past its date) -- same generic 401
            // message as a suspended company already gets today, so an
            // already-issued token stops working the instant a
            // subscription lapses, with no cron job required.
            return res.status(401).json({ success: false, message: "Invalid or expired tenant authentication token" });
        }

        let tenantPool;
        try {
            tenantPool = getTenantPoolForCompany(company);
        } catch (_resolveError) {
            return res.status(401).json({ success: false, message: "Invalid or expired tenant authentication token" });
        }

        const [users] = await tenantPool.query(
            `SELECT id, employee_id, role, status, employment_status, system_access
             FROM users WHERE id = ? LIMIT 1`,
            [decoded.userId]
        );

        const user = users[0];

        if (!user || user.status !== "active" || (user.employment_status && user.employment_status !== "active")) {
            return res.status(401).json({ success: false, message: "Account not found or inactive" });
        }

        req.tenantCompany = company;
        req.tenantDb = tenantPool;
        req.user = {
            id: user.id,
            employeeId: user.employee_id,
            role: user.role,
            systemAccess: user.system_access,
        };

        // Runs the REST of this request's handler chain (every
        // downstream middleware/controller/service, including all
        // existing controllers that just do
        // `const pool = require("../config/db")` and call
        // pool.query()) inside an AsyncLocalStorage context carrying
        // both this request's tenant pool AND its company slug -- see
        // config/db.js for the mechanism. This is what makes the
        // entire existing portal's data access AND Socket.IO room
        // naming (utils/socketRooms.js) tenant-aware for tenant-JWT-
        // authenticated requests, without editing any controller.
        return runWithTenantContext({ tenantPool, companySlug: company.company_slug }, next);

    } catch (error) {

        // Phase 8: this catch previously swallowed every failure
        // silently, so a genuine tenant-DB outage was indistinguishable
        // server-side from an ordinary bad/expired token. Logging here
        // does not change the response -- fails closed exactly as
        // before -- it only makes a real outage visible in the server
        // logs instead of disappearing.
        console.error("tenantProtect error:", error.message);

        return res.status(401).json({ success: false, message: "Invalid or expired tenant authentication token" });

    }

};

module.exports = { tenantProtect };
