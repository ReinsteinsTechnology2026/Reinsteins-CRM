const { createGraphClient, GraphError } = require("../graphClient");

// ==========================================
// GMAIL HTTP CLIENT -- the same retry / refresh / error handling as the Microsoft Graph client (services/graphClient.js), pointed at
// the Gmail API. Only /gmail/v1/users/me/... (and the matching /upload/ path for large raw messages) is reachable: the account's
// own mailbox, nothing else. No absolute URL is ever followed.
// ==========================================

const GMAIL_HOST = "https://gmail.googleapis.com";
const API = "/gmail/v1/users/me";
const UPLOAD = "/upload/gmail/v1/users/me";

const RATE_LIMIT_REASONS = ["rateLimitExceeded", "userRateLimitExceeded", "backendError"];

const isGmailTarget = (target) => /^\/(gmail\/v1|upload\/gmail\/v1)\/users\/me(\/|\?|$)/.test(target);

// Google reports the machine-readable reason in error.errors[0].reason, and an RPC-style status in error.status.
function classify(_status, body) {
    const error = body && body.error;
    if (!error) return null;
    return (error.errors && error.errors[0] && error.errors[0].reason) || error.status || null;
}

function mapStatus(status, reason) {
    if (status === 401) return ["REAUTH_REQUIRED", "Google needs you to sign in again."];
    if (status === 403) {
        if (RATE_LIMIT_REASONS.includes(reason)) return ["THROTTLED", "Google is limiting requests right now. Try again in a moment."];
        if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED") return ["APP_MISCONFIGURED", "The Gmail API is not enabled for ZioVenture's Google project. Contact your platform administrator."];
        return ["ACCESS_DENIED", "Google refused access. Consent may be missing, was withdrawn, or your Google Workspace administrator restricted this app."];
    }
    if (status === 404) return ["NOT_FOUND", "That item no longer exists."];
    if (status === 400) {
        if (reason === "failedPrecondition" || reason === "FAILED_PRECONDITION") return ["MAILBOX_NOT_AVAILABLE", "This Google account has no Gmail mailbox available."];
        return ["BAD_REQUEST", "Google could not process this request."];
    }
    if (status === 409 || status === 412) return ["CONFLICT", "The item was changed elsewhere. Refresh and try again."];
    if (status === 413) return ["TOO_LARGE", "The item is too large."];
    if (status === 429) return ["THROTTLED", "Google is limiting requests right now. Try again in a moment."];
    return ["PROVIDER_UNAVAILABLE", "Google is temporarily unavailable. Try again shortly."];
}

function createGmailClient(options) {
    return createGraphClient({
        baseUrl: GMAIL_HOST,
        relativeOk: isGmailTarget,
        absoluteOk: () => false,
        classify,
        map: mapStatus,
        retryableCodes: RATE_LIMIT_REASONS,
        ...options,
    });
}

module.exports = { createGmailClient, GraphError, API, UPLOAD, mapStatus, classify, isGmailTarget };
