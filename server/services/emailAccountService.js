const secretBox = require("../utils/secretBox");
const oauthMs = require("./microsoftOAuthService");
const oauthGoogle = require("./googleOAuthService");
const { OAuthError } = oauthMs;
const { createGraphClient, GraphError } = require("./graphClient");
const { createGmailClient } = require("./mail/gmailClient");
const { getProvider } = require("./mail/providers");
const { getProviderConfig, publicProviderStatus } = require("../config/emailProvidersConfig");
const { sanitizeEmailHtml } = require("../utils/emailHtmlSanitizer");
const { assertGraphId, clampInt } = require("../utils/emailValidation");
const { safeEmit } = require("./emailEvents");

// ==========================================
// EMAIL ACCOUNT SERVICE -- connecting, using and removing an employee's OWN email accounts (Gmail, Google Workspace,
// Outlook.com / Hotmail, Microsoft 365).
//
// What this is NOT: no mailbox is created, hosted or licensed, no company domain is needed, and an administrator has no way to read
// an employee's mail (no function here lets one person act on another person's account: every call takes the employee's id from the
// verified session and every query is scoped by it).
//
// Sign-in happens on the PROVIDER's own page (Google / Microsoft). Only OAuth tokens are kept, encrypted and bound to
// (company, employee, provider, provider account); no password is ever seen. The mail itself stays at the provider.
// ==========================================

class EmailAccountError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "EmailAccountError";
        this.code = code;
        this.status = status;
    }
}

const STATE_TTL_SECONDS = 600;
const MAX_ACCOUNTS_PER_USER = 5;
const UNIFIED_MAX_PAGE = 50;
const COLORS = ["#16A66A", "#B7791F", "#7C3AED", "#B42318", "#0F766E", "#9A6700"];

const tokenAad = (companyId, userId, provider, providerAccountId) => `email-account:${companyId}:${userId}:${provider}:${providerAccountId}`;
const stateAad = (companyId, userId) => `email-state:${companyId}:${userId}`;
const shortReason = (error) => String((error && error.code) || (error && error.message) || "error").slice(0, 120);

const PROVIDER_LABEL = { google: "Google", microsoft: "Microsoft" };
const KIND_LABEL = { gmail: "Gmail", google_workspace: "Google Workspace", outlook_personal: "Outlook.com", microsoft_365: "Microsoft 365" };

// Address shown to an ADMINISTRATOR: enough to recognise the connection, not enough to expose a personal address.
function maskAddress(address) {
    const [local, domain] = String(address || "").split("@");
    if (!domain) return "***";
    return `${local.slice(0, 1)}***@${domain}`;
}

