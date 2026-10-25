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
| Employees created from now on (Add Employee form, `createEmployee.js`) | Created flagged -- they hold a temporary password |
| Admin and Super Admin accounts that already exist | **Not** flagged; sign in exactly as before |
| Pending self-registrations (chose their own password) | Not flagged |
| First admin created by the platform owner for a company | Not flagged |

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

The script processes the legacy database (`DB_*` in `server/.env`) and every tenant registered in
`groworgs_platform_db.companies` (`tenant_db_name`, connected with `PLATFORM_DB_*`). Per database, in one transaction
under an advisory lock, it adds `users.must_change_password` and `users.password_changed_at` and -- **only in the run
that creates the column** -- flags the existing employees. Re-runs find the columns and change nothing, so nobody who
has already changed their password is flagged again; an overlapping run waits for the lock and then does nothing.
It never reads, writes or logs a password or hash.

Failure rules: an unreachable or missing **tenant** database, bad credentials, or a permission error **stops the
deploy**. The one exception is the **legacy** database, which is skipped (with a notice) if it does not exist at all
or if `DB_NAME` is unset. Production's deploy logs show two registered tenants (`tenant_reinsteins`, `tenant_client`);
whether the legacy database `reinsteins_workhub` still exists on the host cannot be told from the repository.

## Before approving the merge (read-only, run on the production host by an administrator)

```
cd /var/www/reinsteins-crm
node server/_migrate_add_must_change_password.js --dry-run
```

The dry run only runs `SELECT`s. For every database it prints what a real run would do (how many accounts would be
flagged) and fails -- exit code 1 -- on anything that would stop the deploy: a missing or unreachable database, bad
credentials, or a database user that does not own the `users` table. Expect: one line per database, `exit 0`.
To see what exists, read-only:

```
psql -l                      # add your usual host/user options
psql -d groworgs_platform_db -Atc "select id, company_slug, status, tenant_db_name from companies order by id"
```

## After the deploy

- The deploy log shows `[done] <database> -- columns added, N employee account(s) flagged` for each database
  (or `[skip]` on later runs).
- Sign in as a flagged test employee -> "Set Your New Password"; as an admin -> dashboard as before.

## Rollback and support

- **Reverting the deploy** removes the check. The columns stay and are harmless; passwords are never touched.
- **Pause enforcement without reverting**, per database (this clears everyone's pending state; it changes no password):
  `UPDATE users SET must_change_password = FALSE;`  To require it again for one person:
  `UPDATE users SET must_change_password = TRUE WHERE employee_id = '<id>';`
- There is **no administrator password-reset screen** in the CRM today. An employee who does not have their
  temporary password cannot sign in, and fixing that needs a developer or DBA (out of scope here).
- The forced-change endpoints share the sign-in rate limiter.
