// ==========================================
// ENVIRONMENT (Phase 15 -- deployment-path independence)
//
// Must be the very first thing this file does, with an EXPLICIT path
// -- dotenv's no-argument default resolves ".env" relative to
// process.cwd(), which is only ever "server/" when something `cd`s
// into this directory before running `node app.js`. Any process
// manager/host that instead runs `node server/app.js` (or `npm start`
// from the repo root -- see package.json) has a cwd of the REPO ROOT,
// where no .env file exists, so every module below would silently see
// undefined DB/JWT/SMTP/Razorpay config instead of a clear startup
// error. Anchoring the path to this file's own directory (__dirname)
// makes env loading work identically regardless of the invoking cwd.
// ==========================================

require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const path = require("path");
const fs = require("fs");
const http = require("http");
const jwt = require("jsonwebtoken");
const fileRoutes = require("./routes/fileRoutes");
const {
  Server,
} = require("socket.io");

const pool = require("./config/db");
const {
  __runWithTenantContext: runWithTenantContext,
} = require("./config/db");
const platformCompanyService = require("./services/platformCompanyService");
const { getTenantPoolForCompany } = require("./config/tenantConnectionManager");
const { globalApiLimiter } = require("./middleware/rateLimiters");
const { JSON_BODY_LIMIT } = require("./config/securityConfig");
const {
  TENANT_JWT_ISSUER,
  TENANT_JWT_AUDIENCE,
} = require("./controllers/tenantAuthController");
const {
  userRoom,
  meetingRoom,
  conversationRoom,
  presenceRoom,
  LEGACY_COMPANY_SLUG,
} = require("./utils/socketRooms");
const { UPLOADS_ROOT } = require("./utils/tenantUploadPath");
const { verifyFileAccessToken } = require("./utils/fileAccessToken");
const { signFileUrlsMiddleware } = require("./middleware/signFileUrlsMiddleware");

// ==========================================
// ROUTES
// ==========================================

const authRoutes = require(
  "./routes/authRoutes"
);

const dashboardRoutes = require(
  "./routes/dashboardRoutes"
);

const employeeRoutes = require(
  "./routes/employeeRoutes"
);

const departmentRoutes = require(
  "./routes/departmentRoutes"
);

const designationRoutes = require(
  "./routes/designationRoutes"
);

const organizationRoutes = require(
  "./routes/organizationRoutes"
);

const attendanceRoutes = require(
  "./routes/attendanceRoutes"
);

const shiftScheduleRoutes = require(
  "./routes/shiftScheduleRoutes"
);

const taskRoutes = require(
  "./routes/taskRoutes"
);
const taskManagementRoutes = require(
  "./routes/taskManagementRoutes"
);
const taskWorkRoutes = require(
  "./routes/taskWorkRoutes"
);

const projectRoutes = require(
  "./routes/projectRoutes"
);
const organizationsRoutes = require(
  "./routes/organizationsRoutes"
);
const epicRoutes = require(
  "./routes/epicRoutes"
);
const featureRoutes = require(
  "./routes/featureRoutes"
);
const userStoryRoutes = require(
  "./routes/userStoryRoutes"
);
const sprintRoutes = require(
  "./routes/sprintRoutes"
);
const taskActivityRoutes = require(
  "./routes/taskActivityRoutes"
);
const tagRoutes = require(
  "./routes/tagRoutes"
);
const workItemLinkRoutes = require(
  "./routes/workItemLinkRoutes"
);

const leaveRoutes = require(
  "./routes/leaveRoutes"
);

const reportRoutes = require(
  "./routes/reportRoutes"
);

const notificationRoutes = require(
  "./routes/notificationRoutes"
);

const chatRoutes = require(
  "./routes/chatRoutes"
);

const meetingRoutes = require(
  "./routes/meetingRoutes"
);

// GrowOrgs platform routes (Phase 2B) -- entirely separate from
// every tenant route above; see routes/platformAuthRoutes.js.
const platformAuthRoutes = require(
  "./routes/platformAuthRoutes"
);
// GrowOrgs platform company routes (Phase 2D) -- see
// routes/platformCompanyRoutes.js.
const platformCompanyRoutes = require(
  "./routes/platformCompanyRoutes"
);
// GrowOrgs company-aware tenant login (Phase 2F) -- entirely
// separate from the existing /api/auth (Reinsteins) and
// /api/platform/auth (Platform Owner) routes; see
// routes/tenantAuthRoutes.js.
const tenantAuthRoutes = require(
  "./routes/tenantAuthRoutes"
);
// GrowOrgs public marketing site backend surface (Phase 6) -- no
// authentication on any route here by design; see
// routes/publicRoutes.js and controllers/publicController.js.
const publicRoutes = require(
  "./routes/publicRoutes"
);
// GrowOrgs Platform Owner demo request management (Phase 7) --
// platformProtect-only, reads/writes groworgs_platform_db.demo_requests
// exclusively; see routes/platformDemoRequestRoutes.js.
const platformDemoRequestRoutes = require(
  "./routes/platformDemoRequestRoutes"
);
// GrowOrgs Platform Owner subscription/plan management (Phase 8) --
// platformProtect-only, reads/writes groworgs_platform_db
// (subscription_plans, and the new subscription columns on
// companies) exclusively; see routes/platformPlanRoutes.js.
const platformPlanRoutes = require(
  "./routes/platformPlanRoutes"
);
// GrowOrgs Platform Owner payment management (Phase 10) --
// platformProtect on every route except the Razorpay webhook (signature-
// verified instead); see routes/platformPaymentRoutes.js.
const platformPaymentRoutes = require(
  "./routes/platformPaymentRoutes"
);
// GrowOrgs Platform Owner audit log / notification feed (Phase 12) --
// platformProtect-only, reads/writes groworgs_platform_db exclusively.
const platformAuditRoutes = require(
  "./routes/platformAuditRoutes"
);
const platformNotificationRoutes = require(
  "./routes/platformNotificationRoutes"
);
const platformEmailRoutes = require(
  "./routes/platformEmailRoutes"
);
// ZioVenture multi-tenant business email (Phase 16A) -- tenantProtect
// on every route, entirely separate from platformEmailRoutes above
// (that one is the Platform Owner's SMTP status/retry surface for
// ZioVenture's OWN system email; this one is customer-owned business
// domains/mailboxes). See routes/tenantEmailRoutes.js.
const tenantEmailRoutes = require(
  "./routes/tenantEmailRoutes"
);

const meetingService = require(
  "./services/meetingService"
);

// ==========================================
// APP + HTTP SERVER
// ==========================================

const app = express();

