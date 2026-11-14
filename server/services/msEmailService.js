const { getConfig, publicStatus } = require("../config/microsoftEmailConfig");
const secretBox = require("../utils/secretBox");
const oauth = require("./microsoftOAuthService");
const { createGraphClient, GraphError } = require("./graphClient");
const { sanitizeEmailHtml } = require("../utils/emailHtmlSanitizer");
const { assertGraphId } = require("../utils/emailValidation");

// ==========================================
// MICROSOFT EMAIL SERVICE -- connection lifecycle, mailbox linking, OAuth callback, token handling.
//
// What this does and does NOT do (kept honest on purpose):
//   * It LINKS an existing Microsoft 365 mailbox to a CRM employee after that employee signs in to Microsoft. It does
//     NOT create a Microsoft mailbox, assign a licence or change anything in the customer's Microsoft 365 tenant. A
//     mailbox row in the CRM is only a record until the employee has connected.
//   * No Microsoft password is ever seen or stored: sign-in happens on Microsoft's own page.
//   * Nothing here touches DNS, MX, SPF, DKIM or DMARC.
// ==========================================

class EmailServiceError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.name = "EmailServiceError";
        this.code = code;
        this.status = status;
    }
}

const STATE_TTL_SECONDS = 600; // the employee has 10 minutes to finish the Microsoft sign-in
const MAX_FAVORITES = 50;
const MAX_SIGNATURE_CHARS = 20_000;

const tokenAad = (companyId, userId) => `ms-user:${companyId}:${userId}`;
const stateAad = (companyId, userId) => `ms-state:${companyId}:${userId}`;

// A safe line for the audit log / last_error column. Never includes anything from a token or message.
const shortReason = (error) => String((error && error.code) || (error && error.message) || "error").slice(0, 120);

