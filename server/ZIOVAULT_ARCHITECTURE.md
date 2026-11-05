# ZioVault -- architecture, cryptographic design and threat model

Status: design for review. Written against `main` at `25cda18` (Smart Sheets and tenant feature management already merged).
Nothing in this document is implemented until its stage below says so.

## 0. What was inspected (facts this design relies on)

| Area | Finding in the repository | Consequence for ZioVault |
|---|---|---|
| Tenancy | One PostgreSQL database per tenant plus the legacy Reinsteins database; request context via `tenantProtect` -> `AsyncLocalStorage` (`config/db.js`); room scope helpers | ZioVault tables live **in each tenant database** (and the legacy one), like Smart Sheets. Tenant identity always comes from the verified token. |
| Identity | Tenant JWT (`TENANT_JWT_SECRET`, 8 h) carries `userId`, `companyId`, `companySlug`; `tenantProtect` re-reads the user row on **every request** and rejects `status != 'active'` or `employment_status != 'active'` | A deactivated user is locked out of every API immediately. Offboarding only has to clean up **keys and grants**. |
| Roles | `users.role` (admin/employee), `system_access` (super_admin ... employee), `employment_type` (employee/intern) | Admins get **no** implicit vault access. Vault permissions are their own tables. |
| Lifecycle | Status changes happen in six places in `employeeController.js` (`updateEmployeeStatus`, resign, terminate, completeInternship, discontinueInternship, convertInternToEmployee). Intern conversion creates a **new** user row | Offboarding is implemented as a **database trigger** on `users`, so no code path (or manual SQL) can skip it. A converted intern's new account starts with a new, empty vault. |
| Feature gate | `config/tenantFeatures.js` (catalog, API rules, socket prefixes, upload folders) + `middleware/featureGate.js` + a drift-guard test | Add feature id `ziovault` to **that** catalog. No second system. |
| Audit | Only the platform audit log and `employment_history` exist; there is **no tenant audit table** | ZioVault gets its own append-only audit table that can never hold secrets. |
| Notifications | `notificationService.createNotification`; periodic job `jobs/notificationSweep.js` | Rotation reminders reuse both. Notification text never contains an item title (the server does not know it). |
| Uploads | multer + signed `/uploads/...` links (`fat` token) | **Not used for ciphertext attachments.** Signed links are bearer URLs. Attachments are stored as `bytea` and streamed only through an authorised API call. |
| Rate limiting | `middleware/rateLimiters.js` (`createSensitiveLimiter`) | Unlock-material fetch, recovery, sharing get their own limiters. |
| Sockets | Every event goes through `onTenantEvent` and the feature gate | ZioVault defines **no socket events**. Secrets never travel over Socket.IO. |
| Frontend | React 19 + Vite, `routes/` guards, `TenantFeaturesProvider`, platform design tokens | New routes sit behind `FeatureGate feature="ziovault"`. The SPA is same-origin with the whole CRM (see threat F). |
| Environment | C: nearly full, no local Postgres; disposable PostgreSQL used for integration tests | Large installs go to D:; tests use the disposable server. |

## 1. Goals and non-goals

Goals: client-side encryption; the server stores and serves **ciphertext and key envelopes only**; per-user personal vaults; company
collections; per-item grants with separately enforced "see details" vs "see the secret"; server-enforced expiry/revocation; recovery that
no administrator can use; tenant isolation; offboarding.

Non-goals / honest limits (also in section 9): a web-delivered E2EE vault cannot defend against a server that serves malicious JavaScript;
it cannot erase what a recipient already saw or copied; "copy but not reveal" cannot be a cryptographic distinction (section 4.4).

## 2. Cryptographic design

### 2.1 Primitives (no custom constructions)

All cryptography runs in the browser through **libsodium** (`libsodium-wrappers-sumo`, ISC licence, pinned exactly). Node tests import the
*same* module, so tests exercise the shipping code.