// ==========================================
// TRUST PROXY (production security fix, merged from origin/main's
// PostgreSQL/CI deployment work -- see that commit for the real
// production topology this describes)
//
// Node listens only on 127.0.0.1:5000, behind Nginx (127.0.0.1:80)
// behind Cloudflare Tunnel. "2" trusts exactly the two hops in front
// of this process (Nginx, then the Cloudflare Tunnel daemon) so
// req.ip / req.secure / the rate limiter resolve the real client
// address from X-Forwarded-For instead of 127.0.0.1.
//
// (An earlier, locally-developed version of this fix made this
// configurable via a TRUST_PROXY env var, defaulting to disabled.
// Superseded by this hardcoded value to exactly match what's already
// deployed and proven working in production, rather than risk a
// silent regression if a production .env doesn't happen to set that
// var.)
// ==========================================

app.set("trust proxy", 2);

const server = http.createServer(
  app
);

const PORT =
  process.env.PORT || 5000;

// ==========================================
// ALLOWED CORS ORIGINS (Phase 8 -- production readiness)
//
// Both the Socket.IO server below and the Express `cors()`
// middleware further down previously hardcoded this exact same
// two-entry localhost array, which only ever worked against the
// local Vite dev server and would silently reject every request
// from any deployed frontend origin. CORS_ORIGINS (comma-separated)
// lets a production deployment declare its real frontend origin(s);
// the same two localhost ports remain the default when it's unset,
// so `npm run dev` behavior is completely unchanged.
// ==========================================

const ALLOWED_ORIGINS = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim())
  : ["http://localhost:5173", "http://localhost:5174"];

// Phase 15A -- fails CLOSED (every real cross-origin request gets
// rejected, nothing gets silently over-permissive) if CORS_ORIGINS is
// forgotten in production, but that failure mode is easy to mistake
// for "the API is down" during a first deploy. A loud startup warning
// makes the actual cause obvious immediately instead of requiring a
// support investigation.
if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGINS) {
  console.warn(
    "[WARNING] NODE_ENV=production but CORS_ORIGINS is not set -- falling back to localhost dev origins, which will reject every request from your real deployed frontend. Set CORS_ORIGINS to your production frontend URL(s)."
  );
}

// ==========================================
// SOCKET.IO SERVER
// ==========================================

const io = new Server(
  server,
  {
    cors: {
      origin: ALLOWED_ORIGINS,
      methods: [
        "GET",
        "POST",
      ],

      credentials: true,
    },
  }
);

// ==========================================
// TRACK ONLINE USERS
//
// Map:
//
// userId => Set(socketId)
//
// Supports multiple browser tabs/devices.
// ==========================================

const onlineUsers =
  new Map();

// ==========================================
// SOCKET AUTHENTICATION
// ==========================================

// ==========================================
// SOCKET.IO MULTI-TENANT AUTHENTICATION
//
// Mirrors authMiddleware.js's `protect` fallback exactly: try the
// LEGACY verification first (byte-identical to this middleware's
// behavior before this phase -- same JWT_SECRET, same query, same
// socket.user shape), and only on failure attempt the NEW tenant
// verification. A legacy Reinsteins socket connection never reaches
// the new code path at all, so existing chat/meeting/WebRTC behavior
// for Reinsteins is completely unaffected.
//
// On success (either path), attaches socket.tenantContext =
// { pool, companySlug } -- the single source of truth every
// subsequent event handler re-enters via onTenantEvent() below to
// resolve the correct tenant database AND build correctly-namespaced
// room names (utils/socketRooms.js). This is NOT trusted from the
// client at any point: companySlug here always comes from the
// verified JWT + a fresh platform-DB lookup, never from
// socket.handshake.auth or any event payload.
//
// A garbage/forged token, or a Platform Owner token (wrong secret
// for both attempts), fails both branches and the connection is
// refused -- identical in spirit to the previous fail-closed
// behavior, just now correctly ADMITTING real tenant users instead
// of blanket-rejecting them.
// ==========================================

async function authenticateLegacySocket(token) {

  const decoded = jwt.verify(token, process.env.JWT_SECRET);

  const [users] = await pool.query(
    `SELECT id, employee_id, full_name, role, status FROM users WHERE id = ? LIMIT 1`,
    [decoded.id]
  );

  const user = users[0];

  if (!user) throw new Error("User not found");
  if (user.status !== "active") throw new Error("User account is not active");

  return {
    socketUser: {
      id: user.id,
      employeeId: user.employee_id,
      fullName: user.full_name,
      role: user.role,
    },
    tenantContext: { tenantPool: pool.__legacyPool, companySlug: LEGACY_COMPANY_SLUG },
  };

}

async function authenticateTenantSocket(token) {

  const decoded = jwt.verify(token, process.env.TENANT_JWT_SECRET, {
    issuer: TENANT_JWT_ISSUER,
    audience: TENANT_JWT_AUDIENCE,
  });

  if (decoded.type !== "tenant_user" || !decoded.userId || !decoded.companyId || !decoded.companySlug) {
    throw new Error("Invalid tenant token");
  }

  // Re-fetch the company FRESH from the platform DB -- never trust
  // decoded.companySlug alone, exactly like tenantProtect.
  const company = await platformCompanyService.getCompanyById(decoded.companyId);

  // Phase 8: extends the existing status check with subscription
  // enforcement, exactly mirroring tenantAuthMiddleware.js -- a
  // cancelled/expired subscription disconnects Socket.IO access the
  // same way a suspended company already does today.
  if (
    !company ||
    company.company_slug !== decoded.companySlug ||
    !platformCompanyService.isCompanyAccessAllowed(company)
  ) {
    throw new Error("Invalid or expired tenant authentication token");
  }

  // Also rejects a company with no/invalid tenant_db_name -- covers
  // "suspended tenant cannot use Socket.IO" together with the
  // status check above.
  const tenantPool = getTenantPoolForCompany(company);

  const [users] = await tenantPool.query(
    `SELECT id, employee_id, full_name, role, status, employment_status, system_access
     FROM users WHERE id = ? LIMIT 1`,
    [decoded.userId]
  );

  const user = users[0];

  if (!user || user.status !== "active" || (user.employment_status && user.employment_status !== "active")) {
    throw new Error("Account not found or inactive");
  }

  return {
    socketUser: {
      id: user.id,
      employeeId: user.employee_id,
      fullName: user.full_name,
      role: user.role,
    },
    tenantContext: { tenantPool, companySlug: company.company_slug },
  };

}

io.use(
  async (
    socket,
    next
  ) => {
    try {
      const token = socket.handshake.auth?.token;

      if (!token) {
        return next(new Error("Authentication token required"));
      }

      let authResult;

      try {
        authResult = await authenticateLegacySocket(token);
      } catch (_legacyError) {
        // Not a valid legacy token -- attempt the tenant-aware path.
        // Any failure from here (wrong secret entirely, e.g. a
        // Platform Owner token; inactive/suspended company; inactive
        // user) produces the same generic rejection below.
        authResult = await authenticateTenantSocket(token);
      }

      socket.user = authResult.socketUser;
      socket.tenantContext = authResult.tenantContext;

      next();

    } catch (error) {
      console.error(
        "Socket authentication error:",
        error.message
      );

      next(
        new Error(
          "Invalid or expired authentication token"
        )
      );
    }
  }
);