function createMsEmailService(overrides = {}) {
    const store = overrides.store || require("./msEmailStore").createMsEmailStore();
    const getCompanyConfig = overrides.getConfig || getConfig;
    const fetchImpl = overrides.fetchImpl || fetch;
    const sleep = overrides.sleep;
    const emailDomainService = overrides.emailDomainService || require("./emailDomainService");
    const lookupCompany = overrides.getCompanyById || ((id) => require("./platformCompanyService").getCompanyById(id));
    const now = overrides.now || (() => Date.now());

    // One refresh at a time per employee in this process: two parallel requests with an expired token must not both
    // spend (and possibly invalidate) the same refresh token.
    const refreshLocks = new Map();

    const audit = (entry) =>
        store.writeAudit(entry).catch((error) => console.error("[email-audit] write failed:", error.message));

    function requireConfigured() {
        const config = getCompanyConfig();
        if (!config.configured) {
            throw new EmailServiceError("MS_NOT_CONFIGURED", "Microsoft 365 sign-in is not set up on this server yet. A platform administrator must register the Microsoft app first.", 503);
        }
        return config;
    }

    // ---------- admin: company connection ----------

    async function companyStatus(companyId) {
        const connection = await store.getCompanyConnection(companyId);
        const domains = (await emailDomainService.listDomainsForCompany(companyId)).filter((d) => d.verification_status === "verified" && d.status === "active");
        const config = getCompanyConfig();
        return {
            server: publicStatus(),
            connection,
            verifiedDomains: domains.map((d) => ({ id: d.id, domain: d.domain })),
            health: await store.connectionHealth(companyId),
            adminConsentUrl: connection && connection.ms_tenant_id && config.configured ? oauth.buildAdminConsentUrl({ config, msTenantId: connection.ms_tenant_id }) : null,
        };
    }

    // Finds the company's Microsoft 365 organisation from one of ITS OWN verified domains.
    async function connectCompany({ companyId, actorUserId, domainId }) {
        requireConfigured();
        const domain = await emailDomainService.getDomainForCompany(domainId, companyId);
        if (!domain) throw new EmailServiceError("DOMAIN_NOT_FOUND", "Domain not found.", 404);
        if (domain.verification_status !== "verified" || domain.status !== "active") {
            throw new EmailServiceError("DOMAIN_NOT_VERIFIED", "Verify this domain's ownership first.", 409);
        }
        let tenantId;
        try {
            tenantId = await oauth.discoverTenantId(domain.domain, fetchImpl);
        } catch (error) {
            await store.upsertCompanyConnection(companyId, { msTenantId: null, domainId: domain.id, status: "error", lastError: shortReason(error), createdBy: actorUserId });
            await audit({ companyId, actorUserId, action: "company_connect_failed", targetType: "domain", targetId: domain.id, detail: { reason: shortReason(error) } });
            throw error instanceof oauth.OAuthError ? new EmailServiceError(error.code, error.message, error.status) : error;
        }
        const connection = await store.upsertCompanyConnection(companyId, { msTenantId: tenantId, domainId: domain.id, status: "ready", createdBy: actorUserId });
        await audit({ companyId, actorUserId, action: "company_connected", targetType: "domain", targetId: domain.id, detail: { domain: domain.domain } });
        return connection;
    }

    async function checkCompanyConnection({ companyId, actorUserId }) {
        requireConfigured();
        const existing = await store.getCompanyConnection(companyId);
        if (!existing || !existing.domain_id) throw new EmailServiceError("NOT_CONNECTED", "Connect Microsoft 365 first.", 409);
        const domain = await emailDomainService.getDomainForCompany(existing.domain_id, companyId);
        if (!domain) throw new EmailServiceError("DOMAIN_NOT_FOUND", "The connected domain no longer exists.", 409);
        try {
            const tenantId = await oauth.discoverTenantId(domain.domain, fetchImpl);
            if (existing.ms_tenant_id && tenantId !== existing.ms_tenant_id) {
                // The domain now belongs to a different Microsoft organisation: stop, do not follow it silently.
                const result = await store.setCompanyConnectionStatus(companyId, "error", "TENANT_CHANGED");
                await audit({ companyId, actorUserId, action: "company_check_tenant_changed", targetType: "domain", targetId: domain.id });
                return result;
            }
            const result = await store.setCompanyConnectionStatus(companyId, "ready", null);
            await audit({ companyId, actorUserId, action: "company_check_ok", targetType: "domain", targetId: domain.id });
            return result;
        } catch (error) {
            const result = await store.setCompanyConnectionStatus(companyId, "error", shortReason(error));
            await audit({ companyId, actorUserId, action: "company_check_failed", targetType: "domain", targetId: domain.id, detail: { reason: shortReason(error) } });
            return result;
        }
    }

    // Disables the company's Microsoft link and removes every employee's stored tokens. Mailbox ROWS are kept (history).
    async function disconnectCompany({ companyId, actorUserId }) {
        const removed = await store.deleteAllConnectionsForCompany(companyId);
        for (const row of removed) await store.clearMailboxLink(companyId, row.mailbox_id);
        const mailboxes = await store.listMailboxesWithConnection(companyId);
        for (const mailbox of mailboxes) if (mailbox.provider === "microsoft365") await store.clearMailboxLink(companyId, mailbox.id);
        await store.setCompanyConnectionStatus(companyId, "disabled", null);
        await audit({ companyId, actorUserId, action: "company_disconnected", detail: { employeeConnectionsRemoved: removed.length } });
        return { disconnected: true, removed: removed.length };
    }

    // ---------- admin: mailbox linking ----------

    async function listMailboxes(companyId) {
        return store.listMailboxesWithConnection(companyId);
    }

    // Marks an existing mailbox record as "to be connected through Microsoft 365". Creates nothing at Microsoft.
    async function linkMailbox({ companyId, actorUserId, mailboxId }) {
        requireConfigured();
        const company = await store.getCompanyConnection(companyId);
        if (!company || company.status !== "ready" || !company.ms_tenant_id) {
            throw new EmailServiceError("COMPANY_NOT_READY", "Connect your Microsoft 365 organisation first.", 409);
        }
        const mailbox = await store.getMailbox(companyId, mailboxId);
        if (!mailbox) throw new EmailServiceError("MAILBOX_NOT_FOUND", "Mailbox not found.", 404);
        if (mailbox.status !== "active") throw new EmailServiceError("MAILBOX_DISABLED", "This mailbox is disabled.", 409);
        if (mailbox.link_state === "linked") throw new EmailServiceError("ALREADY_LINKED", "This mailbox is already connected.", 409);

        if (await store.findLinkedMailboxForUser(companyId, mailbox.tenant_user_id, mailbox.id)) {
            throw new EmailServiceError("EMPLOYEE_ALREADY_LINKED", "This employee already has a Microsoft 365 mailbox linked.", 409);
        }

        // The mailbox's own domain must belong to the SAME Microsoft organisation as the company connection.
        const mailboxDomain = mailbox.email_address.split("@")[1];
        let tenantId;
        try {
            tenantId = await oauth.discoverTenantId(mailboxDomain, fetchImpl);
        } catch (error) {
            throw error instanceof oauth.OAuthError ? new EmailServiceError(error.code, error.message, error.status) : error;
        }
        if (tenantId !== company.ms_tenant_id) {
            throw new EmailServiceError("DOMAIN_TENANT_MISMATCH", "This mailbox's domain belongs to a different Microsoft 365 organisation than the one connected.", 409);
        }

        const updated = await store.setMailboxLink(companyId, mailbox.id, { provider: "microsoft365", linkState: "awaiting_user" });
        await audit({ companyId, actorUserId, action: "mailbox_link_started", targetType: "mailbox", targetId: mailbox.id, detail: { employeeId: mailbox.tenant_user_id } });
        return updated;
    }

    async function unlinkMailbox({ companyId, actorUserId, mailboxId }) {
        const mailbox = await store.getMailbox(companyId, mailboxId);
        if (!mailbox) throw new EmailServiceError("MAILBOX_NOT_FOUND", "Mailbox not found.", 404);
        await store.deleteConnectionByMailbox(companyId, mailbox.id);
        const updated = await store.clearMailboxLink(companyId, mailbox.id);
        await audit({ companyId, actorUserId, action: "mailbox_unlinked", targetType: "mailbox", targetId: mailbox.id, detail: { employeeId: mailbox.tenant_user_id } });
        return updated;
    }

    // Disable / enable a mailbox's use inside the CRM. Disabling also removes the stored tokens immediately.
    async function setMailboxEnabled({ companyId, actorUserId, mailboxId, enabled }) {
        const mailbox = await store.getMailbox(companyId, mailboxId);
        if (!mailbox) throw new EmailServiceError("MAILBOX_NOT_FOUND", "Mailbox not found.", 404);
        if (!enabled) {
            const removed = await store.deleteConnectionByMailbox(companyId, mailbox.id);
            if (removed && mailbox.provider === "microsoft365") await store.setMailboxLink(companyId, mailbox.id, { provider: "microsoft365", linkState: "awaiting_user", provisioningStatus: "pending_infrastructure" });
        }
        await audit({ companyId, actorUserId, action: enabled ? "mailbox_enabled" : "mailbox_disabled", targetType: "mailbox", targetId: mailbox.id });
        return { id: mailbox.id, enabled: Boolean(enabled) };
    }

    // ---------- employee: connect ----------

    async function employeeStatus({ companyId, userId }) {
        const config = getCompanyConfig();
        const mailbox = await store.getOwnMailbox(companyId, userId);
        const company = await store.getCompanyConnection(companyId);
        const connection = mailbox ? await store.getConnection(companyId, userId) : null;
        let state = "no_mailbox";
        if (mailbox) {
            if (!config.configured) state = "server_not_configured";
            else if (mailbox.status !== "active") state = "mailbox_disabled";
            else if (!company || company.status !== "ready") state = "company_not_connected";
            else if (mailbox.provider !== "microsoft365") state = "not_linked";
            else if (!connection) state = "disconnected";
            else if (connection.status === "reauth_required") state = "reauth_required";
            else if (connection.status === "connected") state = "connected";
            else state = "disconnected";
        }
        return {
            state,
            serverConfigured: config.configured,
            mailbox: mailbox ? { id: mailbox.id, address: mailbox.email_address, status: mailbox.status, linkState: mailbox.link_state } : null,
            connection: connection ? { status: connection.status, account: connection.ms_account, connectedAt: connection.connected_at, lastError: connection.last_error } : null,
        };
    }

    async function beginConnect({ companyId, userId, returnPortal }) {
        const config = requireConfigured();
        const company = await store.getCompanyConnection(companyId);
        if (!company || company.status !== "ready" || !company.ms_tenant_id) {
            throw new EmailServiceError("COMPANY_NOT_READY", "Your company has not connected its Microsoft 365 organisation yet. Ask your administrator.", 409);
        }
        const mailbox = await store.getOwnMailbox(companyId, userId);
        if (!mailbox) throw new EmailServiceError("NO_MAILBOX", "You don't have a company mailbox yet. Ask your administrator.", 404);
        if (mailbox.status !== "active") throw new EmailServiceError("MAILBOX_DISABLED", "Your mailbox is disabled.", 403);
        if (mailbox.provider !== "microsoft365") throw new EmailServiceError("NOT_LINKED", "Your administrator has not linked this mailbox to Microsoft 365 yet.", 409);

        const state = oauth.randomToken(32);
        const nonce = oauth.randomToken(24);
        const pkce = oauth.generatePkce();
        await store.createOAuthState({
            companyId,
            tenantUserId: userId,
            mailboxId: mailbox.id,
            stateHash: secretBox.sha256Hex(state),
            nonceHash: secretBox.sha256Hex(nonce),
            verifierEnc: secretBox.encrypt(pkce.verifier, stateAad(companyId, userId), config.tokenKey),
            returnPortal,
            ttlSeconds: STATE_TTL_SECONDS,
        });
        await audit({ companyId, actorUserId: userId, action: "connect_started", targetType: "mailbox", targetId: mailbox.id });
        return {
            authorizationUrl: oauth.buildAuthorizeUrl({ config, msTenantId: company.ms_tenant_id, state, nonce, challenge: pkce.challenge, loginHint: mailbox.email_address }),
        };
    }

    // Handles Microsoft's redirect. Returns where to send the browser; NEVER throws to the caller for an expected
    // failure (the employee sees a friendly page) and never echoes Microsoft's error text.
    async function completeCallback({ code, state, error: providerError }) {
        const config = getCompanyConfig();
        const fail = (reason, base = {}) => ({ ok: false, reason, ...base });
        if (!config.configured) return fail("not_configured");
        if (typeof state !== "string" || state.length < 20 || state.length > 200) return fail("invalid_state");

        // Consuming FIRST means a state is dead after one use even when the exchange below fails.
        const saved = await store.consumeOAuthState(secretBox.sha256Hex(state));
        if (!saved) return fail("invalid_state");
        const base = { companyId: saved.company_id, userId: saved.tenant_user_id, returnPortal: saved.return_portal };

        if (providerError) {
            await audit({ companyId: saved.company_id, actorUserId: saved.tenant_user_id, action: "connect_denied", targetType: "mailbox", targetId: saved.mailbox_id });
            return fail("denied", base);
        }
        if (typeof code !== "string" || code.length < 10 || code.length > 4096) return fail("invalid_code", base);

        try {
            const mailbox = await store.getMailbox(saved.company_id, saved.mailbox_id);
            const company = await store.getCompanyConnection(saved.company_id);
            if (!mailbox || mailbox.tenant_user_id !== saved.tenant_user_id || mailbox.status !== "active" || mailbox.provider !== "microsoft365") return fail("mailbox_unavailable", base);
            if (!company || company.status !== "ready" || !company.ms_tenant_id) return fail("company_not_ready", base);

            const verifier = secretBox.decrypt(saved.code_verifier_enc, stateAad(saved.company_id, saved.tenant_user_id), config.tokenKey);
            const tokens = await oauth.exchangeCode({ config, msTenantId: company.ms_tenant_id, code, verifier, fetchImpl });
            if (!tokens.refreshToken) return fail("no_refresh_token", base);

            // WHO signed in: the right organisation, our app, our nonce -- and the right MAILBOX.
            const claims = oauth.validateIdTokenClaims(oauth.decodeJwtPayload(tokens.idToken), {
                config,
                expectedTenantId: company.ms_tenant_id,
                expectedNonceHash: saved.nonce_hash,
                now: now(),
                sha256Hex: secretBox.sha256Hex,
            });
            if (!claims.accounts.includes(mailbox.email_address.toLowerCase())) {
                await audit({ companyId: saved.company_id, actorUserId: saved.tenant_user_id, action: "connect_wrong_account", targetType: "mailbox", targetId: mailbox.id });
                return fail("wrong_account", base);
            }

            const account = claims.accounts.find((value) => value === mailbox.email_address.toLowerCase());
            await store.upsertConnection({
                companyId: saved.company_id,
                tenantUserId: saved.tenant_user_id,
                mailboxId: mailbox.id,
                msTenantId: claims.tid,
                msUserOid: claims.oid,
                msAccount: account,
                scopes: tokens.scope,
                accessTokenEnc: secretBox.encrypt(tokens.accessToken, tokenAad(saved.company_id, saved.tenant_user_id), config.tokenKey),
                refreshTokenEnc: secretBox.encrypt(tokens.refreshToken, tokenAad(saved.company_id, saved.tenant_user_id), config.tokenKey),
                expiresInSeconds: tokens.expiresIn,
            });
            await store.setMailboxLink(saved.company_id, mailbox.id, { provider: "microsoft365", linkState: "linked", provisioningStatus: "provisioned", linkedAt: true });
            await audit({ companyId: saved.company_id, actorUserId: saved.tenant_user_id, action: "connected", targetType: "mailbox", targetId: mailbox.id });
            return { ok: true, ...base };
        } catch (error) {
            const reason = error instanceof oauth.OAuthError ? error.code : "error";
            if (!(error instanceof oauth.OAuthError)) console.error("[email] OAuth callback failed:", error.code || error.name);
            await audit({ companyId: saved.company_id, actorUserId: saved.tenant_user_id, action: "connect_failed", targetType: "mailbox", targetId: saved.mailbox_id, detail: { reason } });
            return fail(reason === "TENANT_MISMATCH" ? "wrong_organisation" : "failed", base);
        }
    }

    // Employee removes their own connection (tokens deleted); the admin's link stays so they can reconnect.
    async function disconnectOwn({ companyId, userId }) {
        const removed = await store.deleteConnection(companyId, userId);
        if (removed) {
            await store.setMailboxLink(companyId, removed.mailbox_id, { provider: "microsoft365", linkState: "awaiting_user", provisioningStatus: "pending_infrastructure" });
            await audit({ companyId, actorUserId: userId, action: "disconnected", targetType: "mailbox", targetId: removed.mailbox_id });
        }
        return { disconnected: Boolean(removed) };
    }

    // ---------- mail access ----------

    async function refreshNow({ companyId, userId, config }) {
        const row = await store.getConnectionWithTokens(companyId, userId);
        if (!row || !row.refresh_token_enc) throw new EmailServiceError("REAUTH_REQUIRED", "Reconnect your Microsoft account.", 409);
        let refreshToken;
        try {
            refreshToken = secretBox.decrypt(row.refresh_token_enc, tokenAad(companyId, userId), config.tokenKey);
        } catch (_error) {
            await store.markReauthRequired(companyId, userId, "TOKEN_UNREADABLE");
            throw new EmailServiceError("REAUTH_REQUIRED", "Reconnect your Microsoft account.", 409);
        }
        try {
            const tokens = await oauth.refreshTokens({ config, msTenantId: row.ms_tenant_id, refreshToken, fetchImpl });
            await store.updateTokens(companyId, userId, {
                accessTokenEnc: secretBox.encrypt(tokens.accessToken, tokenAad(companyId, userId), config.tokenKey),
                // Microsoft rotates refresh tokens: keep the new one, or the old one if none was returned.
                refreshTokenEnc: tokens.refreshToken ? secretBox.encrypt(tokens.refreshToken, tokenAad(companyId, userId), config.tokenKey) : null,
                expiresInSeconds: tokens.expiresIn,
            });
            return tokens.accessToken;
        } catch (error) {
            if (error instanceof oauth.OAuthError && error.code === "REAUTH_REQUIRED") {
                await store.markReauthRequired(companyId, userId, "REFRESH_REJECTED");
                await audit({ companyId, actorUserId: userId, action: "reauth_required", targetType: "mailbox", targetId: row.mailbox_id });
                throw new EmailServiceError("REAUTH_REQUIRED", "Your Microsoft sign-in expired or was revoked. Reconnect to continue.", 409);
            }
            throw error instanceof oauth.OAuthError ? new EmailServiceError(error.code, error.message, error.status) : error;
        }
    }

    function singleFlightRefresh(args) {
        const key = `${args.companyId}:${args.userId}`;
        if (!refreshLocks.has(key)) {
            const promise = refreshNow(args).finally(() => refreshLocks.delete(key));
            refreshLocks.set(key, promise);
        }
        return refreshLocks.get(key);
    }

    // Everything an HTTP handler needs to act on ONE employee's own mailbox. Throws a coded EmailServiceError otherwise.
    async function getMailContext({ companyId, userId }) {
        const config = requireConfigured();
        const company = await store.getCompanyConnection(companyId);
        if (!company || company.status === "disabled") throw new EmailServiceError("COMPANY_NOT_READY", "Microsoft 365 email is not enabled for your company.", 409);
        // The domain moved to a different Microsoft organisation: stop using the old tokens until an administrator re-checks.
        if (company.status === "error" && company.last_error === "TENANT_CHANGED") {
            throw new EmailServiceError("COMPANY_NOT_READY", "Your company's Microsoft 365 connection needs attention. Ask your administrator.", 409);
        }
        const mailbox = await store.getOwnMailbox(companyId, userId);
        if (!mailbox) throw new EmailServiceError("NO_MAILBOX", "You don't have a company mailbox yet.", 404);
        if (mailbox.status !== "active") throw new EmailServiceError("MAILBOX_DISABLED", "Your mailbox is disabled.", 403);
        const connection = await store.getConnectionWithTokens(companyId, userId);
        if (!connection || mailbox.provider !== "microsoft365" || connection.mailbox_id !== mailbox.id) {
            throw new EmailServiceError("NOT_CONNECTED", "Connect your Microsoft account to use email.", 409);
        }
        if (connection.status !== "connected") throw new EmailServiceError("REAUTH_REQUIRED", "Reconnect your Microsoft account.", 409);

        const args = { companyId, userId, config };
        const graph = createGraphClient({
            fetchImpl,
            sleep,
            getAccessToken: async () => {
                if (connection.token_fresh && connection.access_token_enc) {
                    try {
                        return secretBox.decrypt(connection.access_token_enc, tokenAad(companyId, userId), config.tokenKey);
                    } catch (_error) {
                        /* unreadable: fall through to a refresh */
                    }
                }
                return singleFlightRefresh(args);
            },
            refreshAccessToken: () => singleFlightRefresh(args),
        });
        return { graph, mailbox, connection: { account: connection.ms_account }, companyId, userId };
    }

    // Translates a failed Graph call into connection state where that is the right reaction.
    async function noteGraphFailure({ companyId, userId }, error) {
        if (error instanceof GraphError && error.code === "REAUTH_REQUIRED") {
            await store.markReauthRequired(companyId, userId, "GRAPH_UNAUTHORIZED");
        } else if (error instanceof GraphError && ["ACCESS_DENIED", "MAILBOX_NOT_AVAILABLE"].includes(error.code)) {
            await store.recordConnectionError(companyId, userId, error.code);
        }
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
            if (raw.length > MAX_SIGNATURE_CHARS) throw new EmailServiceError("SIGNATURE_TOO_LARGE", "The signature is too long.", 400);
            signature = sanitizeEmailHtml(raw).html;
        }
        let favorites = current.favoriteFolders;
        if (favoriteFolders !== undefined) {
            if (!Array.isArray(favoriteFolders) || favoriteFolders.length > MAX_FAVORITES) throw new EmailServiceError("INVALID_FAVORITES", "Invalid favourites.", 400);
            favorites = [...new Set(favoriteFolders.map((id) => assertGraphId(String(id), "folder")))];
        }
        const enabled = signatureEnabled === undefined ? current.signatureEnabled : Boolean(signatureEnabled);
        await store.saveUserSettings(companyId, userId, { signatureHtml: signature, signatureEnabled: enabled, favoriteFolders: favorites });
        return { signatureHtml: signature, signatureEnabled: enabled, favoriteFolders: favorites };
    }

    // ---------- audit view ----------

    async function listAudit(companyId, options) {
        return store.listAudit(companyId, options);
    }

    async function auditMailEvent({ companyId, userId, action, targetId = null, detail = null }) {
        await audit({ companyId, actorUserId: userId, action, targetType: "mailbox", targetId, detail });
    }

    async function frontendRedirect({ companyId, returnPortal, result }) {
        const config = getCompanyConfig();
        const company = await lookupCompany(companyId);
        const slug = company && company.company_slug;
        const portal = returnPortal === "admin" ? "admin" : "employee";
        const target = new URL(`${config.frontendOrigin}/${encodeURIComponent(slug || "")}/${portal}/email`);
        target.searchParams.set("ms", result.ok ? "connected" : "error");
        if (!result.ok) target.searchParams.set("reason", result.reason);
        return target.toString();
    }

    return {
        companyStatus,
        connectCompany,
        checkCompanyConnection,
        disconnectCompany,
        listMailboxes,
        linkMailbox,
        unlinkMailbox,
        setMailboxEnabled,
        employeeStatus,
        beginConnect,
        completeCallback,
        disconnectOwn,
        getMailContext,
        noteGraphFailure,
        getSettings,
        saveSettings,
        listAudit,
        auditMailEvent,
        frontendRedirect,
    };
}

module.exports = { createMsEmailService, EmailServiceError, STATE_TTL_SECONDS };
