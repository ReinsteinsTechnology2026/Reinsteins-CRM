> **Superseded for connecting email.** Employees now connect their OWN Gmail, Google Workspace, Outlook.com or Microsoft 365 account
> without any company domain, admin mailbox link or licensed tenant: see [EMAIL_ACCOUNTS.md](EMAIL_ACCOUNTS.md). Everything below describes the
> earlier **company-managed Microsoft 365 mailbox** flow. Its code, tables and routes (`/api/email/ms/*`) are unchanged and optional; the
> Email page no longer uses them.

# Company Email on Microsoft 365

Employees read and send company email **inside ZioVenture**, using their own Microsoft 365 mailbox, through Microsoft Graph with
OAuth 2.0 (authorization code + PKCE). Each ZioVenture company connects **its own** Microsoft 365 organisation.

This document is for whoever approves, configures and supports the feature. It says plainly what is built, what needs Microsoft
configuration, and what has **not** been verified against a live Microsoft 365 tenant.

## What it does and does not do

| It does | It does not |
|---|---|
| Sign an employee in to Microsoft on **Microsoft's own page** and keep a refresh token (encrypted) | Store, see or change any Microsoft **password** |
| Link an **existing** Microsoft 365 mailbox to an employee | **Create** a Microsoft mailbox, assign a licence, or change the customer's tenant |
| Read, search, compose, reply, forward, move, flag, delete, archive; folders; drafts; attachments; signature; automatic replies | Let an administrator read an employee's mail (no such call exists) |
| Keep every company's connection, tokens and mailbox rows separate | Change any domain's **MX / SPF / DKIM / DMARC** (the DNS screen asks for the ownership TXT record only) |
| Reuse the existing CRM temporary-password / forced-change flow for CRM login | Use a CRM password for the mailbox, or a Microsoft password for the CRM |

**Real mailbox provisioning is not implemented, deliberately.** Creating users and assigning licences in a customer's tenant needs
application-wide Graph permissions (`User.ReadWrite.All`, `LicenseAssignment.ReadWrite.All`) granted by that customer's Global
Administrator, plus a licence purchase. That is a separate, explicitly-approved project. Until then the admin links mailboxes that
already exist in Microsoft 365, and the CRM never pretends otherwise (a linked-but-not-yet-signed-in mailbox stays
`pending_infrastructure`; it becomes `provisioned` only after the employee has actually connected).

## Login and passwords (two separate credentials)

1. The administrator creates the employee in the CRM with a **temporary CRM password** (existing flow, `must_change_password`).
2. On first CRM sign-in the employee must choose their own CRM password (existing forced-change flow, unchanged).
3. In **Email**, the employee clicks *Connect with Microsoft* and signs in on Microsoft's page. Microsoft's own password rules,
   MFA and conditional access apply. ZioVenture receives tokens, never the password.
4. Changing a CRM password does not affect the mailbox, and a Microsoft password change at worst makes Microsoft ask the employee to
   sign in again (state **Reconnect**).

## One-time platform setup (needed before anything can connect)

This is done **once, by the ZioVenture platform owner**, in the Microsoft Entra admin center. Nothing below has been done by this
change; until it is, the feature stays off and every employee sees "Microsoft sign-in is not set up on this server".

1. *Entra ID → App registrations → New registration.* Name `ZioVenture Mail`. **Supported account types: Accounts in any
   organizational directory (multi-tenant).**
2. *Authentication → Add a platform → Web.* Redirect URI: `https://<crm host>/api/email/ms/callback` (exactly the value of
   `MS_EMAIL_REDIRECT_URI`). Leave implicit grants **off**.
3. *API permissions → Microsoft Graph → Delegated permissions* (no application permissions, nothing ending in `.All`):
   `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`,
   `People.Read`.
4. *Certificates & secrets → New client secret.* Copy it once.
5. Set the server settings (see `.env.example`): `MS_EMAIL_CLIENT_ID`, `MS_EMAIL_CLIENT_SECRET`, `MS_EMAIL_REDIRECT_URI`,
   `MS_EMAIL_FRONTEND_ORIGIN`, `MS_EMAIL_TOKEN_KEY` (32 random bytes, base64). Restart the service.
6. For production use across other organisations, complete **publisher verification** on the app registration; without it many
   organisations will block user consent.

## Per-company setup (company administrator)

