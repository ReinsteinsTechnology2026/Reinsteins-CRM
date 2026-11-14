const crypto = require("crypto");
const secretBox = require("../utils/secretBox");
const oauthMs = require("./microsoftOAuthService");
const { getProvider } = require("./mail/providers");
const { getProviderConfig } = require("../config/emailProvidersConfig");
const { GraphError } = require("./graphClient");
const { safeEmit } = require("./emailEvents");

// ==========================================
// EMAIL SYNC SERVICE -- keeps the CRM's unread counts and new-mail notifications in step with the ORIGINAL provider.
//
// Mail is never copied or hosted here. For each connected account this only asks the provider "what is new since my cursor?",
// records each new message ONCE (email_new_mail_events is unique per account + message: the duplicate guard), updates the cached
// unread count and tells the owner's browser. The user's normal Gmail / Outlook notifications are untouched: reading mail through
// the provider's API does not mark anything read, and nothing here sends or changes mail.
//
// Three triggers feed the same idempotent sync:
//   1. PUSH   Gmail Pub/Sub watch and Microsoft Graph change notifications make the provider call us when mail arrives;
//   2. POLL   every connected account is also synced on a schedule (every ~2 minutes when no push subscription is active, every
//             ~15 minutes as a safety net when one is) -- the safe fallback when push is not configured, expired or missed;
//   3. EVENTS the browser asks for a refresh.
// Accounts are CLAIMED atomically (FOR UPDATE SKIP LOCKED + a lease), so overlapping cycles and several server processes can never
// sync the same account twice, and a crashed sync is retried when its lease runs out.
// ==========================================

const POLL_SECONDS = 120;
const PUSH_SAFETY_POLL_SECONDS = 900;
const RENEW_WINDOW_SECONDS = 24 * 3600;
const MAX_BACKOFF_SECONDS = 3600;
const SYNC_ERROR_EMIT_AFTER = 3;
const shortReason = (error) => String((error && error.code) || (error && error.message) || "error").slice(0, 120);