| Purpose | Primitive |
|---|---|
| Password stretching | **Argon2id** (`crypto_pwhash`, ALG_ARGON2ID13), 16-byte random salt, default ops=3, mem=64 MiB; parameters stored in the envelope, server accepts only ops 2..10 and mem 32..256 MiB |
| Key separation | `crypto_kdf_derive_from_key` (BLAKE2b) with distinct 8-byte contexts |
| Symmetric encryption | **XChaCha20-Poly1305-IETF** AEAD, 32-byte keys, **24-byte random nonce per encryption** (large enough that random nonces are safe), associated data on every call |
| Public-key sharing | **X25519** key pairs; `crypto_box_easy` (X25519 + XSalsa20-Poly1305), i.e. **authenticated** public-key encryption: the recipient learns which sender key wrapped the secret |
| Attachments | `crypto_secretstream_xchacha20poly1305` in 64 KiB frames (detects truncation, reordering and tampering) |
| Randomness | `crypto_*` / `randombytes_buf` (OS CSPRNG via libsodium). `Math.random` is banned in `client/src/vault/` (a test greps for it) |
| Fingerprints | BLAKE2b-128 of the public key, shown as hex groups |
| Recovery secret | 256 random bits, shown as Base32 groups with a 4-character checksum |

No algorithm other than these is accepted. Every envelope carries a version byte; unknown versions are rejected, never "best effort".

### 2.2 Key hierarchy

```
master password --Argon2id(salt, ops, mem)--> masterKey (32 B)
masterKey --KDF ctx "ZVKEK001"--> KEK
vaultKey (32 B, random at setup) --AEAD under KEK--> vault-key envelope            [stored on server]
vaultKey --AEAD--> encrypted X25519 private key                                     [stored on server]
X25519 public key                                                                    [stored on server, plaintext]
recoverySecret (32 B, random, shown once) --KDF ctx "ZVREC001"--> recoveryKek
vaultKey --AEAD under recoveryKek--> recovery envelope                              [stored on server]

per item:    metaKey (32 B random), secretKey (32 B random)       -- two keys on purpose, see 4.4
             meta   = AEAD(metaKey,   title, url, username, folder, ... )
             secret = AEAD(secretKey, password, notes, api key, custom secret fields)
personal item: metaKey/secretKey wrapped with vaultKey (AEAD)
shared item:   metaKey/secretKey additionally wrapped per recipient with crypto_box (sender sk, recipient pk)
collection:    collection metaKey + secretKey, wrapped per member with crypto_box;
               item keys of collection items wrapped under the collection keys (AEAD)
attachment:    fileKey (32 B random) wrapped under the item's secretKey; content = secretstream(fileKey)
```

The server never receives: the master password, `masterKey`, `KEK`, `vaultKey`, any private key, any item/collection/file key in clear, or any
plaintext field. The server stores: salts and KDF parameters, ciphertext, nonces, public keys, and wrapped keys.

### 2.3 Authenticated data (AAD) -- ciphertext cannot be moved undetected

Every AEAD call binds a canonical associated-data string built by `buildAad(purpose, fields)`: a length-prefixed encoding (4-byte big-endian
length per field, UTF-8) of `"ziovault/v1"`, the purpose label, the **tenant id** (`companyId`, or `legacy`), and the object identifiers
(user id, item uid, collection uid, grantee id, key version ...). Consequences: a ciphertext copied to another item, user, tenant or purpose
fails authentication. `crypto_box` has no AAD parameter, so its plaintext **embeds** `version | purpose | uid | tenant | key` and the opener
verifies those fields after decryption.

Item and collection identities are **client-generated random UUIDs** (`uid`), because the AAD must exist before the row does. The server checks
format and uniqueness per tenant database.

### 2.4 Master password, unlock and change

Setup: the client generates `vaultKey`, the key pair and the recovery secret, derives `KEK`, builds the three envelopes and uploads them
(`POST /api/ziovault/account`). Unlock: the authenticated user downloads **their own** envelopes (rate limited, audited), derives `KEK`
locally, decrypts. A wrong password fails AEAD authentication locally; **the server never learns whether a guess was right**.
Change password: decrypt `vaultKey`, re-wrap under a new `KEK`/salt. Items are not re-encrypted.

Honest consequence: anyone who steals a CRM session token can download the envelopes and guess the master password **offline**. Argon2id parameters,
the rate limiter, the unlock audit trail and a strength requirement are the mitigations.

### 2.5 Recovery

