# Smart Sheets

Collaborative spreadsheets inside the CRM: admins create or upload spreadsheets and assign employees; assigned
employees edit the same sheet at the same time and see each other's changes.

Free/open-source only: the editor is **Univer Community Edition** (Apache-2.0; `@univerjs/icons` is MIT), Excel
import/export uses the **ExcelJS** the server already had, and live collaboration runs on the **Socket.IO** the CRM already
had. No Univer Pro, collaboration server or paid plugin is used (`_test_smart_sheets_client.js` fails if one appears).

## Who can do what

Reuses the CRM's existing roles; there are no new global roles.

| | Admin tier (`role = admin`, or `system_access` = `admin` / `super_admin`) | Everyone else |
|---|---|---|
| See spreadsheets | all (not deleted) | only those **assigned** to them (and not archived) |
| Create / upload / rename / archive / delete | yes | no (403) |
| Assign / unassign / change permission | yes | no (403) |
| Edit | yes (not while archived) | only with an `edit` assignment; `view` assignments are read-only |

* Every request **re-reads the user's role, status and assignment from the database** (`smartSheetStore.getAccessContext`
  + `utils/smartSheetAccess.resolveAccess`). Nothing comes from the JWT or the browser, so a demotion, deactivation or
  unassign takes effect on the next request/edit.
* An unassigned employee and a non-existent id get the **same** `404 NOT_FOUND`, so ids cannot be probed.
* Unassigning, archiving or deleting also removes the affected sockets from the live room **immediately**.

## Data model (per tenant database; PostgreSQL)

`smart_sheets` (one row per spreadsheet; `revision` bigint; soft delete via `deleted_at`),
`smart_sheet_access` (employee assignments, `view` | `edit`, unique per sheet+user),
`smart_sheet_worksheets` (tabs; `ws_key` is the editor's sheet id; `layout` jsonb holds column widths / row heights),
`smart_sheet_cells` (one row per non-empty cell: `cell` jsonb = value, formula, inline style, number format `nf`).

Defined once in `schemas/smartSheetsDdl.js`; the identical statements are appended to
`schemas/tenantSchema.postgresql.sql` (new tenants) and run by `_migrate_add_smart_sheets.js` (existing tenants **and** the
legacy database, in `IF NOT EXISTS` form, one transaction per database, advisory lock, `--dry-run` supported).
`deploy.yml` runs the migration before the client build and the restart.

## Live collaboration (no CRDT, by design)

Univer commands become small **operations** (`utils/smartSheetSync.js` on the client): the full new value of each changed
cell, a worksheet add/rename, or a column-width/row-height change. Socket events (`services/smartSheetRealtime.js`):

* `smartsheet:join {sheetId}` -- re-checks access (before **and after** joining, which closes the unassign race).
* `smartsheet:op {sheetId, op}` -- re-checks access, validates, **saves**, and only then broadcasts to the other users.
* `smartsheet:leave`, `smartsheet:presence`, `smartsheet:access-revoked`, `smartsheet:access-changed`.

Rooms are `tenant:<scope>:smartsheet:<id>` (from `utils/socketRooms.js`). The **scope names a database**: `legacy-db` for the legacy
Reinsteins database, the company slug for a tenant database (`config/db.js roomScopeOf`). The legacy database and the tenant
company `reinsteins` have the same slug but different data and independent ids, so a slug-only name would have put legacy
sheet 5 and tenant sheet 5 in one room. `legacy-db` contains a hyphen, so it can never equal a company slug. User and presence
rooms use the same scope.

### The last-write-wins rule

> Every save locks the spreadsheet row (`UPDATE smart_sheets SET revision = revision + 1 ... RETURNING revision`), so
> PostgreSQL applies all writes to one spreadsheet one after another and gives each a revision number. If two people change
> the **same cell** at the same moment, the write that got the **higher revision wins and replaces the cell completely**
> (value, formula, formatting and number format). Neither edit is rejected. The server then announces writes in exactly the
> commit order (per-sheet queue), and a client never overwrites a cell it still has an unsaved edit for, so every screen
> ends up showing the value stored in the database.

Edits to **different** cells never conflict.

### Saving and recovery

* The editor shows `Saving…` until the server acknowledges the **committed** save, then `Saved`.
* Offline or disconnected: edits are kept in the page and sent, in order, when the connection returns (a banner says so).
* **First load and every reconnect use ONE code path** (`client/src/utils/smartSheetSession.js`): join the live room, flush this
  tab's unsaved edits (with a timeout), load the saved state, replay the live changes that arrived meanwhile (in revision
  order), then re-open editing. Editing is paused while this runs. If it cannot finish, the workbook is **not** replaced (typed
  data is kept), the header shows *Out of date*, and it retries with backoff (1 s ... 15 s, forever; *Retry now* skips the wait).