// ==========================================
// SOCKET CONNECTION
// ==========================================

io.on(
  "connection",
  (socket) => {
    const userId =
      String(
        socket.user.id
      );

    // The company this specific socket authenticated as -- resolved
    // once, at connection time, from the verified JWT (see io.use()
    // above). Never re-derived from anything the client sends later.
    const companySlug = socket.tenantContext.companySlug;

    // Composite key: onlineUsers MUST be keyed by tenant + userId,
    // not bare userId. Every tenant database's users.id independently
    // restarts at 1, so without the companySlug prefix, Tenant A's
    // user #3 and Tenant B's user #3 would collide into the same Map
    // entry -- merging two unrelated people's presence tracking.
    const presenceKey = `${companySlug}:${userId}`;

    console.log(
      `Socket connected: ${socket.user.fullName} (${userId}) [tenant: ${companySlug}]`
    );

    // ========================================
    // TENANT-AWARE EVENT WRAPPER
    //
    // AsyncLocalStorage context set by io.use() does NOT persist into
    // a socket.on(...) handler -- each is a separate invocation fired
    // later by the Socket.IO event loop, not nested inside the
    // middleware's own call stack. Every handler below is registered
    // through this wrapper instead of socket.on() directly, so that
    // any pool.query()/getConnection() call made anywhere during its
    // execution (including inside awaited service functions like
    // meetingService.*/notificationService.*) resolves to THIS
    // socket's own tenant database, and any room name built via
    // getCurrentCompanySlug() resolves to this socket's own tenant.
    // ========================================

    function onTenantEvent(eventName, handler) {
      socket.on(eventName, (...args) => {
        return runWithTenantContext(
          socket.tenantContext,
          () => handler(...args)
        );
      });
    }

    // ========================================
    // JOIN PERSONAL USER ROOM (tenant-namespaced)
    //
    // Used for:
    // - Direct notifications
    // - Chat notifications
    // - Calls
    // - WebRTC signaling
    // ========================================

    socket.join(
      userRoom(companySlug, userId)
    );

    // Tenant-wide presence room -- used ONLY for the online/offline
    // broadcast below, never for anything carrying private data.
    socket.join(
      presenceRoom(companySlug)
    );

    // ========================================
    // TRACK USER CONNECTION
    // ========================================

    if (
      !onlineUsers.has(
        presenceKey
      )
    ) {
      onlineUsers.set(
        presenceKey,
        new Set()
      );
    }

    onlineUsers
      .get(presenceKey)
      .add(
        socket.id
      );

    // ========================================
    // ANNOUNCE USER ONLINE -- tenant-scoped, not a global io.emit().
    // A Company B socket must never learn that a Company A user just
    // connected, and vice versa.
    // ========================================

    io.to(presenceRoom(companySlug)).emit(
      "user:online",
      {
        userId:
          Number(userId),
      }
    );

    // ========================================
    // SEND CURRENT ONLINE USERS -- filtered to this socket's own
    // tenant only (composite keys are "<companySlug>:<userId>").
    // ========================================

    const onlineUserIdsInThisTenant = Array.from(
      onlineUsers.keys()
    )
      .filter((key) => key.startsWith(`${companySlug}:`))
      .map((key) => Number(key.slice(companySlug.length + 1)));

    socket.emit(
      "users:online",
      onlineUserIdsInThisTenant
    );

    // ========================================
    // JOIN CONVERSATION ROOM
    // ========================================

    onTenantEvent(
      "conversation:join",
      async (
        conversationId
      ) => {
        try {
          const id =
            Number(
              conversationId
            );

          if (
            !Number.isInteger(
              id
            ) ||
            id <= 0
          ) {
            return;
          }

          // Security:
          // User must belong to conversation.

          const [members] =
            await pool.query(
              `
              SELECT id
              FROM conversation_members
              WHERE conversation_id = ?
              AND user_id = ?
              LIMIT 1
              `,
              [
                id,
                socket.user.id,
              ]
            );

          if (
            members.length === 0
          ) {
            console.warn(
              `Unauthorized conversation join attempt by user ${userId}`
            );

            return;
          }

          socket.join(
            conversationRoom(companySlug, id)
          );

        } catch (error) {
          console.error(
            "Conversation join error:",
            error
          );
        }
      }
    );

    // ========================================
    // LEAVE CONVERSATION ROOM
    // ========================================

    onTenantEvent(
      "conversation:leave",
      (
        conversationId
      ) => {
        const id =
          Number(
            conversationId
          );

        if (
          !Number.isInteger(
            id
          ) ||
          id <= 0
        ) {
          return;
        }

        socket.leave(
          conversationRoom(companySlug, id)
        );
      }
    );

    // ========================================
    // CALL HELPER
    //
    // Verify target user exists and is active.
    // ========================================

    const verifyCallTarget =
      async (
        targetUserId
      ) => {
        const targetId =
          Number(
            targetUserId
          );

        if (
          !Number.isInteger(
            targetId
          ) ||
          targetId <= 0
        ) {
          return null;
        }

        // Prevent calling yourself.

        if (
          targetId ===
          Number(
            socket.user.id
          )
        ) {
          return null;
        }

        const [users] =
          await pool.query(
            `
            SELECT
              id,
              employee_id,
              full_name,
              role,
              status
            FROM users
            WHERE id = ?
            AND status = 'active'
            LIMIT 1
            `,
            [
              targetId,
            ]
          );

        if (
          users.length === 0
        ) {
          return null;
        }

        return users[0];
      };

    // ========================================
    // START CALL
    //
    // callType:
    // "audio" or "video"
    // ========================================

    onTenantEvent(
      "call:start",
      async (
        data = {}
      ) => {
        try {
          const {
            targetUserId,
            callType,
          } = data;

          const targetUser =
            await verifyCallTarget(
              targetUserId
            );

          if (
            !targetUser
          ) {
            socket.emit(
              "call:error",
              {
                message:
                  "Unable to call this user",
              }
            );

            return;
          }

          if (
            callType !==
              "audio" &&
            callType !==
              "video"
          ) {
            socket.emit(
              "call:error",
              {
                message:
                  "Invalid call type",
              }
            );

            return;
          }

          const targetId =
            String(
              targetUser.id
            );

          // ====================================
          // CHECK IF USER IS ONLINE
          //
          // Phase 8 fix: onlineUsers is keyed by the composite
          // "<companySlug>:<userId>" presence key (see the
          // "TRACK USER CONNECTION" block above), not a bare user
          // ID -- this lookup previously used the bare targetId,
          // which never matched any stored key, so 1:1 calling
          // always reported the target as offline regardless of
          // their actual connection state.
          // ====================================

          if (
            !onlineUsers.has(
              `${companySlug}:${targetId}`
            )
          ) {
            socket.emit(
              "call:unavailable",
              {
                targetUserId:
                  targetUser.id,

                message:
                  "User is currently offline",
              }
            );

            return;
          }

          // ====================================
          // SEND INCOMING CALL
          // ====================================

          io
            .to(
              userRoom(companySlug, targetId)
            )
            .emit(
              "call:incoming",
              {
                callerId:
                  Number(
                    socket.user.id
                  ),

                callerEmployeeId:
                  socket.user
                    .employeeId,

                callerName:
                  socket.user
                    .fullName,

                callerRole:
                  socket.user
                    .role,

                callType,
              }
            );

          // ====================================
          // CONFIRM TO CALLER
          // ====================================

          socket.emit(
            "call:ringing",
            {
              targetUserId:
                targetUser.id,

              targetEmployeeId:
                targetUser
                  .employee_id,

              targetName:
                targetUser
                  .full_name,

              callType,
            }
          );

        } catch (error) {
          console.error(
            "Start call error:",
            error
          );

          socket.emit(
            "call:error",
            {
              message:
                "Unable to start call",
            }
          );
        }
      }
    );

    // ========================================
    // ACCEPT CALL
    // ========================================

    onTenantEvent(
      "call:accept",
      async (
        data = {}
      ) => {
        try {
          const {
            callerId,
            callType,
          } = data;

          const caller =
            await verifyCallTarget(
              callerId
            );

          if (
            !caller
          ) {
            return;
          }

          io
            .to(
              userRoom(companySlug, caller.id)
            )
            .emit(
              "call:accepted",
              {
                userId:
                  Number(
                    socket.user.id
                  ),

                employeeId:
                  socket.user
                    .employeeId,

                fullName:
                  socket.user
                    .fullName,

                callType:
                  callType ===
                  "video"
                    ? "video"
                    : "audio",
              }
            );

        } catch (error) {
          console.error(
            "Accept call error:",
            error
          );
        }
      }
    );

    // ========================================
    // REJECT CALL
    // ========================================

    onTenantEvent(
      "call:reject",
      async (
        data = {}
      ) => {
        try {
          const {
            callerId,
          } = data;

          const caller =
            await verifyCallTarget(
              callerId
            );

          if (
            !caller
          ) {
            return;
          }

          io
            .to(
              userRoom(companySlug, caller.id)
            )
            .emit(
              "call:rejected",
              {
                userId:
                  Number(
                    socket.user.id
                  ),

                fullName:
                  socket.user
                    .fullName,
              }
            );

        } catch (error) {
          console.error(
            "Reject call error:",
            error
          );
        }
      }
    );

    // ========================================
    // END CALL
    // ========================================

    onTenantEvent(
      "call:end",
      async (
        data = {}
      ) => {
        try {
          const {
            targetUserId,
          } = data;

          const targetUser =
            await verifyCallTarget(
              targetUserId
            );

          if (
            !targetUser
          ) {
            return;
          }

          io
            .to(
              userRoom(companySlug, targetUser.id)
            )
            .emit(
              "call:ended",
              {
                userId:
                  Number(
                    socket.user.id
                  ),

                fullName:
                  socket.user
                    .fullName,
              }
            );

        } catch (error) {
          console.error(
            "End call error:",
            error
          );
        }
      }
    );

    // ========================================
    // WEBRTC OFFER
    // ========================================

    onTenantEvent(
      "webrtc:offer",
      async (
        data = {}
      ) => {
        try {
          const {
            targetUserId,
            offer,
          } = data;

          const targetUser =
            await verifyCallTarget(
              targetUserId
            );

          if (
            !targetUser ||
            !offer
          ) {
            return;
          }

          io
            .to(
              userRoom(companySlug, targetUser.id)
            )
            .emit(
              "webrtc:offer",
              {
                fromUserId:
                  Number(
                    socket.user.id
                  ),

                offer,
              }
            );

        } catch (error) {
          console.error(
            "WebRTC offer error:",
            error
          );
        }
      }
    );

    // ========================================
    // WEBRTC ANSWER
    // ========================================

    onTenantEvent(
      "webrtc:answer",
      async (
        data = {}
      ) => {
        try {
          const {
            targetUserId,
            answer,
          } = data;

          const targetUser =
            await verifyCallTarget(
              targetUserId
            );

          if (
            !targetUser ||
            !answer
          ) {
            return;
          }

          io
            .to(
              userRoom(companySlug, targetUser.id)
            )
            .emit(
              "webrtc:answer",
              {
                fromUserId:
                  Number(
                    socket.user.id
                  ),

                answer,
              }
            );

        } catch (error) {
          console.error(
            "WebRTC answer error:",
            error
          );
        }
      }
    );



    // ========================================
    // WEBRTC ICE CANDIDATE
    // ========================================

    onTenantEvent(
      "webrtc:ice-candidate",
      async (
        data = {}
      ) => {
        try {
          const {
            targetUserId,
            candidate,
          } = data;

          const targetUser =
            await verifyCallTarget(
              targetUserId
            );

          if (
            !targetUser ||
            !candidate
          ) {
            return;
          }

          io
            .to(
              userRoom(companySlug, targetUser.id)
            )
            .emit(
              "webrtc:ice-candidate",
              {
                fromUserId:
                  Number(
                    socket.user.id
                  ),

                candidate,
              }
            );

        } catch (error) {
          console.error(
            "WebRTC ICE candidate error:",
            error
          );
        }
      }
    );

    // ========================================================
    // MEETINGS — REAL-TIME LAYER
    //
    // The REST API (routes/meetingRoutes.js) is the source of
    // truth for persisted state (who is invited/admitted,
    // meeting status, chat history). These socket events are
    // the live layer on top: WebRTC signaling relay (mirrors
    // the webrtc:offer/answer/ice-candidate pattern above, but
    // scoped per meeting room instead of 1:1) and transient
    // presence (mic/camera/hand-raise) that is intentionally
    // never written to MySQL.
    //
    // Every handler re-verifies meeting access from the
    // database itself — a client claiming to be in a meeting
    // is never trusted.
    // ========================================================

    const isMeetingParticipant = async (meetingId, checkUserId) => {

      const meeting = await meetingService.getMeetingById(meetingId);

      if (!meeting) return false;

      if (Number(meeting.host_id) === Number(checkUserId)) return true;

      const participant = await meetingService.verifyMeetingAccess(
        meetingId,
        checkUserId
      );

      return Boolean(
        participant &&
        ["admitted", "joined"].includes(participant.status)
      );

    };

    const isMeetingModerator = async (meetingId, checkUserId) => {

      const meeting = await meetingService.getMeetingById(meetingId);

      if (!meeting) return false;

      if (Number(meeting.host_id) === Number(checkUserId)) return true;

      const participant = await meetingService.verifyMeetingAccess(
        meetingId,
        checkUserId
      );

      return Boolean(participant && participant.role === "co_host");

    };

    const getMeetingRoomParticipants = (meetingId) => {

      const roomName = meetingRoom(companySlug, meetingId);

      const socketIds = io.sockets.adapter.rooms.get(roomName);

      if (!socketIds) return [];

      const participants = [];

      socketIds.forEach((socketId) => {

        const memberSocket = io.sockets.sockets.get(socketId);

        if (memberSocket?.user) {
          participants.push({
            userId: Number(memberSocket.user.id),
            fullName: memberSocket.user.fullName,
            role: memberSocket.user.role,
          });
        }

      });

      return participants;

    };

    // ========================================
    // JOIN MEETING ROOM
    // ========================================

    onTenantEvent(
      "meeting:join",
      async (data = {}) => {
        try {

          const { meetingId } = data;

          const allowed = await isMeetingParticipant(
            meetingId,
            socket.user.id
          );

          if (!allowed) {
            socket.emit("meeting:error", {
              message: "You are not admitted to this meeting",
            });
            return;
          }

          const roomName = meetingRoom(companySlug, meetingId);

          const existingParticipants =
            getMeetingRoomParticipants(meetingId);

          socket.join(roomName);

          // Tell the joining socket who is already here,
          // so it can initiate a WebRTC offer to each of them.

          socket.emit("meeting:room-participants", {
            meetingId,
            participants: existingParticipants,
          });

          // Tell everyone already in the room that a new
          // participant has arrived.

          socket.to(roomName).emit("meeting:participant-joined", {
            meetingId,
            userId: Number(socket.user.id),
            fullName: socket.user.fullName,
            role: socket.user.role,
          });

        } catch (error) {
          console.error("Meeting join error:", error);
          socket.emit("meeting:error", {
            message: "Unable to join meeting room",
          });
        }
      }
    );

    // ========================================
    // LEAVE MEETING ROOM
    // (real-time presence only — persisted
    // leave state is written via the REST
    // POST /api/meetings/:id/leave endpoint)
    // ========================================

    onTenantEvent(
      "meeting:leave",
      (data = {}) => {

        const { meetingId } = data;

        if (!meetingId) return;

        const roomName = meetingRoom(companySlug, meetingId);

        socket.to(roomName).emit("meeting:participant-left", {
          meetingId,
          userId: Number(socket.user.id),
        });

        socket.leave(roomName);

      }
    );

    // ========================================
    // MEETING WEBRTC OFFER / ANSWER / ICE
    // Same relay pattern as webrtc:* above,
    // scoped to a specific meeting + target
    // participant (mesh topology).
    // ========================================

    onTenantEvent(
      "meeting:offer",
      async (data = {}) => {
        try {

          const { meetingId, targetUserId, offer } = data;

          if (!offer) return;

          if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

          io.to(userRoom(companySlug, targetUserId)).emit("meeting:offer", {
            meetingId,
            fromUserId: Number(socket.user.id),
            offer,
          });

        } catch (error) {
          console.error("Meeting offer error:", error);
        }
      }
    );

    onTenantEvent(
      "meeting:answer",
      async (data = {}) => {
        try {

          const { meetingId, targetUserId, answer } = data;

          if (!answer) return;

          if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

          io.to(userRoom(companySlug, targetUserId)).emit("meeting:answer", {
            meetingId,
            fromUserId: Number(socket.user.id),
            answer,
          });

        } catch (error) {
          console.error("Meeting answer error:", error);
        }
      }
    );

    onTenantEvent(
      "meeting:ice-candidate",
      async (data = {}) => {
        try {

          const { meetingId, targetUserId, candidate } = data;

          if (!candidate) return;

          if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

          io.to(userRoom(companySlug, targetUserId)).emit("meeting:ice-candidate", {
            meetingId,
            fromUserId: Number(socket.user.id),
            candidate,
          });

        } catch (error) {
          console.error("Meeting ICE candidate error:", error);
        }
      }
    );

    // ========================================
    // TRANSIENT PRESENCE
    // (mic/camera/hand-raise/screen-share —
    // deliberately never written to MySQL)
    // ========================================

    onTenantEvent(
      "meeting:media-state",
      (data = {}) => {

        const { meetingId, isMuted, isCameraOff } = data;

        if (!meetingId || !socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        socket.to(meetingRoom(companySlug, meetingId)).emit("meeting:media-state-changed", {
          userId: Number(socket.user.id),
          isMuted: Boolean(isMuted),
          isCameraOff: Boolean(isCameraOff),
        });

      }
    );

    onTenantEvent(
      "meeting:hand-raise",
      (data = {}) => {

        const { meetingId, raised } = data;

        if (!meetingId || !socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        socket.to(meetingRoom(companySlug, meetingId)).emit("meeting:hand-raised", {
          userId: Number(socket.user.id),
          fullName: socket.user.fullName,
          raised: Boolean(raised),
        });

      }
    );

    onTenantEvent(
      "meeting:screen-share-state",
      (data = {}) => {

        const { meetingId, sharing } = data;

        if (!meetingId || !socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        socket.to(meetingRoom(companySlug, meetingId)).emit("meeting:screen-share-changed", {
          userId: Number(socket.user.id),
          fullName: socket.user.fullName,
          sharing: Boolean(sharing),
        });

      }
    );

    // ========================================
    // HOST/CO-HOST FORCED MUTE / CAMERA OFF
    // Server validates moderator authority,
    // then signals the TARGET participant's
    // own browser to disable their own track —
    // a host cannot reach into someone else's
    // hardware directly, only ask their client to.
    // ========================================

    onTenantEvent(
      "meeting:force-mute",
      async (data = {}) => {
        try {

          const { meetingId, targetUserId } = data;

          const allowed = await isMeetingModerator(meetingId, socket.user.id);

          if (!allowed) return;

          io.to(userRoom(companySlug, targetUserId)).emit("meeting:force-mute", {
            meetingId,
          });

        } catch (error) {
          console.error("Meeting force-mute error:", error);
        }
      }
    );

    onTenantEvent(
      "meeting:force-camera-off",
      async (data = {}) => {
        try {

          const { meetingId, targetUserId } = data;

          const allowed = await isMeetingModerator(meetingId, socket.user.id);

          if (!allowed) return;

          io.to(userRoom(companySlug, targetUserId)).emit("meeting:force-camera-off", {
            meetingId,
          });

        } catch (error) {
          console.error("Meeting force-camera-off error:", error);
        }
      }
    );

    // ========================================
    // LIVE REACTIONS (Phase 9)
    // Transient only, never written to MySQL —
    // the sender renders their own reaction
    // locally; this only needs to reach
    // everyone else in the room.
    // ========================================

    onTenantEvent(
      "meeting:reaction",
      (data = {}) => {

        const { meetingId, reaction } = data;

        if (!meetingId || !reaction) return;
        if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        socket.to(meetingRoom(companySlug, meetingId)).emit("meeting:reaction-broadcast", {
          userId: Number(socket.user.id),
          fullName: socket.user.fullName,
          reaction,
        });

      }
    );

    // ========================================
    // PRESENTATION CONTROL REQUEST (Phase 9)
    // A collaboration-protocol handshake only
    // (request / allow / deny / revoke). It
    // grants neither side any ability to inject
    // remote mouse/keyboard input — real remote
    // control would require a native/OS-level
    // bridge this project does not have, and is
    // intentionally out of scope.
    // ========================================

    onTenantEvent(
      "meeting:control-request",
      (data = {}) => {

        const { meetingId, targetUserId } = data;

        if (!meetingId || !targetUserId) return;
        if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        io.to(userRoom(companySlug, targetUserId)).emit("meeting:control-requested", {
          meetingId,
          fromUserId: Number(socket.user.id),
          fromName: socket.user.fullName,
        });

      }
    );

    onTenantEvent(
      "meeting:control-response",
      (data = {}) => {

        const { meetingId, targetUserId, approved } = data;

        if (!meetingId || !targetUserId) return;
        if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        io.to(userRoom(companySlug, targetUserId)).emit("meeting:control-response", {
          meetingId,
          fromUserId: Number(socket.user.id),
          approved: Boolean(approved),
        });

      }
    );

    onTenantEvent(
      "meeting:control-revoke",
      (data = {}) => {

        const { meetingId, targetUserId } = data;

        if (!meetingId || !targetUserId) return;
        if (!socket.rooms.has(meetingRoom(companySlug, meetingId))) return;

        io.to(userRoom(companySlug, targetUserId)).emit("meeting:control-revoked", {
          meetingId,
          fromUserId: Number(socket.user.id),
        });

      }
    );

    // ========================================
    // DISCONNECT
    // ========================================

    onTenantEvent(
      "disconnect",
      () => {
        console.log(
          `Socket disconnected: ${socket.user.fullName} (${userId})`
        );

        // ====================================
        // NOTIFY ANY MEETING ROOMS THIS SOCKET
        // WAS PART OF (tab closed, connection
        // lost, etc. — not an explicit
        // meeting:leave). Socket.IO removes
        // room membership automatically; this
        // just tells the other participants.
        // ====================================

        const meetingRoomPrefix = `tenant:${companySlug}:meeting:`;

        socket.rooms.forEach((roomName) => {

          if (roomName.startsWith(meetingRoomPrefix)) {

            const meetingId = roomName.slice(meetingRoomPrefix.length);

            socket.to(roomName).emit("meeting:participant-left", {
              meetingId,
              userId: Number(socket.user.id),
            });

          }

        });

        const userSockets =
          onlineUsers.get(
            presenceKey
          );

        if (
          userSockets
        ) {
          userSockets.delete(
            socket.id
          );

          // Only mark offline when
          // ALL tabs/devices disconnect.

          if (
            userSockets.size ===
            0
          ) {
            onlineUsers.delete(
              presenceKey
            );

            io.to(presenceRoom(companySlug)).emit(
              "user:offline",
              {
                userId:
                  Number(
                    userId
                  ),
              }
            );
          }
        }
      }
    );
  }
);

// ==========================================
// MAKE SOCKET.IO AVAILABLE TO ROUTES
// ==========================================

app.set(
  "io",
  io
);

app.set(
  "onlineUsers",
  onlineUsers
);

// ==========================================
// DUE SOON / OVERDUE NOTIFICATION SWEEP
// Small dedicated job module (server/jobs/), not
// inline here -- see notificationSweep.js for the
// query, dedup, and scheduling details. Disable via
// NOTIFICATION_SWEEP_ENABLED=false.
// ==========================================

require("./jobs/notificationSweep").start(io);

// ==========================================
// SUBSCRIPTION LIFECYCLE SWEEP (Phase 12C)
// Platform-level -- scans groworgs_platform_db.companies only, never
// tenant business data. Disable via LIFECYCLE_SWEEP_ENABLED=false.
// See jobs/subscriptionLifecycleSweep.js and services/
// subscriptionLifecycleService.js for the full design.
// ==========================================

require("./jobs/subscriptionLifecycleSweep").start();

// ==========================================
// SECURITY MIDDLEWARE (Phase 14I)
//
// Explicit CSP rather than helmet's implicit default -- this server
// never serves the frontend SPA itself (Vite dev / a separate static
// host does; confirmed no express.static/sendFile of index.html
// anywhere in this file), so CSP here is NOT what governs the React
// app's own script loading (Razorpay Checkout, Vite assets, etc are
// completely unaffected regardless of this policy). The ONE place CSP
// actually matters on this server is the authenticated /uploads/*
// file-serving route: if an uploaded file were ever served with an
// HTML/script-capable Content-Type, a restrictive default-src/script-
// src is real defense-in-depth against that content executing as a
// stored-XSS payload. (The primary fix for that risk is upload
// extension/MIME allow-listing -- see utils/fileTypeValidation.js --
// this is the second, independent layer, not the only one.)
// ==========================================

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy:
        "cross-origin",
    },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        imgSrc: ["'self'", "data:"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
      },
    },
  })
);