Shown once at setup; the user must tick "I have stored it" (the UI cannot continue otherwise). Recovery = enter the recovery secret + choose a new
master password -> the client opens the recovery envelope, re-wraps `vaultKey` under the new password. The server stores the recovery **envelope**
only. **Lost master password and lost recovery secret = unrecoverable vault.** No administrator or Owner path exists: there is no server-side key,
no escrow, no reset endpoint that returns or replaces key material without the user's own key.

### 2.6 Company collections and "who can decrypt what"

A collection has its own random `metaKey`/`secretKey`. A member's access = an envelope of those keys wrapped to that member's public key by
a member who already holds them and has the *manage* right. **A collection manager must therefore also be a key holder**; that is the price of
not giving every administrator every password. Removing a member **rotates** the collection keys: a manager's client re-encrypts all item key
wrappers under new keys and re-wraps for the remaining members (a single versioned, atomic server call).

Operational warning (surfaced in the UI and offboarding): if the last key holder of a collection is deactivated, nobody can decrypt it. A
collection should have at least two managers. There is deliberately **no hidden administrator key**; an organisation that wants a break-glass
arrangement must add named administrators as explicit members.

### 2.7 Sharing, expiry, revocation

* Grants are rows (`recipient`, rights, `expires_at`, `granted_by`) plus key envelopes. The server returns an envelope only if the grant exists,
  `expires_at` is null or later than the **database clock**, the recipient is an active user and the feature is enabled -- on every request.
* Revocation deletes the grant and the envelopes (future access impossible), marks the item `rotation_required` and notifies the owner's client,
  which rotates the item keys and re-wraps for the remaining recipients on next unlock (`POST .../rotate`, versioned).
* An expiry sweeper deletes expired envelopes and writes `access_expired` audit events; correctness never depends on it because of the per-request check.
* Delegation: a grantor can give at most the rights they hold; re-sharing requires the explicit *share* right (enforced by the server **and**
  physically limited by holding the keys).
* Limits stated to users: a revoked or expired recipient may have seen, copied or cached the secret, and could keep an old ciphertext + key they
  saved. Rotation protects **future** versions only.

## 3. Permission model (server-enforced, with what is cryptographically real)

| Right | Meaning | Cryptographic reality |
|---|---|---|
| `view` | see title, URL, username (metadata) | Gets `metaKey` envelope only |
| `reveal` | see the secret | Gets `secretKey` envelope; server withholds secret ciphertext and key without it |
| `copy` | copy secret | **UI-level only**: copy needs the same key as reveal; a user with `reveal` can always read it. Recorded as "copy requested" |
| `edit` | change the item | Implies `reveal` (writing a new secret needs `secretKey`); server checks write rights and item version |
| `share` | grant others | Implies `view`; limited to own rights; must hold keys |

"View the username but not reveal the password" **is** enforced cryptographically (two keys). "Copy without reveal" is **not**; the product
says so instead of pretending.

## 4. Data model (per tenant database; migration pattern as Smart Sheets)

Sensitive columns hold ciphertext or wrapped keys only; there is no JSONB with plaintext, no search index over secrets.

| Table | Purpose |
|---|---|
| `zv_accounts` (user_id PK -> users) | `kdf_salt`, `kdf_ops`, `kdf_mem`, `vault_key_envelope`, `public_key`, `private_key_envelope`, `recovery_envelope`, `envelope_version`, timestamps, `recovery_confirmed_at` |
| `zv_folders` | per-user folders; `name_ciphertext` |
| `zv_items` | `uid`, `owner_user_id` (personal) or `collection_id` (company), `kind`, `meta_ciphertext`, `secret_ciphertext`, `key_version`, `version`, rotation fields (`rotation_interval_days`, `last_rotated_at`, `rotation_required`), `deleted_at`, folder, favourite |
| `zv_item_keys` | wrapped item keys: `item_id`, `holder` (owner vault key / recipient user / collection), `purpose` (meta/secret), `wrapped_key`, `sender_user_id` |
| `zv_collections` | `uid`, `name_ciphertext`, `kind` (department/project/general) |
| `zv_collection_members` | rights, `wrapped_meta_key`, `wrapped_secret_key`, `sender_user_id`, `key_version` |
| `zv_grants` | item grants: recipient, rights bitset, `expires_at`, `granted_by`, `created_at`, `revoked_at` |
| `zv_attachments` | `item_id`, `metadata_ciphertext`, `wrapped_file_key`, `content` (`bytea`, ciphertext), `size`, limits enforced |
| `zv_audit_events` | append-only; `kind`, `actor`, `subject_user`, `item_uid`, `collection_uid`, `detail` (fixed small allow-list, **no free text from the client**), `created_at` |