* Every change carries an `opId`. A retry after a lost acknowledgement re-sends the same `opId`; the server answers the
  original revision and does **not** apply or broadcast it twice (kept 10 min, max 20,000 entries). A connection that is "up"
  but silent triggers a controlled reconnect; a change that still cannot be delivered is reported and does not block the queue.
* A large paste is split by **serialized size** (about 256 KB per message), not only by cell count. Socket.IO accepts messages up
  to 2 MB, above the 512 KB validator limit, so an oversized change gets a proper error instead of a dropped connection.
* A refresh always shows the latest saved state (`GET /api/smart-sheets/:id/workbook`).
* A save the server **refuses** (validation, no access, read-only) is reported ("Not saved" + banner with *Reload saved version*).

## Excel (.xlsx)

Upload: `.xlsx` only; extension **and** content are checked (ZIP signature, then a full ExcelJS parse); 10 MB limit; stored as
`uploads/tenant_<company>/smart-sheets/<random>.xlsx` (the client's file name is never used as a path); rejected files are deleted.

Kept (both directions): worksheet names and order, text/numbers/booleans/dates, formulas, number formats, bold/italic/
underline/strikethrough, font name/size/colour, solid fills, alignment, text wrap, borders, column widths, row heights.

**Not** kept -- reported to the admin after import where ExcelJS can detect it: merged cells, images, data validation,
conditional formatting, tables (imported as plain cells), cell comments, hidden-sheet state, rich-text runs (flattened),
theme colours. Charts, pivot tables and macros cannot be detected and are dropped. `.xls`, `.xlsm`, password-protected and
corrupt files are refused with an error. Formulas containing `|` outside a string (a DDE pattern) are refused.
Formula results are recomputed when a sheet is opened; an exported formula cell has its last known value when one was stored.

## Limits (server-enforced; `utils/smartSheetValidation.js`)

100,000 rows x 1,000 columns, 50 worksheets, 5,000 cells and 512 KB per change, 32,767 characters per cell, 10 MB upload,
200,000 non-empty cells per import, 300 changes per 10 s per socket. Default blank sheet: 1,000 x 26.

Growth and abuse limits (all checked **before** anything is stored):

* 200,000 non-empty cells and 25 MB of stored cell data per spreadsheet (`SHEET_FULL`); this also bounds the workbook response.
* Per **user**, across all their sockets/tabs: 600 changes per 10 s and 100,000 cells per minute (`RATE_LIMITED` + `retryAfterMs`).
* Imports: the .xlsx is a zip, so its **declared uncompressed size** (<= 50 MB, <= 2,000 parts, no ZIP64/encryption) is read from
  the zip directory before any parsing; parsing then runs in a **child process** (768 MB heap, 60 s timeout, no credentials in its
  environment); at most 2 imports run at once process-wide and 1 per user; 5 imports per user per 10 minutes.
* Keys for every limiter include the database scope, because user ids restart at 1 in each database.

## Not supported yet

Inserting, deleting, moving, hiding or merging rows/columns/cells, and deleting, reordering or copying worksheets, are
**blocked in the editor** (a message explains) rather than allowed to diverge. Frozen panes, filters, charts, comments, images
and data validation are not synchronised or stored. Version history is not part of this MVP (the data model leaves room for it).

## Operations notes

* Needs no new environment variable and no new server dependency.
* A deploy restarts the Node process, which drops every live connection; open editors reconnect automatically and keep
  unsaved edits.
* Persist-then-broadcast ordering relies on **one Node process** (the current deployment). Running several processes would
  need a shared ordering/lock in the Socket.IO adapter.
* Deleting a spreadsheet is a soft delete (`deleted_at`); rows remain until removed by hand. Uploaded `.xlsx` files are kept on
  disk (up to 10 MB each).
* A user whose account is deactivated is refused on their next join/edit/request; their already-open socket keeps *receiving*
  changes until it disconnects (it cannot save).

## Tests

`node --test _test_smart_sheets_*.js` (all are in the `server-tests` list of `.github/workflows/pr-checks.yml`).
They run the real service, validation, Socket.IO handlers, Express router, upload middleware and Excel code against an
in-memory store (`_smart_sheets_test_support.js`), because CI has no database for these tests. The SQL itself was run against
a real PostgreSQL: `_test_smart_sheets_pg.js` runs the migration, the store and the service (legacy `users.id` INTEGER and BIGINT,
the full tenant schema, growth caps, concurrency) against a disposable PostgreSQL in the `migration-postgres` CI job.
Regression tests for the review findings: `_test_smart_sheets_hardening.js` (room scopes, transport limit, growth caps, per-user
limits, import isolation) and `_test_smart_sheets_resilience.js` (reconnect, retries, chunking).
