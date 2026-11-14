# Unified email: connect your own Gmail, Outlook or Microsoft 365 account

Every employee connects their **own, existing** email accounts inside ZioVenture: Gmail, Google Workspace, Outlook.com / Hotmail
(personal Microsoft), or Microsoft 365 (work or school). They get one Outlook-style client with several accounts, an account
switcher and a unified inbox.

ZioVenture **does not host, create, sell or license any mailbox** and needs **no verified company domain and no company-managed
Microsoft 365 tenant**. Mail stays at Google / Microsoft the whole time; the original Gmail and Outlook apps keep working and
notifying exactly as before.

This document is for whoever approves, configures and supports the feature. It says plainly what is built, what needs account-owner
setup at Google and Microsoft, and what has **not** been verified against real accounts.

## What it does

| | |
|---|---|
| **Accounts** | Gmail, Google Workspace, Outlook.com / Hotmail, Microsoft 365. Up to 5 per employee; add, reconnect, rename, disconnect |
| **Mail** | Inbox, Sent, Drafts, Junk/Spam, Trash, Archive, Starred (Gmail), your own folders (Outlook) or labels (Gmail); read, compose (rich text), reply, reply all, forward, delete/restore/archive/move, flag or star, categories or labels, bulk actions, search with filters, attachments, drafts with autosave, signatures, automatic replies (out of office), contact suggestions where the provider allows |
| **Unified inbox** | The Inbox of every connected account merged newest-first, paged by time, one failing account never hides the others |
| **Notifications** | Unread badge next to *Email* in the portal, toast with sender and subject, "N new messages" banner, Reconnect prompts. Gmail push + Microsoft Graph change notifications where configured, safe polling otherwise; each message is announced once |
| **Admin** | Connection **status** only (who, which kind, healthy or not, last checked; addresses masked), disconnect, audit log. **No admin call can read anyone's mail** |

CRM login is unchanged: the temporary password / `must_change_password` flow is separate from provider sign-in, and neither credential
is ever used for the other.

## How sign-in works (and what is stored)

1. The employee clicks *Connect with Google* or *Connect with Microsoft*. The browser goes to **Google's / Microsoft's own page**;
   the employee signs in and chooses what to allow. ZioVenture never sees a password.