function createEmailAccountService(overrides = {}) {
    const store = overrides.store || require("./emailAccountStore").createEmailAccountStore();
    const configFor = overrides.configFor || ((provider) => getProviderConfig(provider));
    const fetchImpl = overrides.fetchImpl || fetch;
    const sleep = overrides.sleep;
    const now = overrides.now || (() => Date.now());
    const lookupCompany = overrides.getCompanyById || ((id) => require("./platformCompanyService").getCompanyById(id));
    const emit = overrides.emit || safeEmit;
    const refreshLocks = new Map();

    const audit = (entry) => store.writeAudit(entry).catch((error) => console.error("[email-audit] write failed:", error.message));

    function providerConfig(provider) {
        if (provider !== "google" && provider !== "microsoft") throw new EmailAccountError("INVALID_PROVIDER", "Choose Google or Microsoft.", 400);
        const config = configFor(provider);
        if (!config.configured) {
            throw new EmailAccountError("PROVIDER_NOT_CONFIGURED", `${PROVIDER_LABEL[provider]} sign-in is not set up on this server yet. A platform administrator must register the ZioVenture app with ${PROVIDER_LABEL[provider]} first.`, 503);
        }
        return config;
    }

    // ---------- views ----------
    function publicAccount(row) {
        const provider = getProvider(row.provider);
        return {
            id: row.id,
            provider: row.provider,
            kind: row.account_kind,
            kindLabel: KIND_LABEL[row.account_kind],
            address: row.email_address,
            displayName: row.display_name || "",
            color: row.color || COLORS[(row.id - 1) % COLORS.length],
            status: row.status,
            lastError: row.last_error || null,
            lastSyncAt: row.last_sync_at || null,
            syncError: row.sync_error || null,
            unread: row.unread_inbox || 0,
            connectedAt: row.connected_at,
            capabilities: provider.capabilities,
        };
    }

    async function listAccounts({ companyId, userId }) {
        const rows = await store.list(companyId, userId);
        return rows.map(publicAccount);
    }

    function providersStatus() {
        return publicProviderStatus();
    }

    // ---------- connecting ----------
    async function beginConnect({ companyId, userId, provider, accountId, returnPortal }) {
        const config = providerConfig(provider);
        let loginHint;
        if (accountId) {
            const existing = await store.get(companyId, userId, Number(accountId));
            if (!existing || existing.provider !== provider) throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
            loginHint = existing.email_address;
        } else if ((await store.count(companyId, userId)) >= MAX_ACCOUNTS_PER_USER) {
            throw new EmailAccountError("ACCOUNT_LIMIT", `You can connect up to ${MAX_ACCOUNTS_PER_USER} email accounts. Disconnect one to add another.`, 409);
        }

        const state = oauthMs.randomToken(32);
        const nonce = oauthMs.randomToken(24);
        const pkce = oauthMs.generatePkce();
        await store.createState({
            companyId,
            userId,
            provider,
            accountId: accountId ? Number(accountId) : null,
            stateHash: secretBox.sha256Hex(state),
            nonceHash: secretBox.sha256Hex(nonce),
            verifierEnc: secretBox.encrypt(pkce.verifier, stateAad(companyId, userId), config.tokenKey),
            returnPortal,
            ttlSeconds: STATE_TTL_SECONDS,
        });
        await audit({ companyId, actorUserId: userId, action: accountId ? "account_reconnect_started" : "account_connect_started", targetType: "account", detail: { provider } });
        const params = { config, state, nonce, challenge: pkce.challenge, loginHint };
        return { authorizationUrl: provider === "google" ? oauthGoogle.buildAuthorizeUrl(params) : oauthMs.buildAccountAuthorizeUrl(params) };
    }

    // The provider's redirect. Returns where to send the browser and what happened; never throws for an expected failure, never
    // echoes the provider's own error text.
    async function completeCallback({ provider, code, state, error: providerError }) {
        const fail = (reason, base = {}) => ({ ok: false, reason, ...base });
        if (provider !== "google" && provider !== "microsoft") return fail("invalid_state");
        const config = configFor(provider);
        if (!config.configured) return fail("not_configured");
        if (typeof state !== "string" || state.length < 20 || state.length > 200) return fail("invalid_state");

        // Consuming FIRST means a state is dead after one use even when the exchange below fails.
        const saved = await store.consumeState(secretBox.sha256Hex(state));
        if (!saved || saved.provider !== provider) return fail("invalid_state");
        const { company_id: companyId, tenant_user_id: userId } = saved;
        const base = { companyId, userId, returnPortal: saved.return_portal };

        if (providerError) {
            const needsAdmin = ["consent_required", "interaction_required", "admin_policy_enforced", "invalid_scope"].includes(String(providerError));
            await audit({ companyId, actorUserId: userId, action: "account_connect_denied", targetType: "account", detail: { provider } });
            return fail(needsAdmin ? "admin_consent_required" : "denied", base);
        }
        if (typeof code !== "string" || code.length < 10 || code.length > 4096) return fail("invalid_code", base);

        try {
            const verifier = secretBox.decrypt(saved.code_verifier_enc, stateAad(companyId, userId), config.tokenKey);
            const tokens = provider === "google"
                ? await oauthGoogle.exchangeCode({ config, code, verifier, fetchImpl })
                : await oauthMs.exchangeAccountCode({ config, code, verifier, fetchImpl });

            // Google (and some Microsoft tenants) let the user untick permissions: without the required ones the client cannot work.
            const grantedOk = provider === "google"
                ? oauthGoogle.grantedScopesOk(tokens.scope, config.requiredScopes)
                : config.requiredScopes.every((s) => String(tokens.scope || "").toLowerCase().split(/\s+/).some((g) => g === s.toLowerCase() || g.endsWith(`/${s.toLowerCase()}`)));
            if (!grantedOk) {
                await audit({ companyId, actorUserId: userId, action: "account_connect_insufficient_scopes", targetType: "account", detail: { provider } });
                return fail("insufficient_scopes", base);
            }
            if (!tokens.refreshToken) return fail("no_refresh_token", base);

            const claims = provider === "google"
                ? oauthGoogle.decodeJwtPayload(tokens.idToken)
                : oauthMs.decodeJwtPayload(tokens.idToken);
            const identity = provider === "google"
                ? oauthGoogle.validateIdTokenClaims(claims, { config, expectedNonceHash: saved.nonce_hash, now: now(), sha256Hex: secretBox.sha256Hex })
                : oauthMs.validateAccountIdToken(claims, { config, expectedNonceHash: saved.nonce_hash, now: now(), sha256Hex: secretBox.sha256Hex });
            const providerAccountId = identity.subject;
            const providerTenantId = provider === "google" ? identity.hostedDomain : identity.tid;

            if (saved.account_id) {
                // A reconnect must be the SAME account: it cannot be used to swap in a different mailbox under an old id.
                const existing = await store.get(companyId, userId, saved.account_id);
                const row = existing && (await store.getWithTokens(companyId, userId, saved.account_id));
                if (!existing || existing.provider !== provider || row.provider_account_id !== providerAccountId) {
                    await audit({ companyId, actorUserId: userId, action: "account_connect_wrong_account", targetType: "account", targetId: saved.account_id, detail: { provider } });
                    return fail("wrong_account", base);
                }
            } else if ((await store.count(companyId, userId)) >= MAX_ACCOUNTS_PER_USER) {
                // At the limit only an account ALREADY on file (same provider account) may complete: that is an update, not a new slot.
                const known = await store.findByIdentity(companyId, userId, provider, providerAccountId);
                if (!known) return fail("account_limit", base);
            }

            const aad = tokenAad(companyId, userId, provider, providerAccountId);
            const account = await store.upsert({
                companyId, userId, provider,
                kind: identity.kind,
                email: identity.email,
                displayName: identity.name,
                providerAccountId, providerTenantId,
                scopes: tokens.scope,
                accessTokenEnc: secretBox.encrypt(tokens.accessToken, aad, config.tokenKey),
                refreshTokenEnc: secretBox.encrypt(tokens.refreshToken, aad, config.tokenKey),
                expiresInSeconds: tokens.expiresIn,
            });

            // Start tracking NOW (old mail must not notify) and register push if available. Neither may fail the connection.
            let note = null;
            try {
                const ctx = await getContextForRow(await store.getWithTokensById(account.id));
                const cursor = await getProvider(provider).initCursor(ctx.ctx);
                const unread = await getProvider(provider).getUnread(ctx.ctx);
                await store.syncSucceeded(account.id, { cursor, unread, nextInSeconds: 120 });
            } catch (initError) {
                note = shortReason(initError);
                await store.syncFailed(account.id, note, 60);
            }
            await audit({ companyId, actorUserId: userId, action: "account_connected", targetType: "account", targetId: account.id, detail: { provider, kind: identity.kind } });
            emit("accounts", { companyId, userId });
            return { ok: true, accountId: account.id, ...base, note };
        } catch (error) {
            const reason = error instanceof OAuthError ? error.code : "error";
            if (!(error instanceof OAuthError)) console.error("[email] account OAuth callback failed:", error.code || error.name);
            await audit({ companyId, actorUserId: userId, action: "account_connect_failed", targetType: "account", detail: { provider, reason } });
            return fail(reason === "REAUTH_REQUIRED" ? "denied" : reason === "ID_TOKEN_INVALID" || reason === "EMAIL_NOT_VERIFIED" || reason === "EMAIL_NOT_AVAILABLE" ? "identity_failed" : "failed", base);
        }
    }

    async function frontendRedirect({ companyId, returnPortal, result }) {
        const config = configFor("google");
        const origin = config.frontendOrigin || configFor("microsoft").frontendOrigin;
        const company = await lookupCompany(companyId);
        const portal = returnPortal === "admin" ? "admin" : "employee";
        const target = new URL(`${origin}/${encodeURIComponent((company && company.company_slug) || "")}/${portal}/email`);
        target.searchParams.set("ea", result.ok ? "connected" : "error");
        if (!result.ok) target.searchParams.set("reason", result.reason);
        return target.toString();
    }

    // ---------- tokens and mail context ----------
    async function refreshNow(row) {
        const config = configFor(row.provider);
        if (!config.configured) throw new EmailAccountError("PROVIDER_NOT_CONFIGURED", "This provider is not set up on this server.", 503);
        const aad = tokenAad(row.company_id, row.tenant_user_id, row.provider, row.provider_account_id);
        let refreshToken;
        try {
            if (!row.refresh_token_enc) throw new Error("no token");
            refreshToken = secretBox.decrypt(row.refresh_token_enc, aad, config.tokenKey);
        } catch (_error) {
            await store.markReauth(row.id, "TOKEN_UNREADABLE");
            throw new EmailAccountError("REAUTH_REQUIRED", "Reconnect this account.", 409);
        }
        try {
            const tokens = row.provider === "google"
                ? await oauthGoogle.refreshTokens({ config, refreshToken, fetchImpl })
                : await oauthMs.refreshAccountTokens({ config, tenantId: row.provider_tenant_id, refreshToken, fetchImpl });
            await store.updateTokens(row.id, {
                accessTokenEnc: secretBox.encrypt(tokens.accessToken, aad, config.tokenKey),
                // Providers may rotate the refresh token: keep the new one, or the old one if none was returned.
                refreshTokenEnc: tokens.refreshToken ? secretBox.encrypt(tokens.refreshToken, aad, config.tokenKey) : null,
                expiresInSeconds: tokens.expiresIn,
            });
            return tokens.accessToken;
        } catch (error) {
            if (error instanceof OAuthError && error.code === "REAUTH_REQUIRED") {
                await store.markReauth(row.id, "REFRESH_REJECTED");
                await audit({ companyId: row.company_id, actorUserId: row.tenant_user_id, action: "account_reauth_required", targetType: "account", targetId: row.id, detail: { provider: row.provider } });
                emit("reauth", { companyId: row.company_id, userId: row.tenant_user_id, accountId: row.id, provider: row.provider });
                throw new EmailAccountError("REAUTH_REQUIRED", `Your ${PROVIDER_LABEL[row.provider]} sign-in expired or was revoked. Reconnect to continue.`, 409);
            }
            throw error instanceof OAuthError ? new EmailAccountError(error.code, error.message, error.status) : error;
        }
    }

    // One refresh at a time per account in this process: parallel requests with an expired token must not both spend the refresh token.
    function singleFlight(row) {
        if (!refreshLocks.has(row.id)) {
            refreshLocks.set(row.id, refreshNow(row).finally(() => refreshLocks.delete(row.id)));
        }
        return refreshLocks.get(row.id);
    }

    // Builds the API client for a row that was loaded WITH tokens. Used by the employee path and by the background sync.
    async function getContextForRow(row) {
        if (!row) throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
        const config = configFor(row.provider);
        if (!config.configured) throw new EmailAccountError("PROVIDER_NOT_CONFIGURED", "This provider is not set up on this server.", 503);
        if (row.status !== "connected") throw new EmailAccountError("REAUTH_REQUIRED", `Reconnect your ${PROVIDER_LABEL[row.provider]} account.`, 409);
        const aad = tokenAad(row.company_id, row.tenant_user_id, row.provider, row.provider_account_id);
        const make = row.provider === "google" ? createGmailClient : createGraphClient;
        const api = make({
            fetchImpl,
            sleep,
            getAccessToken: async () => {
                if (row.token_fresh && row.access_token_enc) {
                    try {
                        return secretBox.decrypt(row.access_token_enc, aad, config.tokenKey);
                    } catch (_error) {
                        /* unreadable: fall through to a refresh */
                    }
                }
                return singleFlight(row);
            },
            refreshAccessToken: () => singleFlight(row),
        });
        const account = { id: row.id, email_address: row.email_address, display_name: row.display_name, provider: row.provider, account_kind: row.account_kind };
        return { ctx: { api, account }, row };
    }

    // Everything an HTTP handler needs to act on ONE of THIS employee's accounts.
    async function getContext({ companyId, userId, accountId }) {
        const id = Number(accountId);
        if (!Number.isInteger(id) || id <= 0) throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
        const row = await store.getWithTokens(companyId, userId, id); // scoped by company AND employee
        if (!row) throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
        const built = await getContextForRow(row);
        return { ...built.ctx, provider: getProvider(row.provider), companyId, userId };
    }

    async function noteFailure({ companyId, userId, account }, error) {
        if (error instanceof GraphError && error.code === "REAUTH_REQUIRED") {
            await store.markReauth(account.id, "PROVIDER_UNAUTHORIZED");
            emit("reauth", { companyId, userId, accountId: account.id, provider: account.provider });
        } else if (error instanceof GraphError && ["ACCESS_DENIED", "MAILBOX_NOT_AVAILABLE", "APP_MISCONFIGURED"].includes(error.code)) {
            await store.recordError(account.id, error.code);
        }
    }

    // ---------- profile, disconnect ----------
    async function updateAccount({ companyId, userId, accountId, displayName, color }) {
        const name = displayName === undefined ? undefined : String(displayName).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 100);
        if (color !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(String(color))) throw new EmailAccountError("INVALID_COLOR", "Choose a valid colour.", 400);
        const row = await store.updateProfile(companyId, userId, Number(accountId), { displayName: name, color });
        if (!row) throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
        return publicAccount(row);
    }

    // Disconnect = stop provider push, revoke the grant where the provider supports it, then DELETE the local row (tokens included).
    async function disconnect({ companyId, userId, accountId, actorId = userId, byAdmin = false }) {
        const id = Number(accountId);
        const row = byAdmin ? await store.getWithTokensById(id) : await store.getWithTokens(companyId, userId, id);
        if (!row || row.company_id !== companyId) throw new EmailAccountError("ACCOUNT_NOT_FOUND", "Account not found.", 404);
        let revoked = false;
        const config = configFor(row.provider);
        const aad = tokenAad(row.company_id, row.tenant_user_id, row.provider, row.provider_account_id);
        try {
            const sub = await store.getSubscription(row.id);
            if (sub && row.status === "connected" && config.configured) {
                const built = await getContextForRow(row);
                await getProvider(row.provider).stopPush(built.ctx, { subscriptionId: sub.subscription_id });
            }
        } catch (_error) {
            /* push cleanup is best effort: the subscription expires by itself */
        }
        if (row.provider === "google" && row.refresh_token_enc && config.configured) {
            try {
                revoked = (await oauthGoogle.revokeToken({ token: secretBox.decrypt(row.refresh_token_enc, aad, config.tokenKey), fetchImpl })).revoked;
            } catch (_error) {
                revoked = false;
            }
        }
        await store.removeForCompany(row.company_id, row.id);
        await audit({ companyId: row.company_id, actorUserId: actorId, action: byAdmin ? "account_disconnected_by_admin" : "account_disconnected", targetType: "account", targetId: row.id, detail: { provider: row.provider, revoked } });
        emit("accounts", { companyId: row.company_id, userId: row.tenant_user_id });
        return { disconnected: true, revoked };
    }

    // ---------- unread summary (cached by the sync; refreshed live when stale) ----------
    async function summary({ companyId, userId, refresh = false }) {
        let rows = await store.list(companyId, userId);
        if (refresh) {
            const stale = rows.filter((r) => r.status === "connected" && (!r.unread_checked_at || now() - new Date(r.unread_checked_at).getTime() > 180000)).slice(0, 5);
            await Promise.all(stale.map(async (r) => {
                try {
                    const built = await getContextForRow(await store.getWithTokens(companyId, userId, r.id));
                    await store.setUnread(r.id, await getProvider(r.provider).getUnread(built.ctx));
                } catch (_error) {
                    /* a failing account shows its own state; it must not hide the others */
                }
            }));
            rows = await store.list(companyId, userId);
        }
        const accounts = rows.map((r) => ({ id: r.id, status: r.status, unread: r.status === "connected" ? r.unread_inbox || 0 : 0, syncError: r.sync_error || null }));
        return { accounts, unreadTotal: accounts.reduce((n, a) => n + a.unread, 0), needsAttention: rows.filter((r) => r.status !== "connected").length };
    }

    // ---------- unified inbox ----------
    function encodeCursor(value) {
        return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    }
    function decodeCursor(cursor) {
        try {
            const v = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
            if (!v || typeof v.t !== "string" || Number.isNaN(Date.parse(v.t)) || !Array.isArray(v.seen)) throw new Error("shape");
            return { t: new Date(v.t).toISOString(), seen: v.seen.filter((s) => Number.isInteger(s.a) && typeof s.i === "string").slice(0, 200) };
        } catch (_error) {
            throw new EmailAccountError("INVALID_CURSOR", "Invalid page cursor.", 400);
        }
    }

    // The Inbox of every connected account of THIS employee, merged newest-first. A failing account never hides the others: it is
    // reported in `accountErrors`. Paging is by time (each provider is asked for mail at or before the last time shown; the ids
    // already shown at that exact instant are dropped), which works the same for Gmail and Graph.
    async function listUnified({ companyId, userId, params = {} }) {
        const top = clampInt(params.top, { min: 1, max: UNIFIED_MAX_PAGE, fallback: 25 });
        const textSearch = Boolean(params.q || params.subject || params.to);
        const cursor = params.cursor ? decodeCursor(params.cursor) : null;
        const rows = (await store.list(companyId, userId)).filter((r) => r.status === "connected");
        const accountErrors = [];
        const shown = new Set(cursor ? cursor.seen.map((s) => `${s.a}:${s.i}`) : []);
        let anyFull = false;

        const perAccount = await Promise.all(rows.map(async (r) => {
            try {
                const ctx = await getContext({ companyId, userId, accountId: r.id });
                const seenHere = cursor ? cursor.seen.filter((s) => s.a === r.id).length : 0;
                const ask = Math.min(top + seenHere, 50);
                const query = { ...params, folderId: "inbox", top: ask, cursor: undefined, sort: undefined };
                if (cursor && !textSearch) {
                    const ms = new Date(cursor.t).getTime();
                    if (r.provider === "google") query.beforeTime = String(Math.floor(ms / 1000) + 1); // Gmail's "before:" is exclusive, in seconds
                    else query.beforeTime = cursor.t;
                }
                const page = await ctx.provider.listMessages(ctx, query);
                if (page.messages.length >= ask && page.nextCursor) anyFull = true;
                return page.messages.map((m) => ({ ...m, accountId: r.id }));
            } catch (error) {
                accountErrors.push({ accountId: r.id, code: error.code || "ERROR" });
                if (error instanceof GraphError) await noteFailure({ companyId, userId, account: { id: r.id, provider: r.provider } }, error).catch(() => {});
                return [];
            }
        }));

        const merged = perAccount.flat().filter((m) => !shown.has(`${m.accountId}:${m.id}`));
        merged.sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
        const page = merged.slice(0, top);
        let nextCursor = null;
        if (!textSearch && page.length > 0 && (merged.length > top || anyFull)) {
            const lastTime = page[page.length - 1].receivedAt;
            if (lastTime) {
                // everything already shown at that exact instant (so the next page, which includes it, can drop it)
                const atBoundary = page.filter((m) => m.receivedAt === lastTime).map((m) => ({ a: m.accountId, i: m.id }));
                const carried = cursor && cursor.t === lastTime ? cursor.seen : [];
                nextCursor = encodeCursor({ t: lastTime, seen: [...carried, ...atBoundary].slice(0, 200) });
            }
        }
        return { messages: page, nextCursor, accountErrors, filteredLocally: false, searchSinglePage: textSearch && merged.length > top };
    }

    // ---------- preferences ----------
    async function getSettings({ companyId, userId }) {
        return store.getUserSettings(companyId, userId);
    }

    async function saveSettings({ companyId, userId, signatureHtml, signatureEnabled, favoriteFolders }) {
        const current = await store.getUserSettings(companyId, userId);
        let signature = current.signatureHtml;
        if (signatureHtml !== undefined) {
            const raw = String(signatureHtml || "");
            if (raw.length > 20000) throw new EmailAccountError("SIGNATURE_TOO_LARGE", "The signature is too long.", 400);
            signature = sanitizeEmailHtml(raw).html;
        }
        let favorites = current.favoriteFolders;
        if (favoriteFolders !== undefined) {
            if (!Array.isArray(favoriteFolders) || favoriteFolders.length > 100) throw new EmailAccountError("INVALID_FAVORITES", "Invalid favourites.", 400);
            // a favourite is "<accountId>:<folder id>" (folder ids differ per account)
            favorites = [...new Set(favoriteFolders.map((f) => {
                const [a, ...rest] = String(f).split(":");
                if (!/^\d{1,9}$/.test(a) || rest.length === 0) throw new EmailAccountError("INVALID_FAVORITES", "Invalid favourites.", 400);
                return `${a}:${assertGraphId(rest.join(":"), "folder")}`;
            }))];
        }
        const enabled = signatureEnabled === undefined ? current.signatureEnabled : Boolean(signatureEnabled);
        await store.saveUserSettings(companyId, userId, { signatureHtml: signature, signatureEnabled: enabled, favoriteFolders: favorites });
        return { signatureHtml: signature, signatureEnabled: enabled, favoriteFolders: favorites };
    }

    const auditMailEvent = ({ companyId, userId, action, targetId = null, detail = null }) => audit({ companyId, actorUserId: userId, action, targetType: "account", targetId, detail });

    // ---------- administrator: CONNECTION STATUS only ----------
    async function adminOverview(companyId) {
        const rows = await store.listForCompany(companyId);
        const byUser = new Map();
        for (const r of rows) {
            if (!byUser.has(r.tenant_user_id)) byUser.set(r.tenant_user_id, []);
            byUser.get(r.tenant_user_id).push({
                id: r.id, provider: r.provider, kind: r.account_kind, kindLabel: KIND_LABEL[r.account_kind],
                address: maskAddress(r.email_address), status: r.status, lastSyncAt: r.last_sync_at, syncError: r.sync_error || r.last_error || null, connectedAt: r.connected_at,
            });
        }
        const totals = { connected: 0, reauth_required: 0, disabled: 0 };
        for (const r of rows) totals[r.status] = (totals[r.status] || 0) + 1;
        return { employees: [...byUser.entries()].map(([userId, accounts]) => ({ userId, accounts })), totals, providers: providersStatus() };
    }

    async function adminDisconnect({ companyId, actorUserId, accountId }) {
        return disconnect({ companyId, userId: null, accountId, actorId: actorUserId, byAdmin: true });
    }

    const listAudit = (companyId, options) => store.listAudit(companyId, options);

    return {
        listAccounts,
        providersStatus,
        beginConnect,
        completeCallback,
        frontendRedirect,
        getContext,
        getContextForRow,
        noteFailure,
        updateAccount,
        disconnect,
        summary,
        listUnified,
        getSettings,
        saveSettings,
        auditMailEvent,
        adminOverview,
        adminDisconnect,
        listAudit,
        store,
    };
}

module.exports = { createEmailAccountService, EmailAccountError, maskAddress, MAX_ACCOUNTS_PER_USER, STATE_TTL_SECONDS };