Foreign keys everywhere, `ON DELETE` rules chosen so that deleting a *user* never deletes another user's data. A trigger on `users` performs
offboarding (section 6). Revoking/expiring physically deletes envelopes; audit rows are never updated.

## 5. API and authorisation

All routes under `/api/ziovault`, behind `protect` (tenant JWT -> tenant context) and the feature gate (`ziovault`). Handlers go through **one**
authorisation service (`services/vaultAuthz.js`) that, per request, checks: authenticated active user (fresh row), tenant from the context (never
from input), vault/collection/item ownership or membership, grant rights, expiry against DB time, requested action. Controllers never return
decrypted data (they cannot: they have no keys). Errors are uniform: a resource the caller may not know about answers the same `404` as one that
does not exist.

Planned surface: `account` (create, fetch own envelopes, change password, recovery rewrap, public keys of colleagues with fingerprints),
`folders`, `items` (CRUD, soft delete/restore, rotate), `grants` (create/update/revoke), `collections` (+ members, rotate), `attachments`
(upload/list/download), `audit`, `reminders`, `access-events` (client-reported reveal/copy; stored as *reported*, see 7).
Rate limits: envelope fetch (unlock), recovery, grant creation, attachment upload.

## 6. Offboarding

A trigger on `users` (`status` or `employment_status` leaving 'active') in the same transaction: deletes the user's collection memberships and
their key envelopes, deletes grants **received** by them and grants **they made on their personal items**, writes `employee_deactivated`
audit rows, flags affected collections/items `rotation_required`. It keeps company-owned items and collections, and **never touches the
person's personal vault** (their envelopes remain, unreachable while inactive, intact if they are re-activated; memberships are not restored
automatically). Managers can list collections whose key holders are all gone. Nothing is transferred to administrators.
Sessions: already invalid via `tenantProtect`; the authorisation service re-checks status again.

## 7. Audit

Events: item created/edited/deleted/restored, shared, permission changed, revoked, expired, collection member added/removed, unlock,
recovery used, employee deactivated, attachment added/downloaded, and two **different** kinds of secret events:
`secret_delivered` -- **server-observed**: the secret ciphertext/key was returned to a user (proof the server released it, not that anyone read
it) -- and `reveal_reported` / `copy_reported` -- **client-reported**, unauthenticated by the server (a modified client can omit them). The UI
labels them accordingly. Audit rows never contain passwords, notes, keys or titles (the server does not have titles).

## 8. Threat model

Trust assumptions: the user's browser and device are trustworthy while the vault is unlocked; TLS protects transport; PostgreSQL contents may be
stolen; the Owner/platform operator and tenant administrators are **not** trusted with plaintext.

