const { GRAPH_BASE } = require("../config/microsoftEmailConfig");

// ==========================================
// MICROSOFT GRAPH HTTP CLIENT -- one connection's calls, with throttling / retry / token-refresh handling.
//
//   * Bearer auth from an injected token source; a 401 triggers exactly ONE forced refresh and a retry, after which a
//     second 401 becomes REAUTH_REQUIRED (the employee must sign in again).
//   * 429 / 503 / 504 and network failures are retried (default 4 attempts), honouring Retry-After (capped), else
//     exponential backoff with jitter. When the retries are exhausted the caller gets THROTTLED / MICROSOFT_UNAVAILABLE.
//   * Absolute URLs (the opaque "next page" links) are accepted ONLY for https://graph.microsoft.com/v1.0/me/... so
//     a tampered cursor can never make the server request another host (SSRF) or another user's mailbox.
//   * Errors are mapped to stable codes. Microsoft's raw error text is never forwarded to the browser.
//   * Tokens are never logged and never appear in an error message.
//
// `fetchImpl` and `sleep` are injectable so tests run instantly and offline.
// ==========================================

class GraphError extends Error {
    constructor(code, message, { status, graphCode, retryAfterSeconds } = {}) {
        super(message);
        this.name = "GraphError";
        this.code = code;
        this.status = status;
        this.graphCode = graphCode;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RETRY_AFTER_SECONDS = 30;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const NO_MAILBOX_CODES = new Set([
    "MailboxNotEnabledForRESTAPI",
    "MailboxNotSupportedForRESTAPI",
    "ResourceNotFound",
    "ErrorInvalidUser",
    "MailboxNotFound",
]);

function mapStatus(status, graphCode) {
    if (status === 401) return ["REAUTH_REQUIRED", "Microsoft needs you to sign in again."];
    if (status === 403) {
        if (NO_MAILBOX_CODES.has(graphCode)) return ["MAILBOX_NOT_AVAILABLE", "This Microsoft account has no Exchange Online mailbox (it may be unlicensed)."];
        return ["ACCESS_DENIED", "Microsoft refused access. Consent may be missing or was withdrawn."];
    }
    if (status === 404) {
        if (NO_MAILBOX_CODES.has(graphCode) && graphCode !== "ResourceNotFound") return ["MAILBOX_NOT_AVAILABLE", "This Microsoft account has no Exchange Online mailbox (it may be unlicensed)."];
        return ["NOT_FOUND", "That item no longer exists."];
    }
    if (status === 400) return ["BAD_REQUEST", "Microsoft could not process this request."];
    if (status === 409 || status === 412) return ["CONFLICT", "The item was changed elsewhere. Refresh and try again."];
    if (status === 413) return ["TOO_LARGE", "The item is too large."];
    if (status === 429) return ["THROTTLED", "Microsoft is limiting requests right now. Try again in a moment."];
    return ["MICROSOFT_UNAVAILABLE", "Microsoft is temporarily unavailable. Try again shortly."];
}

// A user-readable query string. Keys keep their "$", values use encodeURIComponent (spaces become %20, never "+").
function buildQuery(query) {
    if (!query) return "";
    const parts = [];
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        parts.push(`${key}=${encodeURIComponent(String(value)).replace(/%24/g, "$").replace(/%2C/g, ",")}`);
    }
    return parts.length ? `?${parts.join("&")}` : "";
}

function isAllowedAbsoluteUrl(candidate) {
    let url;
    try {
        url = new URL(candidate);
    } catch (_error) {
        return false;
    }
    return url.protocol === "https:" && url.hostname === "graph.microsoft.com" && url.port === "" && url.pathname.startsWith("/v1.0/me/");
}

function createGraphClient({
    getAccessToken,
    refreshAccessToken,
    fetchImpl = fetch,
    sleep = defaultSleep,
    maxAttempts = 4,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    random = Math.random,
}) {
    async function send(url, init) {
        return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    }

    function retryDelayMs(response, attempt) {
        const header = response && response.headers && response.headers.get && response.headers.get("retry-after");
        const seconds = Number(header);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, MAX_RETRY_AFTER_SECONDS) * 1000;
        return Math.round(300 * 2 ** attempt * (0.75 + random() * 0.5));
    }