// ==========================================
// CORS CONFIGURATION
// ==========================================

app.use(
  cors({
    origin: ALLOWED_ORIGINS,

    credentials:
      true,

    methods: [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ],

    allowedHeaders: [
      "Content-Type",
      "Authorization",
    ],
  })
);

// ==========================================
// GLOBAL API RATE LIMIT (Phase 14F)
//
// A generous backstop applied to everything EXCEPT the Razorpay
// webhook (server-to-server traffic from Razorpay itself, which must
// never share a budget with ordinary browser clients possibly behind
// the same corporate NAT/proxy IP) and the authenticated file-serving
// route (already protected by its own signed, short-lived,
// per-file token -- see the /uploads/*splat route below). See
// middleware/rateLimiters.js for why this is deliberately generous,
// not a brute-force control.
// ==========================================

app.use((req, res, next) => {
  if (req.path === "/api/platform/payments/webhook/razorpay" || req.path.startsWith("/uploads/")) {
    return next();
  }
  return globalApiLimiter(req, res, next);
});

// ==========================================
// GENERAL MIDDLEWARE
// ==========================================

app.use(
  express.json({
    // Explicit size limit (Phase 14F) -- previously relied on
    // express.json()'s implicit 100kb default; now documented and
    // intentional (config/securityConfig.js). File uploads go through
    // multer's own separate, larger, per-route limits and are
    // unaffected.
    limit: JSON_BODY_LIMIT,
    // Captures the exact raw request-body bytes on every request
    // (cheap -- just holds a reference to the buffer express.json()
    // already reads) so a webhook route can verify a provider's HMAC
    // signature against the SAME bytes that were signed. Re-serializing
    // the already-parsed body (JSON.stringify(req.body)) would not
    // reliably reproduce the original bytes (key order/whitespace can
    // differ) and would silently break signature verification -- see
    // paymentProviders/razorpayProvider.js and
    // controllers/platformPaymentController.js's handleRazorpayWebhook.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: JSON_BODY_LIMIT,
  })
);

