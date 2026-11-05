# Tenant feature management

The Owner chooses which CRM modules each company can use. It is enforced on the server (APIs, Socket.IO events, uploaded
files); the browser only hides what the server would refuse.

## The modules (`config/tenantFeatures.js`, the single source of truth)

| id | Module | Needs |
|---|---|---|
| `dashboard` | Dashboard | |
| `employee_management` | Employee Management (employees, departments, designations, organization chart, hierarchy, My Team) | |
| `attendance` | Attendance Management | |
| `leave_management` | Leave Management | |
| `shift_management` | Shift Management | `employee_management` |
| `task_management` | Task Management | |
| `techops` | TechOps (projects, epics, features, user stories, sprints, work-item links) | `task_management` |
| `reports` | Reports (each report also needs the module whose data it reads) | |
| `chat` | Chat (and the calls started from it) | |
| `meetings` | Meetings | `employee_management` |
| `sops` | SOP Library | |
| `smart_sheets` | Smart Sheets | |
| `email` | Company Email | |
| `ziovault` | ZioVault (client-side-encrypted password manager; see ZIOVAULT_ARCHITECTURE.md) | |

Always available to a signed-in user, whatever is enabled: sign-in and password change, My Profile
(`/api/employees/profile/*`), Settings, notifications, signed file access. Feature ids are stable identifiers; never rename or
reuse one.

**Dependencies** are real: Shift Management builds its schedule from the employee list, Meetings picks participants by
department, TechOps work items are tasks. The Owner Portal never enables or disables a module behind the Owner's back: choosing a
module whose requirement is off, or turning off a module others need, is refused with an explanation and one explicit button
("Turn on Employee Management and Meetings"). The server enforces the same rule (`400 MISSING_DEPENDENCIES`).

## Where it is stored

Platform database, table `company_features (company_id, feature_id, enabled, updated_by, updated_at)`, primary key
`(company_id, feature_id)`, foreign key to `companies` with `ON DELETE CASCADE` (`schemas/companyFeaturesDdl.js`, copied
verbatim into `schemas/platformSchema.postgresql.sql`). It lives in the platform database, not in tenant databases: one copy,
and a tenant (even its admin) can neither read another company's configuration nor change its own.

* A company with **no rows** has never been configured and gets **every** module (backward compatible).
* A configured company is exactly its rows. A module added to the catalog later is **off** until the Owner turns it on.
* Writes replace the whole selection in one transaction; a failed write leaves the previous selection intact.

## Existing companies

`_migrate_add_company_features.js` (a step in `.github/workflows/deploy.yml`, before the restart) creates the table and gives
**every existing company every module**, so nothing a company has today is removed. It only touches companies with no rows, so
re-running it never re-enables a module the Owner switched off. It touches no tenant database. The legacy Reinsteins database
(sessions signed with `JWT_SECRET`) is not feature-managed and keeps every module.

## Enforcement

* **APIs**: one gate for all of `/api` (`middleware/featureGate.js`, mounted once in `app.js` before the routes). The path -> feature
  table is in the catalog (`API_RULES`); `_test_tenant_features.js` fails if a mounted `/api/...` group is neither gated nor
  declared core. The company comes from the **signed token** (`companyId` + `companySlug`, re-resolved against the platform
  database), never from a header, query or body. A disabled module answers `403 { code: "FEATURE_NOT_ENABLED" }`. No/invalid
  token: passed through, the route's own authentication answers 401. If the configuration cannot be read the gate **fails
  closed** (503).
* **Socket.IO**: every event is registered through `onTenantEvent`, which now checks the feature first
  (`services/socketFeatureGate.js`, event prefixes `conversation:`/`call:`/`webrtc:` = chat, `meeting:` = meetings,
  `smartsheet:` = smart sheets). A refused event gets the acknowledgement `{ success:false, code:"FEATURE_NOT_ENABLED" }` (or a
  `feature:not-enabled` event when there is no callback). Checked on **every** event, in arrival order, fail closed.
* **Files**: `/uploads/tenant_<slug>/<chat|meetings|tasks|sops|smart-sheets>/...` is not served when its module is off.
* **Dashboard**: `/api/dashboard/stats` only queries and returns the sections of the modules the company has.

The configuration is cached for 3 s per company and the cache entry is dropped the moment the Owner saves, so on this single
Node process a change applies to the very next request. (Several processes would need a shared invalidation.)

## Owner Portal

* **Create company**: a *Feature Configuration* section (cards with name, description, toggle, Enabled/Disabled, *Select All*,
  *Deselect All*, "n of m selected"). Everything starts selected; the Owner removes what the company must not have. The selection
  is sent with `POST /api/platform/companies` and stored before the company can become active. Omitting `features` (an older
  caller) means every module; an empty or invalid selection is refused before anything is created.
* **Existing company**: *Features* card on the company details page (`GET/PUT /api/platform/companies/:id/features`, behind
  `platformProtect`). Saving takes effect immediately, is written to the audit log (`company_features_updated`: who, enabled,
  disabled), and is pushed to the company's open sessions.
* Switching a module off **never deletes data**; switching it on restores everything that was there.

## What the company's users see

The sign-in response and `GET /api/tenant-auth/me` carry the company's enabled list. The browser (`context/TenantFeatures.jsx`):
hides disabled modules in both sidebars, the dashboards and the Settings page; wraps every module route so a disabled module shows
"This feature is not enabled for your organization." and its page is **never mounted** (so it never asks for data); sends a user
whose dashboard is off to the first module they have. A screen that is already open is updated without a reload by the socket event
`tenant:features-changed` (the server also removes the user from that module's live rooms), by any `FEATURE_NOT_ENABLED` API answer,
and when the tab regains focus.

## Tests

`_test_tenant_features.js` (catalog, drift guards, API gate, socket gate, Owner API, live revalidation, isolation),
`_test_tenant_features_rendered.js` (the real Owner Portal UI, route gate, provider, sidebars in jsdom),
`_test_company_features_pg.js` (real PostgreSQL: table, schema file, migration and backfill, persistence, rollback, isolation,
cascade; runs in the `migration-postgres` CI job).

## Known limits

* Chat notification popups and the persistent meeting bar are passive listeners mounted outside the module routes; with the module
  off the server delivers nothing to them.
* The executive dashboard (`ExecutiveDashboard`) is built on the organization data and needs `employee_management`.
* A single Node process is assumed (cache and socket notification), as for the rest of the CRM.