function createEmailSyncService({ accountService, store, configFor = (p) => getProviderConfig(p), emit = safeEmit, now = () => Date.now(), logger = console }) {
    const inflight = new Map();
    const audit = (entry) => store.writeAudit(entry).catch(() => {});

    // ---------- one account ----------
    function syncAccount(accountId, { reason = "poll" } = {}) {
        const key = Number(accountId);
        if (inflight.has(key)) return inflight.get(key); // a sync for this account is already running: share it
        const run = doSync(key, reason).finally(() => inflight.delete(key));
        inflight.set(key, run);
        return run;
    }

    async function doSync(accountId, reason) {
        const row = await store.getWithTokensById(accountId);
        if (!row || row.status !== "connected") return { skipped: true };
        const provider = getProvider(row.provider);
        const who = { companyId: row.company_id, userId: row.tenant_user_id, accountId: row.id, provider: row.provider };
        try {
            const built = await accountService.getContextForRow(row);
            const result = await provider.pollNewMail(built.ctx, row.sync_cursor);

            // The duplicate guard: only a message seen for the FIRST time is announced.
            const fresh = [];
            for (const event of result.events) if (await store.recordEvent(row.id, event.id)) fresh.push(event);

            const sub = await store.getSubscription(row.id);
            const pushActive = Boolean(sub && sub.status === "active" && sub.expires_at && new Date(sub.expires_at).getTime() > now());
            await store.syncSucceeded(row.id, {
                cursor: result.cursor,
                unread: result.unread,
                nextInSeconds: pushActive ? PUSH_SAFETY_POLL_SECONDS : POLL_SECONDS,
                note: result.reset && row.sync_cursor ? "resynced" : null,
            });
            if (fresh.length > 0) {
                const latest = fresh[fresh.length - 1];
                const summary = await accountService.summary({ companyId: row.company_id, userId: row.tenant_user_id });
                emit("new-mail", { ...who, count: fresh.length, latest: { from: latest.from, subject: latest.subject }, unreadTotal: summary.unreadTotal, unread: result.unread });
            }
            return { synced: true, fresh: fresh.length, reason };
        } catch (error) {
            return handleFailure(row, who, error);
        }
    }

    async function handleFailure(row, who, error) {
        // A rejected sign-in is not a sync problem: the account is marked "reconnect" (tokens wiped) and the owner is told.
        if ((error instanceof GraphError && error.code === "REAUTH_REQUIRED") || (error && error.code === "REAUTH_REQUIRED")) {
            if (error instanceof GraphError) await accountService.noteFailure({ companyId: row.company_id, userId: row.tenant_user_id, account: { id: row.id, provider: row.provider } }, error);
            return { reauth: true };
        }
        const backoff = Math.min(60 * 2 ** Math.min(row.sync_failures, 6), MAX_BACKOFF_SECONDS);
        await store.syncFailed(row.id, shortReason(error), backoff);
        if (row.sync_failures + 1 === SYNC_ERROR_EMIT_AFTER) {
            emit("sync-error", { ...who, message: "Synchronisation is failing for this account." });
            await audit({ companyId: row.company_id, actorUserId: row.tenant_user_id, action: "account_sync_failing", targetType: "account", targetId: row.id, detail: { reason: shortReason(error) } });
        }
        return { failed: true, backoff };
    }

    // ---------- a cycle over every due account ----------
    async function runCycle({ limit = 50, concurrency = 4 } = {}) {
        const claimed = await store.claimDue(limit);
        let next = 0;
        const results = [];
        await Promise.all(Array.from({ length: Math.min(concurrency, claimed.length) }, async () => {
            while (next < claimed.length) {
                const account = claimed[next];
                next += 1;
                results.push(await syncAccount(account.id, { reason: "poll" }).catch((e) => ({ failed: true, error: shortReason(e) })));
            }
        }));
        await store.purgeEvents(14).catch(() => {});
        await maintainSubscriptions().catch((e) => logger.error("[email-sync] subscription maintenance failed:", shortReason(e)));
        return { claimed: claimed.length, results };
    }

    // ---------- push subscriptions ----------
    async function ensureSubscription(accountId) {
        const row = await store.getWithTokensById(accountId);
        if (!row || row.status !== "connected") return { skipped: "not connected" };
        const config = configFor(row.provider);
        if (!config.configured || !config.pushConfigured) return { skipped: "push not configured" };
        const provider = getProvider(row.provider);
        const built = await accountService.getContextForRow(row);
        try {
            if (row.provider === "google") {
                const r = await provider.ensurePush(built.ctx, { topic: config.pubsubTopic });
                await store.saveSubscription(row.id, { provider: "google", subscriptionId: null, resource: r.resource, expiresAt: r.expiresAt });
            } else {
                const clientState = oauthMs.randomToken(24);
                const r = await provider.ensurePush(built.ctx, { notificationUrl: config.notificationUrl, clientState });
                await store.saveSubscription(row.id, { provider: "microsoft", subscriptionId: r.subscriptionId, clientStateHash: secretBox.sha256Hex(clientState), resource: r.resource, expiresAt: r.expiresAt });
            }
            return { subscribed: true };
        } catch (error) {
            // Push is an optimisation: record why it is not working and carry on polling.
            await store.saveSubscription(row.id, { provider: row.provider, subscriptionId: null, resource: null, expiresAt: null, status: "error", lastError: shortReason(error) }).catch(() => {});
            return { failed: shortReason(error) };
        }
    }

    // Renews subscriptions that expire soon (Gmail watches last 7 days, Microsoft mail subscriptions about 3) and creates missing ones.
    async function maintainSubscriptions() {
        for (const sub of await store.subscriptionsExpiringWithin(RENEW_WINDOW_SECONDS, 50)) {
            const row = await store.getWithTokensById(sub.account_id);
            if (!row) continue;
            const provider = getProvider(sub.provider);
            try {
                const built = await accountService.getContextForRow(row);
                if (sub.provider === "microsoft" && sub.subscription_id) {
                    const r = await provider.renewPush(built.ctx, { subscriptionId: sub.subscription_id });
                    await store.saveSubscription(row.id, { provider: "microsoft", subscriptionId: sub.subscription_id, resource: null, expiresAt: r.expiresAt });
                } else {
                    await ensureSubscription(row.id); // a Gmail watch is renewed by calling watch again
                }
            } catch (error) {
                // A subscription the provider no longer knows (404) or can no longer renew: create a fresh one.
                await ensureSubscription(row.id).catch(() => {});
            }
        }
        for (const provider of ["google", "microsoft"]) {
            const config = configFor(provider);
            if (!config.configured || !config.pushConfigured) continue;
            for (const missing of await store.connectedWithoutSubscription(provider, 10)) await ensureSubscription(missing.id).catch(() => {});
        }
    }

    // ---------- incoming push ----------
    // `message` is the Pub/Sub push body ({ message: { data, messageId }, subscription }), ALREADY authenticated by the controller.
    async function handleGooglePush(body) {
        const data = body && body.message && body.message.data;
        let payload;
        try {
            payload = JSON.parse(Buffer.from(String(data || ""), "base64").toString("utf8"));
        } catch (_error) {
            return { accepted: 0, ignored: true };
        }
        if (!payload || typeof payload.emailAddress !== "string") return { accepted: 0, ignored: true };
        const accounts = await store.connectedByEmail("google", payload.emailAddress);
        for (const account of accounts) {
            await store.touchNotification(account.id).catch(() => {});
            // Fire and forget: Pub/Sub must get its acknowledgement quickly; the sync is idempotent so a redelivery is harmless.
            syncAccount(account.id, { reason: "push" }).catch((e) => logger.error("[email-sync] push sync failed:", shortReason(e)));
        }
        return { accepted: accounts.length };
    }

    // `notifications` is the Graph change-notification payload ({ value: [...] }). Each item's clientState must match the secret
    // generated when WE created that subscription; anything else is dropped.
    async function handleMicrosoftNotifications(payload) {
        const items = Array.isArray(payload && payload.value) ? payload.value.slice(0, 100) : [];
        let accepted = 0;
        let rejected = 0;
        for (const item of items) {
            const sub = item && item.subscriptionId ? await store.findSubscription(item.subscriptionId) : null;
            const given = secretBox.sha256Hex(String(item && item.clientState || ""));
            const ok = sub && sub.client_state_hash && sub.client_state_hash.length === given.length && crypto.timingSafeEqual(Buffer.from(sub.client_state_hash), Buffer.from(given));
            if (!ok) { rejected += 1; continue; }
            accepted += 1;
            await store.touchNotification(sub.account_id).catch(() => {});
            if (item.lifecycleEvent === "reauthorizationRequired" || item.lifecycleEvent === "subscriptionRemoved") {
                ensureSubscription(sub.account_id).catch(() => {});
            } else {
                syncAccount(sub.account_id, { reason: item.lifecycleEvent === "missed" ? "missed" : "push" }).catch((e) => logger.error("[email-sync] push sync failed:", shortReason(e)));
            }
        }
        return { accepted, rejected };
    }

    // ---------- scheduler ----------
    function start({ intervalMs = 30000 } = {}) {
        let running = false;
        const tick = async () => {
            if (running) return;
            running = true;
            try {
                await runCycle();
            } catch (error) {
                logger.error("[email-sync] cycle failed:", shortReason(error));
            } finally {
                running = false;
            }
        };
        const timer = setInterval(tick, intervalMs);
        if (timer.unref) timer.unref();
        const first = setTimeout(tick, 5000);
        if (first.unref) first.unref();
        return () => {
            clearInterval(timer);
            clearTimeout(first);
        };
    }

    return { syncAccount, runCycle, ensureSubscription, maintainSubscriptions, handleGooglePush, handleMicrosoftNotifications, start };
}

module.exports = { createEmailSyncService, POLL_SECONDS, PUSH_SAFETY_POLL_SECONDS };