| # | Adversary / event | What they get | Mitigation | Residual risk |
|---|---|---|---|---|
| A | Database / backup thief | ciphertext, wrapped keys, public keys | everything sensitive is encrypted client-side; Argon2id on the only password-derived key | offline guessing of weak master passwords |
| B | Owner / platform operator with DB access | same as A | no server-held key; Owner cannot reset or read | same as A |
| C | Malicious tenant administrator | can list and delete rows, change roles, deactivate users | no key access; cannot decrypt; deletion/DoS possible | availability, not confidentiality; can add themselves **as a recipient only if a key holder wraps for them** |
| D | **Compromised or malicious application server / deployment pipeline** | can serve JavaScript that steals the master password | none cryptographic: this is the structural limit of browser E2EE. Mitigations: no third-party scripts, strict CSP on the SPA host, pinned dependencies, review of the deploy path | **accepted and documented**; native/extension clients would reduce it |
| E | Network attacker | nothing beyond TLS | TLS; no secrets in URLs | none beyond TLS |
| F | XSS anywhere in the CRM (vault is same-origin with the CRM) | read unlocked in-memory keys, DOM | keys live only in a module-private closure (never `window`/storage), minimal exposure window (auto-lock 5 min default, lock on tab hide option), no `dangerouslySetInnerHTML` with vault data, CSP | real risk while unlocked; auto-lock limits the window |
| G | Stolen CRM session (JWT) | own envelopes (offline guessing), API access to ciphertext the user may access | Argon2id, rate limiting, unlock audit, short JWT lifetime | weak master password |
| H | Revoked / expired recipient | may have copied or cached secrets | server stops serving envelopes; DEK rotation; honest wording | information already seen |
| I | Server substitutes a recipient's public key when you share | can read what you share | fingerprints shown and pinnable; `crypto_box` authenticates the **sender** to the recipient | trust-on-first-use unless users compare fingerprints |
| J | Server rolls an item back to an older valid ciphertext | old version shown | version in the row and AAD; client rejects a version lower than one already seen in the session | cross-session rollback is not detectable without signed history |
| K | Ciphertext moved between items/tenants/purposes | decryption failure | AAD binding + embedded fields in `crypto_box` payloads | none |
| L | Nonce reuse | catastrophic for streams ciphers | 192-bit random nonce per call; tests check uniqueness and use secretstream for files | negligible |
| M | Clipboard / shoulder-surfing / screenshots | the copied secret | clipboard auto-clear (best effort) with explicit wording, hide/reveal controls, auto-lock | cannot be guaranteed on every OS |
| N | Employee deactivated | their access | trigger + per-request status check + rotation flags | secrets they already saw |
| O | Last key holder leaves | collection undecryptable | warnings, >= 2 managers recommended, explicit named break-glass members | operational |
| P | Malicious/modified client | can omit audit reports, send junk | server validates sizes/versions/shape; reveal/copy reports flagged as client-reported | audit of reveals is advisory |
| Q | Cross-tenant access | none | per-tenant databases, tenant from verified token, feature gate, uid-per-database, tests with tenant-id substitution | none known |
| R | Password-health leak | breached-password lookup reveals interest | strength/reuse/age analysis is entirely local; the breached-password check is **opt-in**, sends only the first 5 hex characters of a SHA-1 (k-anonymity), with padding | HIBP learns that a lookup happened |

## 9. Honest limitations (shown to users and in the final report)

1. A compromised application server or deploy pipeline can defeat browser-delivered E2EE (threat D).
2. Revocation, expiry and offboarding cannot erase secrets already viewed, copied or cached.
3. "Copy without reveal" is a UI control, not a cryptographic one.
4. Lost master password **and** recovery secret = lost data. By design.
5. Public-key distribution is server-mediated; fingerprint verification is the user's defence.
6. Freshness/rollback across sessions is not cryptographically guaranteed.
7. Reveal/copy audit entries reported by the client are advisory.
8. XSS elsewhere in the CRM is a real exposure while the vault is unlocked.

## 10. Implementation stages (each ends with tests; stop and report if a security requirement cannot be met)

| Stage | Content | Exit criteria |
|---|---|---|
| 1 | Pinned libsodium; `client/src/vault/crypto/*` (AEAD, KDF, envelopes, key pairs, recovery secret, AAD, attachments stream, generator); known-answer tests, round trips, tamper tests, nonce uniqueness, no `Math.random` | crypto test suite green; independent re-verification of vectors against a second implementation (Node `crypto` for the AEAD/KDF building blocks where available) |
| 2 | Feature `ziovault` in the catalog; DDL + migration (+ tenant schema); `vaultAuthz`; account/unlock/recovery/change-password APIs; rate limits | real-PostgreSQL tests: isolation, ciphertext-only persistence, feature gate, recovery |
| 3 | Personal vault: folders, items, secure notes, API keys, soft delete/restore, favourites; UI (setup, recovery key, lock/unlock, list, detail, add/edit, generator, search) | server tests + rendered UI tests |
| 4 | Company vault: collections, membership, item grants with rights/expiry, revocation + rotation, fingerprints | permission matrix, expiry, revocation tests |
| 5 | Encrypted attachments; audit UI; password health; rotation reminders; offboarding trigger; docs and final report | offboarding, attachment, health, reminder tests |