app.use(
  cookieParser()
);

// Phase 15O -- "dev" is a colorized, single-line-per-request format
// meant for an interactive terminal; it's still perfectly readable in
// a production log file, but "combined" (Apache common log format)
// is the more conventional choice once logs are actually being
// collected/parsed by something (a log aggregator, `grep`, etc), and
// neither format ever includes request/response bodies -- so no
// password, token, or payment field is ever written to these logs
// either way.
app.use(
  morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")
);

// Signs every /uploads/... path in any outgoing JSON response with a
// tenant-scoped file access token -- see
// middleware/signFileUrlsMiddleware.js. Mounted globally (not
// per-route) so it applies uniformly to every controller without
// requiring each one to opt in individually.
app.use(
  signFileUrlsMiddleware
);

// ==========================================
// SERVE UPLOADED FILES
// ==========================================

// ==========================================
// AUTHENTICATED FILE SERVING (Multi-Tenant File Storage Phase)
//
// Replaces the previous unauthenticated express.static("/uploads")
// mount entirely -- confirmed a real vulnerability, not just a
// theoretical one: every existing filename is only
// `<prefix>-${Date.now()}-${random 0..999999}${ext}`, and the static
// route had no rate limiting, making a stored file's name
// brute-forceable within a plausible upload-time window by anyone
// who could reach this server, regardless of tenant.
//
// A request must now carry a `fat` (file access token) query
// parameter -- a short-lived, tenant-scoped JWT minted only by
// signFileUrlsMiddleware.js (for REST responses) or the two explicit
// Socket.IO emit call sites (chatController.js/meetingController.js)
// that already ran inside an authenticated request. The token is the
// credential itself, the same way a presigned URL is -- this is what
// keeps <img src="..."> working with zero frontend changes (Part 5's
// constraint, confirmed by investigation across 4 client components)
// while still making a bare URL insufficient on its own (Part 4).
//
// Three independent checks, not just one:
//   1. the token's signature/expiry is valid, AND its embedded
//      `path` claim EXACTLY matches the requested pathname -- a
//      token minted for one file can never be replayed against a
//      different one, even within the same tenant.
//   2. the resolved absolute filesystem path is verified to stay
//      inside UPLOADS_ROOT -- independent path-traversal defense,
//      even though every path that reaches here was already
//      server-generated (never taken from user input) at upload
//      time.
//   3. the path's own tenant segment (parsed from
//      /uploads/tenant_<slug>/... , or the legacy "reinsteins"
//      default for a pre-existing un-prefixed path) must match the
//      token's companySlug -- redundant with check 1 today, but an
//      independent layer against a future bug in the signing logic.
//
// The company is also re-verified as currently ACTIVE at serve time
// (not just trusted from the up-to-2h-old token) -- consistent with
// tenantProtect/tenantConnectionManager re-checking status on every
// use rather than trusting a stale value.
// ==========================================

