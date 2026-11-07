# Mandatory password change -- rollout guide

Employees who hold a company-issued **temporary password** must replace it before they can use the CRM.
This guide is for whoever approves, deploys and supports the change.

## What employees will experience

1. **First sign-in after the rollout.** They sign in as usual (Employee ID or company email + the temporary password).
   Instead of the dashboard they land on **"Set Your New Password"** and cannot reach any other page.
2. They enter the **temporary password**, a **new password** and a **confirmation**. The page lists the rules and
   ticks them off live. The default rules are 10+ characters with an uppercase letter, a lowercase letter and a number
   (set by `PASSWORD_MIN_LENGTH`, `PASSWORD_REQUIRE_UPPERCASE|LOWERCASE|DIGIT` in `server/.env`). The new password
   must differ from the temporary one.
3. On success they go **straight to their dashboard**. Every later sign-in is normal -- the change is asked for **once**.
4. If they wait more than **10 minutes** on that page, or refresh after it has expired, they are sent back to the
   sign-in page to start again. "Back to sign in" on the page does the same. Nothing is changed in either case.
5. The temporary password stops working the moment the new one is saved.

## Who is affected

| Account | Behaviour |
|---|---|
| Existing employees (role `employee`, including managers, executives, HR, interns) | Flagged **once** by the migration; must change at next sign-in |
| Existing **inactive** employees (role `employee`, `status` other than `active`/`pending`) | Flagged too; asked to change only if they are reactivated and sign in |
| Rows whose `status` is NULL | **Not** flagged (`status <> 'pending'` is not true for NULL) |
| Employees created from now on (Add Employee form, `createEmployee.js`) | Created flagged -- they hold a temporary password |
| Admin and Super Admin accounts that already exist | **Not** flagged by the deploy migration; flagged by the second step below |
| The company's **System Administrator** (`users.is_system_administrator = TRUE`, one per database) | **Never** flagged by either step |
| Pending self-registrations (chose their own password) | Not flagged |
| First admin created by the platform owner for a company | Not flagged -- it is that company's System Administrator |

## Sessions are ended at rollout (plan for this)

When the migration flags an employee, any session they already have open **stops working at their next request**
(HTTP 401, real-time connections are refused too). In practice, everyone who is signed in at the moment of the deploy
(other than admins) will see an error or the sign-in page on their next action; **refreshing the page takes them to
sign-in**, and they then follow the flow above. Nothing is lost server-side. A tab that was opened **before** the deploy
is still running the old build, which does not understand the new sign-in answer: it shows "Invalid login response"
until the page is refreshed (which loads the new build). Employees will normally refresh anyway when their session ends.

After someone changes their password, **all of their older sessions** (for example on another device) also end.
The Settings "change password" screen is unchanged and does not end the current session.

**Suggested announcement:** *"From <date> you will be asked to replace your temporary CRM password the next time you
sign in. Sign in with the password we gave you, then choose a new one (at least 10 characters, with upper- and
lower-case letters and a number). If you are signed in when the update goes live you will be signed out once."*

## Deploy sequence

The deploy (`.github/workflows/deploy.yml`, `set -e`) runs `node server/_migrate_add_must_change_password.js`
**after** the other migrations and **before** the client build and the service restart. If it exits non-zero the deploy
stops and the application is **not** restarted.

The script processes the legacy database (`DB_*` in `server/.env`) and every tenant registered in the platform
database's `companies` table (`PLATFORM_DB_NAME`; `tenant_db_name`, connected with `PLATFORM_DB_*`). In production
`DB_NAME` and `PLATFORM_DB_NAME` name the same database, `reinsteins_crm`: the legacy step alters only its `users`
table and never touches the platform tables there (`companies`, `platform_users`, ...); platform owner accounts live in
`platform_users` and are never flagged. Each tenant is a separate database with its own `users` table. Per database, in one transaction
under an advisory lock, it adds `users.must_change_password` and `users.password_changed_at` and -- **only in the run
that creates the column** -- flags the existing employees. Re-runs find the columns and change nothing, so nobody who
has already changed their password is flagged again; an overlapping run waits for the lock and then does nothing.
It never reads, writes or logs a password or hash.

Failure rules: an unreachable or missing **tenant** database, bad credentials, or a permission error **stops the
deploy**. The one exception is the **legacy** database, which is skipped (with a notice) if it does not exist at all
or if `DB_NAME` is unset. Production's deploy logs show two registered tenants (`tenant_reinsteins`, `tenant_client`).
In production the legacy database is `reinsteins_crm`; `reinsteins_workhub` is its name from before the move to
PostgreSQL and is still shown in `server/.env.example`. It still serves the unlisted `/legacy-login` route, so it is
migrated, not skipped.

## Before approving the merge (read-only, run on the production host by an administrator)

```
cd /var/www/reinsteins-crm
node server/_migrate_add_must_change_password.js --dry-run
```

The dry run only runs `SELECT`s. For every database it prints what a real run would do (how many accounts would be
flagged) and fails -- exit code 1 -- on anything that would stop the deploy: a missing or unreachable database, bad
credentials, or a database user that does not own the `users` table. The ownership check runs only for a database that
still lacks at least one of the two columns; a database that already has both is reported as `[skip]` without it.
Expect: one line per database, `exit 0`.
To see what exists, read-only:

```
psql -l                      # add your usual host/user options
psql -d "$PLATFORM_DB_NAME" -Atc "select id, company_slug, status, tenant_db_name from companies order by id"
```

## After the deploy

- The deploy log shows `[done] <database> -- columns added, N employee account(s) flagged` for each database
  (or `[skip]` on later runs).
- Sign in as a flagged test employee -> "Set Your New Password"; as an admin -> dashboard as before.