2. The provider redirects back with a one-time code. The server checks a **single-use 10-minute state** (CSRF), exchanges the code
   with **PKCE**, and validates the identity token (our app, our nonce, expiry; Google also a *verified* email; Microsoft the tenant /
   account). It also checks that the permissions Google or Microsoft **actually granted** include the mail permission (users can untick
   permissions on Google's consent screen).
3. Only OAuth tokens are stored, **AES-256-GCM encrypted and bound to (company, employee, provider, provider account)**: a ciphertext
   copied to another row cannot be decrypted. No mail content is stored. A refresh token the provider rejects is wiped and the
   account shows *Reconnect*; disconnecting deletes the row (tokens included), stops push, and revokes the grant at Google.

## One-time setup (account owners; none of this has been done by this change)

Until the settings exist the feature is inert: each provider shows "not set up on this server" and nothing calls Google or Microsoft.

### Google (Gmail, Google Workspace)

1. In **Google Cloud Console** create (or choose) a project; enable the **Gmail API**.
2. **OAuth consent screen**: user type *External*, app name, support email, and the scopes
   `.../auth/gmail.modify` and `.../auth/gmail.settings.basic` (plus `openid email profile`).
3. **Credentials -> OAuth client ID -> Web application**. Authorised redirect URI:
   `https://<crm host>/api/email/accounts/callback/google` (exact). Copy the client id and secret.
4. **Important - restricted scopes.** Google classes Gmail scopes as *restricted*. In **Testing** mode only users you add as *test users*
   (up to 100) can connect, and Google shows an "unverified app" warning. Using it for general employees or other companies needs
   **Google's app verification and an annual third-party security assessment** (CASA). That is a Google process owned by the account
   owner; it can take weeks and has a cost. Plan for it before announcing the feature.
5. Optional **push notifications**: create a Pub/Sub topic, grant `gmail-api-push@system.gserviceaccount.com` the *Pub/Sub Publisher*
   role on it, create a **push subscription** to `https://<crm host>/api/email/push/google` with an OIDC token (audience = that URL,
   service account = yours), and set the three `GOOGLE_EMAIL_PUBSUB_*` / `PUSH_*` settings. Without it the sync polls.

### Microsoft (Outlook.com, Hotmail, Microsoft 365)

1. One **Entra app registration**, *Supported account types:* **"Accounts in any organizational directory and personal Microsoft
   accounts"** (this is different from the earlier work-only setting). Under *Manifest* set `requestedAccessTokenVersion` to `2`.
2. *Authentication -> Web* redirect URI `https://<crm host>/api/email/accounts/callback/microsoft` (exact).
3. *API permissions -> Microsoft Graph -> **Delegated***: `openid profile email offline_access User.Read Mail.ReadWrite Mail.Send
   MailboxSettings.ReadWrite People.Read`. No application permissions, nothing ending in `.All`.
4. A client secret; set the server settings below. For Microsoft 365 work accounts, an organisation that blocks user consent needs its
   administrator to approve ZioVenture once (a Microsoft process; nothing is granted unless they accept). Complete **publisher
   verification** before offering it to other organisations.
5. Optional **change notifications**: set `MS_EMAIL_NOTIFICATION_URL=https://<crm host>/api/email/push/microsoft` (public https). Without it the sync polls.

### Server settings (names only; values go in `server/.env`, never in the repository)

`EMAIL_TOKEN_KEY` (32 random bytes, base64), `EMAIL_FRONTEND_ORIGIN`, `GOOGLE_EMAIL_CLIENT_ID`, `GOOGLE_EMAIL_CLIENT_SECRET`,
`GOOGLE_EMAIL_REDIRECT_URI`, `MS_EMAIL_CLIENT_ID`, `MS_EMAIL_CLIENT_SECRET`, `MS_EMAIL_ACCOUNT_REDIRECT_URI`; optional
`GOOGLE_EMAIL_PUBSUB_TOPIC`, `GOOGLE_EMAIL_PUSH_AUDIENCE`, `GOOGLE_EMAIL_PUSH_SERVICE_ACCOUNT`, `MS_EMAIL_NOTIFICATION_URL`,
`EMAIL_SYNC_DISABLED=1` (turn the background sync off), `EMAIL_READS_PER_MINUTE`, `MS_EMAIL_SEND_PER_HOUR`.
`MS_EMAIL_TOKEN_KEY` / `MS_EMAIL_FRONTEND_ORIGIN` still work as fallbacks for the two shared settings.

## Security model

* **Employees reach only their own accounts.** The employee comes from the verified session; an account id in a URL is only a lookup
  key *inside* that employee's accounts (a colleague's or another company's id answers "not found"). There is no user or company id in
  any mail route. Employee ids repeat across companies by design (each tenant has its own users), so every key is `(company, employee)`.
* **Administrators cannot read mail.** The admin routes return connection status (provider, kind, masked address, state, last checked)
  and can disconnect an account or read the audit log; no admin route lists, searches, counts or opens messages, and the mail routes
  accept only the caller's own accounts whatever their role.
* **Minimum permissions.** Gmail: `gmail.modify` + `gmail.settings.basic` (not the full `mail.google.com` scope, which would also allow
  permanent deletion); no contacts, calendar or Drive. Microsoft: the delegated set above. Both are checked in tests.
* **Messages.** Incoming HTML is sanitized by an allow-list tokenizer and shown in a script-less sandboxed iframe with a no-network CSP;
  remote images are never loaded; outgoing HTML is sanitized again; Gmail MIME is built with every header value stripped of line breaks.
* **Attachments.** Outlook's blocked types (including double extensions), 25 MB total, 15 files, names cleaned; downloads are forced to
  `attachment` with `nosniff`; only small png/jpeg/gif/webp/pdf may preview inline.
* **Provider calls.** Only `/gmail/v1/users/me/...` and Graph `/me/...` are reachable (path traversal, encoded dots/slashes, other
  hosts and absolute URLs are refused); 429/503 and quota errors are retried honouring `Retry-After`; provider error text is never
  forwarded to the browser. Reads are limited per employee (240/min), sends per employee (200/hour), connect / callback per IP.
* **Push endpoints are authenticated.** Gmail: the Pub/Sub OIDC token is verified against Google's published keys (signature, issuer,
  audience = our endpoint, identity = the configured service account). Microsoft: the `clientState` chosen when WE created the subscription
  (stored only as a hash) must match; the validation handshake is echoed as safe plain text. Anything else is dropped.
* **Duplicate-safe.** Each (account, message) is announced once (database unique key); accounts are claimed with
  `FOR UPDATE SKIP LOCKED` plus a lease, so overlapping cycles and several server processes never sync one account twice.

## Provider differences (shown in the UI, not hidden)