app.get(
  "/uploads/*splat",
  async (req, res) => {
    try {

      const token = req.query.fat;

      if (!token) {
        return res.status(401).json({ success: false, message: "Missing file access token" });
      }

      let decoded;
      try {
        decoded = verifyFileAccessToken(token);
      } catch (_verifyError) {
        return res.status(401).json({ success: false, message: "Invalid or expired file access token" });
      }

      const requestedPath = req.path;

      if (decoded.path !== requestedPath) {
        return res.status(403).json({ success: false, message: "File access token does not match the requested file" });
      }

      // Path-traversal defense, independent of the token check above.
      const relativePart = requestedPath.replace(/^\/uploads\//, "");
      const resolvedPath = path.resolve(UPLOADS_ROOT, relativePart);

      if (resolvedPath !== UPLOADS_ROOT && !resolvedPath.startsWith(UPLOADS_ROOT + path.sep)) {
        return res.status(400).json({ success: false, message: "Invalid file path" });
      }

      // The path's own tenant segment must match the token's tenant.
      const tenantSegmentMatch = requestedPath.match(/^\/uploads\/tenant_([a-z0-9_]+)\//);
      const pathImpliedCompanySlug = tenantSegmentMatch ? tenantSegmentMatch[1] : LEGACY_COMPANY_SLUG;

      if (pathImpliedCompanySlug !== decoded.companySlug) {
        return res.status(403).json({ success: false, message: "File access token does not match this file's tenant" });
      }

      // Re-verify the company is still active right now -- a
      // suspended company must lose file access immediately, not
      // just wait out the token's remaining lifetime. Phase 8 extends
      // this with subscription enforcement (cancelled/expired
      // status, or a lapsed trial/subscription date) -- same
      // immediate-loss behavior, same message.
      if (decoded.companySlug !== LEGACY_COMPANY_SLUG) {
        const company = await platformCompanyService.getCompanyBySlug(decoded.companySlug);
        if (!company || !platformCompanyService.isCompanyAccessAllowed(company)) {
          return res.status(403).json({ success: false, message: "This company is not currently active" });
        }
      }

      if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return res.status(404).json({ success: false, message: "File not found" });
      }

      return res.sendFile(resolvedPath);

    } catch (error) {
      console.error("File serve error:", error);
      return res.status(500).json({ success: false, message: "Unable to serve file" });
    }
  }
);

// ==========================================
// MAIN TEST ROUTE
// ==========================================

app.get(
  "/",
  (
    req,
    res
  ) => {
    return res
      .status(200)
      .json({
        success: true,

        message:
          "Reinsteins WorkHub Backend is running",
      });
  }
);

// ==========================================
// HEALTH CHECK (Phase 15M)
//
// Deliberately unauthenticated (a load balancer / uptime monitor /
// process manager needs to reach this without a credential) and
// deliberately minimal in what it reveals -- a status string and,
// optionally, a coarse per-database "healthy"/"unreachable" flag.
// Never returns: connection strings, credentials, hostnames, error
// messages/stack traces, row counts, or any other internal detail.
// Each DB check is a trivial `SELECT 1` with its own short timeout so
// a slow/down database degrades this endpoint's own status instead of
// hanging it indefinitely.
// ==========================================

function checkPoolHealthy(poolToCheck, timeoutMs = 2000) {
  return Promise.race([
    poolToCheck.query("SELECT 1").then(() => true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

app.get(
  "/health",
  async (req, res) => {
    const [legacyDbHealthy, platformDbHealthy] = await Promise.all([
      checkPoolHealthy(pool),
      checkPoolHealthy(require("./config/platformDb")),
    ]);

    const allHealthy = legacyDbHealthy && platformDbHealthy;

    return res.status(allHealthy ? 200 : 503).json({
      status: allHealthy ? "ok" : "degraded",
      database: legacyDbHealthy ? "healthy" : "unreachable",
      platformDatabase: platformDbHealthy ? "healthy" : "unreachable",
    });
  }
);

    // TASKS

app.use(
  "/api/tasks",
  taskRoutes
);
console.log("Registering task-management routes");


app.use(
  "/api/task-management",
  taskManagementRoutes
);

app.use(
  "/api/task-work",
  taskWorkRoutes
);

// PROJECT / USER STORY / TASK HIERARCHY

app.use(
  "/api/projects",
  projectRoutes
);

app.use(
  "/api/organizations",
  organizationsRoutes
);

app.use(
  "/api/epics",
  epicRoutes
);

app.use(
  "/api/features",
  featureRoutes
);

app.use(
  "/api/user-stories",
  userStoryRoutes
);

app.use(
  "/api/sprints",
  sprintRoutes
);

app.use(
  "/api/task-activity",
  taskActivityRoutes
);

app.use(
  "/api/tags",
  tagRoutes
);

app.use(
  "/api/work-item-links",
  workItemLinkRoutes
);

console.log("Task-management routes registered");
// ==========================================
// API ROUTES
// ==========================================

// AUTH

app.use(
  "/api/auth",
  authRoutes
);
app.use("/api/files", fileRoutes);
// DASHBOARD

app.use(
  "/api/dashboard",
  dashboardRoutes
);

// EMPLOYEES + PROFILE

app.use(
  "/api/employees",
  employeeRoutes
);

// DEPARTMENTS / DESIGNATIONS / ORGANIZATION STRUCTURE

app.use(
  "/api/departments",
  departmentRoutes
);

app.use(
  "/api/designations",
  designationRoutes
);

app.use(
  "/api/organization",
  organizationRoutes
);

// ATTENDANCE

app.use(
  "/api/attendance",
  attendanceRoutes
);

// SHIFT SCHEDULE

app.use(
  "/api/shifts",
  shiftScheduleRoutes
);

// LEAVE

app.use(
  "/api/leaves",
  leaveRoutes
);

// REPORTS

app.use(
  "/api/reports",
  reportRoutes
);

// NOTIFICATIONS

app.use(
  "/api/notifications",
  notificationRoutes
);

// CHAT

app.use(
  "/api/chat",
  chatRoutes
);

// MEETINGS

app.use(
  "/api/meetings",
  meetingRoutes
);

// ==========================================
// GROWORGS PLATFORM (Phase 2B)
// Isolated from every tenant route above -- own JWT secret
// (PLATFORM_JWT_SECRET), own middleware (platformProtect), own
// database (groworgs_platform_db). Nothing here reads or writes
// the tenant database or the tenant `users` table.
// ==========================================

app.use(
  "/api/platform/auth",
  platformAuthRoutes
);

app.use(
  "/api/platform/companies",
  platformCompanyRoutes
);

app.use(
  "/api/platform/demo-requests",
  platformDemoRequestRoutes
);

app.use(
  "/api/platform/plans",
  platformPlanRoutes
);

app.use(
  "/api/platform/payments",
  platformPaymentRoutes
);

app.use(
  "/api/platform/audit-logs",
  platformAuditRoutes
);

app.use(
  "/api/platform/notifications",
  platformNotificationRoutes
);

app.use(
  "/api/platform/email-logs",
  platformEmailRoutes
);

app.use(
  "/api/tenant-auth",
  tenantAuthRoutes
);

app.use(
  "/api/email",
  tenantEmailRoutes
);

// ==========================================
// GROWORGS PUBLIC WEBSITE (Phase 6)
// No authentication -- this is the public marketing site's backend
// surface (currently just the demo-request form). See
// routes/publicRoutes.js.
// ==========================================

app.use(
  "/api/public",
  publicRoutes
);

// ==========================================
// 404 ROUTE
// KEEP AFTER ALL API ROUTES
// ==========================================

app.use(
  (
    req,
    res
  ) => {
    return res
      .status(404)
      .json({
        success: false,

        message:
          "API route not found",
      });
  }
);

// ==========================================
// CENTRALIZED ERROR HANDLER (Phase 8, consolidated in Phase 15U)
//
// No 4-arg Express error-handling middleware existed anywhere in
// this app before Phase 8. In practice that meant a malformed JSON
// request body (express.json() rejects it with a SyntaxError and
// calls next(err), skipping every ordinary route/middleware including
// the 404 handler above) fell all the way through to Express's own
// built-in default error handler -- an HTML response, inconsistent
// with the JSON the rest of this API always returns, and one that
// includes the stack trace unless NODE_ENV=production.
//
// Phase 14P had added a SECOND app.use((err,...)) block after this
// one, intending to add production-aware message hiding. Since this
// handler always sends a response without calling next(err), Express
// never reached that second block -- it was dead code, and the
// production-aware hiding it was meant to add never actually ran (the
// message below was always the same generic string, in every
// environment, until this fix). Consolidated back into the ONE
// handler Express actually uses, keeping both original intents:
// the malformed-body special case, and hiding internal error details
// in production while keeping them visible for local debugging
// otherwise. This must stay the LAST app.use() call -- that ordering
// is what makes Express treat it as an error handler at all.
// ==========================================

// eslint-disable-next-line no-unused-vars
app.use(
  (err, req, res, next) => {

    console.error(`[unhandled error] ${req.method} ${req.originalUrl}:`, err);

    if (res.headersSent) {
      return next(err);
    }

    if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
      return res.status(400).json({
        success: false,
        message: "Malformed request body",
      });
    }

    const isProduction = process.env.NODE_ENV === "production";

    return res.status(err.status || 500).json({
      success: false,
      message: isProduction ? "An unexpected error occurred." : (err.message || "An unexpected error occurred."),
    });

  }
);

// ==========================================
// START HTTP + SOCKET.IO SERVER
// ==========================================

server.listen(
  PORT,
  "127.0.0.1",
  () => {
    console.log(
      "-------------------------------------------"
    );

    console.log(
      "Reinsteins WorkHub Backend"
    );

    console.log(
      `Server running on http://localhost:${PORT}`
    );

    console.log(
      "Socket.IO real-time server is running"
    );

    console.log(
      "WebRTC call signaling is enabled"
    );

    console.log(
      "Profile photos available at /uploads/profiles/"
    );

    console.log(
      "Reports API available at /api/reports/"
    );

    console.log(
      "Notifications API available at /api/notifications/"
    );

    console.log(
      "-------------------------------------------"
    );
  }
);