    /**
     * @param {string} method
     * @param {string} target  "/me/..." (relative to Graph v1.0) or an allowed absolute next-link
     * @param {{query?:object, body?:any, headers?:object, raw?:boolean, rawBody?:Buffer|string, authless?:boolean}} options
     */
    async function request(method, target, options = {}) {
        let url;
        // Relative targets must stay under /me (or be the $batch endpoint); "//host" style targets are never relative.
        if (/^\/(me(\/|\?|$)|\$batch(\?|$))/.test(target)) {
            url = `${GRAPH_BASE}${target}${buildQuery(options.query)}`;
        } else if (isAllowedAbsoluteUrl(target)) {
            url = target;
        } else {
            throw new GraphError("BAD_REQUEST", "Invalid request target.", { status: 400 });
        }

        let token = options.authless ? null : await getAccessToken();
        let refreshed = false;
        let lastResponse = null;
        let lastNetworkError = null;

        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const headers = { Accept: "application/json", ...(options.headers || {}) };
            if (token) headers.Authorization = `Bearer ${token}`;
            let body;
            if (options.rawBody !== undefined) {
                body = options.rawBody;
            } else if (options.body !== undefined) {
                headers["Content-Type"] = "application/json";
                body = JSON.stringify(options.body);
            }

            let response;
            try {
                response = await send(url, { method, headers, body });
                lastNetworkError = null;
            } catch (error) {
                lastNetworkError = error;
                if (attempt < maxAttempts - 1) {
                    await sleep(retryDelayMs(null, attempt));
                    continue;
                }
                break;
            }
            lastResponse = response;

            if (response.status === 401 && !refreshed && !options.authless) {
                refreshed = true;
                token = await refreshAccessToken(); // throws OAuthError/GraphError REAUTH_REQUIRED when the refresh token is dead
                continue;
            }
            if ((response.status === 429 || response.status === 503 || response.status === 504) && attempt < maxAttempts - 1) {
                await sleep(retryDelayMs(response, attempt));
                continue;
            }

            if (response.ok) {
                if (response.status === 204 || response.status === 202) return options.raw ? { buffer: Buffer.alloc(0), contentType: null } : null;
                if (options.raw) {
                    return {
                        buffer: Buffer.from(await response.arrayBuffer()),
                        contentType: response.headers.get("content-type"),
                    };
                }
                const text = await response.text();
                if (!text) return null;
                try {
                    return JSON.parse(text);
                } catch (_error) {
                    throw new GraphError("MICROSOFT_UNAVAILABLE", "Microsoft returned an unreadable response.", { status: response.status });
                }
            }

            let graphCode = null;
            try {
                graphCode = (await response.json()).error.code || null;
            } catch (_error) {
                graphCode = null;
            }
            const [code, message] = mapStatus(response.status, graphCode);
            const retryAfter = Number(response.headers.get("retry-after"));
            throw new GraphError(code, message, {
                status: response.status,
                graphCode,
                retryAfterSeconds: Number.isFinite(retryAfter) ? retryAfter : undefined,
            });
        }

        if (lastNetworkError && !lastResponse) {
            throw new GraphError("MICROSOFT_UNAVAILABLE", "Could not reach Microsoft. Try again shortly.", {});
        }
        const [code, message] = mapStatus(lastResponse ? lastResponse.status : 503, null);
        throw new GraphError(code, message, { status: lastResponse ? lastResponse.status : 503 });
    }

    return {
        get: (target, options) => request("GET", target, options),
        post: (target, options) => request("POST", target, options),
        patch: (target, options) => request("PATCH", target, options),
        put: (target, options) => request("PUT", target, options),
        delete: (target, options) => request("DELETE", target, options),
        request,
    };
}

module.exports = { createGraphClient, GraphError, buildQuery, isAllowedAbsoluteUrl };