| | Gmail / Google Workspace | Outlook.com / Microsoft 365 |
|---|---|---|
| Folders | Labels (Archive = not in inbox/sent/drafts/trash/spam) | Folders |
| Flag | Star | Flag (also *complete*) |
| Categories | Labels | Categories (not for every personal account) |
| Delete forever | **Not possible** with the minimum scope; Trash empties after 30 days | Yes, from Deleted Items |
| Sort oldest first | Not supported by Gmail | Yes (not with a text search) |
| Contact suggestions | Not requested (would need a contacts scope) | Yes for work accounts; personal accounts may have none |
| Out of office | One message; audience = everyone / contacts / my domain | Separate inside / outside messages |
| Search | Gmail's own syntax: every filter applied by Google | Text search cannot be combined with filters in Graph: filters apply to the loaded results (the screen says so) |
| Push | Gmail watch via Pub/Sub (renew within 7 days) | Graph subscription (renew within ~3 days) |

## Data model (all additive; `schemas/emailAccountsSchema.postgresql.sql`)

New platform tables: `email_accounts`, `email_account_oauth_states`, `email_push_subscriptions`, `email_new_mail_events`. Nothing
existing is altered. The earlier company-managed Microsoft mailbox tables and routes (`/api/email/ms/*`, `mailboxes`) are **untouched
and optional**: employees no longer need them to connect. The migration (`_migrate_add_email_accounts.js`) is idempotent, supports
`--dry-run`, and runs in the deploy.

## API (under `/api/email`, behind the existing `email` company feature gate)

`/accounts` (list, summary, connect, patch, delete) - `/accounts/callback/google|microsoft` (public redirects) -
`/accounts/:id/mail/...` (folders, messages, bulk, move/delete/restore/archive, conversations, drafts, send, reply-draft, attachment
download, categories, contacts, auto-reply) - `/unified/messages` - `/mailbox/settings` (signature, favourites) -
`/accounts/admin/overview|audit|:id` (admin, status only) - `/push/google`, `/push/microsoft` (public, self-authenticated).

## What has and has not been verified

Verified automatically (see the test files): Gmail MIME / parsing / every provider operation against a scripted Gmail API; Microsoft
operations; Google and Microsoft OAuth including personal vs work accounts and untrusted tokens; Pub/Sub JWT verification; and, on a real
PostgreSQL engine, the schema and migration, multi-account use, tenant and employee isolation, the callback checks (replay, expiry,
wrong provider, wrong account, nonce, unticked permission), encrypted storage, refresh and revocation, synchronisation with duplicate-safe
notifications, backoff, push (both providers), subscription renewal and the unified inbox; plus the whole UI in a browser against a mocked API.

**Not verified: any live Google or Microsoft account.** No Google Cloud project, OAuth client, consent, or Microsoft app change was
made or available, so nothing has been exercised against real Google or Microsoft endpoints. Behaviour that only real accounts show
(Gmail query quirks, quota limits, whether a given personal Microsoft account supports categories or contact suggestions, push
delivery, an organisation's consent policy) can only be confirmed with the live checklist below.

### Live verification checklist (needs the setup above and one test account of each kind)

1. Gmail: connect (test user) -> *Connected*; Inbox, Starred, Sent, Drafts, Spam, Trash, labels load with unread counts.
2. Outlook.com / Hotmail personal account: connect; folders, send and receive between your own accounts.
3. Microsoft 365 work account (consent as that user; if blocked, the administrator approves once).
4. Unified inbox with all three: order, account chips, paging, one account failing (revoke it) does not hide the others.
5. Send / reply / reply all / forward with an attachment (1 MB and ~10 MB) from each provider; the message arrives intact and appears in Sent.
6. Search and filters (unread, flagged/starred, attachments, dates); star/flag; labels/categories; archive; trash/restore; bulk; create/rename/delete a label or folder.
7. Notifications: send yourself mail from another account: badge and toast appear within a poll interval (seconds with push); the Gmail/Outlook app still notifies you.
8. Revoke the app in Google / Microsoft account settings -> *Reconnect* appears; the CRM session stays signed in. Reconnect with the SAME account works, a different account is refused.
9. Disconnect: the row and tokens are gone; Google reports the grant revoked; mail untouched.
10. As admin: only status is visible; disconnect works; no mail anywhere.

## Rollout

1. Merge -> the deploy runs `_migrate_add_email_accounts.js` (additive; safe with the feature unconfigured).
2. With no settings the feature is inert. Do the Google / Microsoft setup, set the server settings, restart, run the live checklist with test accounts.
3. Only then announce it. For Gmail beyond the test-user limit, complete Google's verification first.
4. Rolling back the code is safe: the new tables are ignored by older code.