*Settings → Business Email:*

1. Add and **verify the domain** (existing TXT ownership record). ZioVenture asks for nothing else in DNS.
2. *Microsoft 365 → Connect.* The company's Microsoft organisation is found from the verified domain (Microsoft publishes the
   domain → organisation mapping). The domain must also exist in that organisation.
3. *Create a mailbox record* for the employee (existing form) and **Link** it. Linking checks that the mailbox's domain belongs to
   the same Microsoft organisation.
4. Tell the employee to open **Email** and connect.
5. If the organisation blocks users from approving apps, a Microsoft 365 administrator opens the *organisation-wide consent* link
   shown on the page and accepts. Nothing is granted unless they accept.

Admins can **disable** a mailbox (stored tokens are deleted immediately), **unlink** it, **disconnect the company**, and read the
**audit log** (who connected / linked / disabled / sent, when; never content or tokens).

## Security model

* **Tenant isolation.** The company id comes from the verified session (`req.tenantCompany`), never from a request. No mail route
  accepts a user, mailbox or company id; the mailbox is always the caller's own. Every query is scoped by `company_id` in the SQL.
  Employee ids repeat across companies by design (each tenant has its own database), so every key is `(company_id, user_id)`.
* **OAuth.** PKCE (S256), a single-use 10-minute `state` consumed atomically, a `nonce`, the exact redirect URI, and a
  **tenant-specific** authority (the company's own organisation, never `common`). After the code exchange the id-token must prove
  the right organisation (`tid`), our app (`aud`), our nonce, and that the signed-in account **is the linked mailbox**. A personal
  account, another organisation or someone else's mailbox is refused and nothing is stored. (The id-token comes straight from the
  token endpoint over TLS, which OpenID Connect Core §3.1.3.7 accepts in place of a signature check.)
* **Tokens.** AES-256-GCM, a fresh IV each time, **bound to the row** (`ms-user:<company>:<user>`): a ciphertext copied into
  another company's or user's row cannot be decrypted. The key lives only in the environment; there is no default and no plaintext
  fallback. General readers never select token columns. A rejected refresh token wipes the stored tokens and the connection shows
  **Reconnect**. Refresh is single-flight per employee (Microsoft rotates refresh tokens).
* **Scopes.** Delegated only, the minimum for a mail client. See `config/microsoftEmailConfig.js`.
* **Mail content.** Incoming HTML is sanitized by an allow-list tokenizer (no script, event handlers, `javascript:`/`data:` links,
  iframes, forms, remote images or style abuse) **and** shown in an `<iframe sandbox>` without `allow-scripts` and with a CSP that
  allows no network loads. Remote pictures are never loaded (tracking pixels). Outgoing HTML is sanitized again on the server.
* **Attachments.** Blocked types (the list Outlook blocks, including double extensions), 25 MB per message, 15 files, names
  cleaned; downloads are forced to `attachment` with `nosniff` and a sandbox CSP; only png/jpeg/gif/webp/pdf may preview inline.
  Large files use a Graph upload session and the pre-authenticated upload URL never receives our bearer token.
* **Graph hygiene.** Retries 429/503/504 honouring `Retry-After`; absolute URLs (paging cursors) are accepted only for
  `https://graph.microsoft.com/v1.0/me/…` (no SSRF); Microsoft's error text is never forwarded to the browser.