## Second step: require the remaining existing accounts (everyone except the System Administrator)

The first migration flagged the existing employees **only in the run that created the column**, and left Admin and
Super Admin accounts alone. `server/_migrate_flag_existing_accounts_password_change.js` flags **every** account that is
still unflagged -- employees (including managers, executives such as the CTO, HR, department heads and team leads),
admins and super admins -- in the legacy database and in every registered tenant database, **except the company's
designated System Administrator**. It is **manual** (it is not in `deploy.yml`) and run on the production host by an
administrator. **Platform owners are not included**: they live in `platform_users` and sign in through a separate flow.

Who is flagged (per database): `must_change_password = FALSE` **and** `password_changed_at IS NULL` **and**
`status <> 'pending'` **and** `is_system_administrator IS NOT TRUE`, in the chosen scope -- **employees** = role
`employee` whose `system_access` is not admin/super_admin; **admins** = role `admin`, or `system_access`
admin/super_admin (a Super Admin can have role `employee`). Never touched: the System Administrator, accounts already
flagged, accounts that changed their password through the forced flow, pending self-registrations, and every password
hash.

**The System Administrator** is identified **only** by `users.is_system_administrator = TRUE` -- never by role,
`system_access`, name or creation order (several accounts can be Super Admins). That column is written only when the
platform creates a company's first administrator and by `server/_migrate_backfill_system_administrator.js`, and a
unique index allows at most one per database. The preflight requires the column and **exactly one** such account in
every database, prints it (`[system-administrator] <database> -- excluded: employee_id ...`), and checks it again inside
the apply transaction. If a database has no column, none, or more than one, the run fails and **nothing is applied
anywhere** -- the script never guesses. Designate the account first (for a tenant, the backfill script designates
Reinsteins' account and prints `[NEEDS DECISION]` for any other tenant).

**The legacy database** has no `is_system_administrator` column, so by default it fails the preflight and blocks the
whole run. `--legacy-without-system-administrator` records the decision that the legacy database has **no exempt
account**: its eligible accounts, its admin included, are flagged without the exclusion, and the dry run prints
`[no-system-administrator] legacy database -- ...`. The option reaches the legacy target only -- every tenant still
needs exactly one designated System Administrator -- and only while that column is **absent**: it is checked in the
preflight and again inside the apply transaction, and if the column exists the run refuses. Before applying it,
make sure nobody but the account holder knows the legacy admin's current password (replace it first if it was ever
shared or written down); the forced change asks for the current password, so whoever knows it can complete it.

**Limitation -- voluntary changes.** `password_changed_at` is set only by the forced flow. The Settings "change
password" screen does not record it, so a password somebody chose themselves there looks the same as a temporary one
and that person is asked once more. If you know who they are, list them with `--skip-employee-ids`.

**1. Dry run (default; writes nothing)** -- on the production host:

```
cd /var/www/reinsteins-crm
node server/_migrate_flag_existing_accounts_password_change.js
```

One line per database (`[dry-run] ... would flag employees: N, admins: M`), then "Dry run only -- nothing was
written", exit 0. It is also the preflight: every database must have the `users` table, the two columns from the first
migration, and the privileges needed, or it prints `[FAILED]` and exits 1. Options: `--scope=employees|admins|all`
(default `all`; flag employees first and admins later if you prefer), `--skip-employee-ids=RS001,RS007`, and
`--legacy-without-system-administrator` (see above; give the same options to the dry run and to `--apply`).

**2. Apply** -- only after reviewing the dry run, outside working hours (flagged users are signed out at their next
request, administrators included):

```
node server/_migrate_flag_existing_accounts_password_change.js --apply
```

Every database must pass the preflight or **nothing is applied**. Databases are then applied one at a time, each in
one transaction under a lock; the run stops at the first failure (re-run the same command: finished databases are
skipped). A `[applied]` line per database. **Run-once:** each group is recorded in the table
`password_change_rollouts` as `existing-employees-v2` / `existing-admins-v2` (with the ids it flagged), in the same
transaction; a group with a record is never flagged again, even if a flag is cleared by hand later. The `-v2` names
belong to the current rules: a record from the earlier rules (`existing-employees` / `existing-admins`, which did not
exclude the System Administrator) makes the preflight fail, so it can neither skip accounts nor be silently ignored.
The preflight also fails if an eligible account belongs to neither group.

**3. Verify** (read-only, per database): `SELECT must_change_password, count(*) FROM users GROUP BY 1;`, and
`SELECT name, scope, flagged_count, completed_at FROM password_change_rollouts;`. Sign in with a flagged test account:
"Set Your New Password" on every sign-in until it is changed, then a normal sign-in.

**4. Rollback** -- passwords are never changed, so rollback only clears flags. Per database, to undo exactly this
step (not the first migration's flags):
`UPDATE users SET must_change_password = FALSE WHERE password_changed_at IS NULL AND id IN (SELECT unnest(flagged_user_ids) FROM password_change_rollouts);`
Accounts that already changed their password keep the new one. To allow a re-run afterwards, an administrator would
also have to delete the matching rows from `password_change_rollouts`; leave them to prevent a second flagging.

## Rollback and support

- **Reverting the deploy** removes the check. The columns stay and are harmless; passwords are never touched.
- **Pause enforcement without reverting**, per database (this clears everyone's pending state; it changes no password):
  `UPDATE users SET must_change_password = FALSE;`  To require it again for one person:
  `UPDATE users SET must_change_password = TRUE WHERE employee_id = '<id>';`
- There is **no administrator password-reset screen** in the CRM today. An employee who does not have their
  temporary password cannot sign in, and fixing that needs a developer or DBA (out of scope here).
- The forced-change endpoints share the sign-in rate limiter.