## 11. Stage 2 -- as built

**What exists now:** feature id `ziovault` in the central catalog; the schema (10 tables, 4 functions, 3 triggers) in the tenant schema file and an idempotent migration for existing tenants and the legacy database; the authorisation service; the account / unlock / recovery / password-change / directory / item / collection / grant / audit APIs; rate limits; offboarding revocation; expiry sweep. **Not built yet:** the user interface, the password generator and health, attachment upload/download endpoints (the table and its limits exist), rotation reminders, the scheduled sweep job.

### Decisions taken during the build (and why)

1. **No server-side proof of the master password.** An "auth key" derived from the master password and sent to the server would let it refuse envelope downloads to a stolen session, but it would put a *derived key* on the server, which the requirements forbid. So the envelope is available to the user's own authenticated session and the protections are: Argon2id, a per-user rate limit, an audit record of every fetch -- and, because anyone with the session can also *overwrite* the envelope, `zv_account_history`: **every replaced vault-key envelope is kept**, and the owner can restore it (`POST /account/envelope-history/:id/restore`). A hijacker can lock the owner out for a moment; they cannot destroy the vault.
2. **Collection managers are key holders.** `createCollection` is limited to `users.role = 'admin'`; the creator is the first manager and holds both collection keys. Adding a member = the manager's browser wraps the keys to that member's public key. A collection cannot lose its last manager; there is no administrator key.
3. **Rotation is atomic and exact.** Rotating an item or a collection must name *exactly* the people who currently have access (and an item's current shares); a missing or extra person is refused with `RECIPIENTS_MISMATCH` / `MEMBERS_MISMATCH` / `ITEMS_MISMATCH`, so a rotation can neither silently drop a legitimate holder nor smuggle in a new one. The server cannot check that a wrapper really contains the right key; a holder finds out when decryption fails.
4. **One revocation implementation.** `zv_revoke_grants` and `zv_remove_collection_members` (PostgreSQL functions) are used by the API, the expiry sweep and the offboarding trigger, so a revocation always does the same things: mark revoked, delete the envelopes, flag the item/collection for rotation, write the audit record, and follow the delegation chain (what was shared *through* a revoked grant is revoked with it).
5. **Delegation is bounded.** A recipient with the *share* right can hand on at most what they hold, never *share* itself, never past their own expiry; only an owner or a manager creates further sharers.
6. **Offboarding is a database trigger** on `users` (`status` / `employment_status` leaving "active", NULL counting as active as the login code treats it), in the same transaction as the change. It removes the person's memberships and received shares (and what flowed from them, and what they shared out of their own vault), deletes their envelopes, flags rotation, and writes `employee_deactivated`. It never deletes an item or touches the person's own vault, never restores anything on reactivation, and **fails closed**: if it cannot finish, the deactivation itself fails. Cost of that choice: a defect in the trigger would block an HR deactivation until fixed (it is tested for every status value, rollback, concurrency and legacy bigint ids). Every deactivation path in `employeeController.js` (status change, resign, terminate, complete/discontinue internship, intern conversion) ends in an `UPDATE users` that the trigger sees.
7. **Hard-deleting a user** that owns vault data is blocked by the database (`ON DELETE RESTRICT`); deleting someone who only received shares cleans those up.
8. **The tenant provisioner's SQL splitter** was changed to understand dollar-quoted bodies (`utils/sqlStatements.js`); a test proves it returns exactly the old result for the schema as it was before ZioVault.
9. **Expiry** is evaluated by `now()` in the query that serves every request; the sweep only tidies (deletes the envelopes, audits `access_expired`). Nothing depends on a browser or a timer.

### API surface (all under `/api/ziovault`, behind the `ziovault` feature gate and `protect`)

`account` status / register / unlock / recovery / recovery-confirmation / envelope (replace) / recovery-envelope / envelope-history (+restore) -- `directory` -- `items` list / trash / create / read / `secret` (the only route that returns a secret ciphertext; records `secret_delivered`) / access-reports / update / delete / restore / rotate -- `items/:uid/grants` list / create / change / revoke -- `collections` list / create / read / items / members (add, change, remove) / rotate -- `audit`.