* **Abuse.** Per-employee hourly send limit (`MS_EMAIL_SEND_PER_HOUR`, default 200); the connect/callback surface is rate limited.
* **Session safety.** Microsoft problems are answered with HTTP **409**, never 401, so a lapsed Microsoft sign-in cannot sign the
  employee out of the CRM (the client's 401 handler logs out).

## Data model (all additive; see `schemas/emailMicrosoftSchema.postgresql.sql`)

New tables in the **platform** database: `email_ms_company_connections`, `email_ms_oauth_states`, `email_ms_user_connections`,
`email_ms_user_settings`, `email_audit_log`. New columns: `mailboxes.provider`, `mailboxes.link_state`, `mailboxes.linked_at`,
`email_domains.mail_hosting`. Existing rows are untouched and get safe defaults. The migration
(`_migrate_add_microsoft_email.js`) is idempotent, supports `--dry-run`, and runs in the deploy after the earlier email-table
migration. The same SQL is included verbatim in `platformSchema.postgresql.sql` (a test guards against drift).

## API (all under `/api/email`, behind the existing `email` company feature gate)

`/ms/callback` (public redirect target) · `/ms/company*`, `/ms/mailboxes*`, `/ms/audit` (admin) · `/ms/me*` (own connection) ·
`/mail/folders`, `/mail/messages` (+ bulk, move, delete, restore, archive, conversations), `/mail/drafts`, `/mail/send`,
`/mail/messages/:id/attachments`, `/mail/categories`, `/mail/contacts`, `/mail/settings`.

## Known limits (by Microsoft, or by choice)

* Outlook has **no signature API**: the signature is stored in ZioVenture and inserted into new messages.
* "Favorites" are ZioVenture favourites (Outlook's own favourites have no Graph API).
* A **text search** uses Graph `$search`, which cannot be combined with `$filter` / `$orderby`: results are in relevance order and
  the unread / flagged / attachment filters are applied to the pages loaded (the screen says so).
* Embedded `cid:` images are not resolved; remote images are blocked on purpose.
* No push notifications (Graph change-notification webhooks need a public endpoint and renewal); the client refreshes folder counts
  every minute and when the window regains focus, and offers "Mailbox updated - click to refresh".
* No shared-mailbox or delegate access: an employee only ever reaches their own mailbox.
* The mailbox must have an Exchange Online licence; an unlicensed account is reported as "no Exchange Online mailbox".

## What has and has not been verified

Verified automatically (see the test files named below): encryption, OAuth state / PKCE / id-token checks, tenant discovery, the
HTML sanitizer against XSS vectors, validation, the Graph client (refresh, throttling, paging safety, error mapping), every mail
operation against a scripted Graph, the HTTP layer and route protection, and — on a real PostgreSQL — the schema, the migration,
company/mailbox isolation, the callback (replay, expiry, wrong organisation, wrong account, nonce), encrypted storage,
refresh / revocation and audit; plus the whole UI in a browser against a mocked API.

**Not verified: any live Microsoft 365 tenant.** No app registration, consent, licence or credential was available, so nothing has
been exercised against real Microsoft endpoints. Real behaviour of Exchange/Graph (for example query-shape quirks on a particular
mailbox, throttling limits, upload-session hosts) can only be confirmed with the live checklist below.

### Live verification checklist (needs the platform setup above and one licensed test mailbox)

1. Connect the company from a verified domain → status **Connected**, tenant id shown.
2. Link a mailbox; sign in as that employee → **Connected**, mailbox `provisioned`.
3. Sign in as a *different* Microsoft account → refused ("different account"); as another organisation → refused.
4. Inbox loads with unread counts; open, reply, reply all, forward, send; message appears in Sent Items.
5. Draft with a 1 MB and a 10 MB attachment (upload session) → sent and received intact.
6. Search by sender / subject / keyword / date; unread, flagged, attachment filters; sort; load more.
7. Delete → Deleted Items → Restore; Archive; Move; create / rename / delete a folder; bulk actions.
8. Out-of-office on/off and scheduled; signature on a new message.
9. Revoke the app at <https://myapps.microsoft.com> → next action shows **Reconnect**, CRM session intact.
10. Disable the mailbox as admin → employee loses access at once; audit log shows each step.

## Tests

| File | What it covers | Needs |
|---|---|---|
| `_test_ms_email_security.js` | encryption, OAuth, id-token, discovery, sanitizer (XSS vectors), validation | nothing |
| `_test_ms_email_graph.js` | Graph client + every mail operation against a scripted Graph | nothing |
| `_test_ms_email_routes.js` | route protection, error mapping, callback redirects, attachment HTTP | nothing |
| `_test_ms_email_pg.js` (`_ms_email_pg_cases.js`) | schema, migration, isolation, OAuth callback, tokens, audit on real PostgreSQL | disposable PostgreSQL (`PG_TEST_*`), runs in the `migration-postgres` CI job |

## Rollout

1. Merge → deploy runs `_migrate_add_microsoft_email.js` (additive; safe with the feature unconfigured).
2. With no `MS_EMAIL_*` settings the feature is inert; nothing calls Microsoft.
3. Do the platform setup, set the settings, restart, then work through the live checklist with one test company before announcing.
4. Rolling back the code is safe: the new tables and columns are ignored by older code.
