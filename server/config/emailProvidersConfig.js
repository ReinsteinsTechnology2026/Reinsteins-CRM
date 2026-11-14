// ==========================================
// EMAIL PROVIDER CONFIGURATION (Google + Microsoft), read from the environment at call time.
//
// NOTHING here is a secret default: with the settings unset a provider reports "not configured" and every call to it fails
// closed. Only setting NAMES are ever shown to an administrator, never values.
//
// Shared
//   EMAIL_TOKEN_KEY (falls back to MS_EMAIL_TOKEN_KEY)       32 random bytes, base64: encrypts stored OAuth tokens (AES-256-GCM)
//   EMAIL_FRONTEND_ORIGIN (falls back to MS_EMAIL_FRONTEND_ORIGIN)   where the browser returns after consent
// Google (Gmail API)
//   GOOGLE_EMAIL_CLIENT_ID / GOOGLE_EMAIL_CLIENT_SECRET      an OAuth "Web application" client in a Google Cloud project
//   GOOGLE_EMAIL_REDIRECT_URI                                 https://<host>/api/email/accounts/callback/google
//   optional push:  GOOGLE_EMAIL_PUBSUB_TOPIC (projects/<id>/topics/<name>), GOOGLE_EMAIL_PUSH_AUDIENCE (the push endpoint URL),
//                   GOOGLE_EMAIL_PUSH_SERVICE_ACCOUNT (the Pub/Sub push identity's email)
// Microsoft (Graph; personal Outlook.com / Hotmail AND Microsoft 365 work or school accounts)
//   MS_EMAIL_CLIENT_ID / MS_EMAIL_CLIENT_SECRET              ONE app registration (accounts in any directory + personal accounts)
//   MS_EMAIL_ACCOUNT_REDIRECT_URI                            https://<host>/api/email/accounts/callback/microsoft
//   optional push:  MS_EMAIL_NOTIFICATION_URL                https://<host>/api/email/push/microsoft
// ==========================================

// Gmail scopes are RESTRICTED scopes (Google requires app verification and a security assessment for production use beyond the
// test-user limit). The two requested are the smallest set that supports reading, labelling, trashing, drafting and sending
// (gmail.modify -- it cannot permanently delete) and the vacation responder (gmail.settings.basic). No contacts scope.
const GOOGLE_SCOPES = [
    "openid",
    "email",
    "profile",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.settings.basic",
];
// What MUST have been granted (a user can untick scopes on Google's consent screen): without these the client cannot work.
const GOOGLE_REQUIRED_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];

// Delegated Microsoft Graph permissions, same set as the original Microsoft 365 integration.
const MICROSOFT_ACCOUNT_SCOPES = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "User.Read",
    "Mail.ReadWrite",
    "Mail.Send",
    "MailboxSettings.ReadWrite",
    "People.Read",
];
const MICROSOFT_REQUIRED_SCOPES = ["Mail.ReadWrite", "Mail.Send"];

// Microsoft's id for the "consumers" tenant: an id_token with this tid belongs to a PERSONAL account (Outlook.com / Hotmail).
const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

function common(env) {
    return {
        tokenKey: env.EMAIL_TOKEN_KEY || env.MS_EMAIL_TOKEN_KEY || "",
        frontendOrigin: (env.EMAIL_FRONTEND_ORIGIN || env.MS_EMAIL_FRONTEND_ORIGIN || "").trim().replace(/\/+$/, ""),
    };
}

function getGoogleConfig(env = process.env) {
    const c = common(env);
    const clientId = (env.GOOGLE_EMAIL_CLIENT_ID || "").trim();
    const clientSecret = env.GOOGLE_EMAIL_CLIENT_SECRET || "";
    const redirectUri = (env.GOOGLE_EMAIL_REDIRECT_URI || "").trim();
    const missing = [];
    if (!clientId) missing.push("GOOGLE_EMAIL_CLIENT_ID");
    if (!clientSecret) missing.push("GOOGLE_EMAIL_CLIENT_SECRET");
    if (!redirectUri) missing.push("GOOGLE_EMAIL_REDIRECT_URI");
    if (!c.tokenKey) missing.push("EMAIL_TOKEN_KEY");
    if (!c.frontendOrigin) missing.push("EMAIL_FRONTEND_ORIGIN");
    const pubsubTopic = (env.GOOGLE_EMAIL_PUBSUB_TOPIC || "").trim();
    const pushAudience = (env.GOOGLE_EMAIL_PUSH_AUDIENCE || "").trim();
    const pushServiceAccount = (env.GOOGLE_EMAIL_PUSH_SERVICE_ACCOUNT || "").trim();
    return {
        provider: "google",
        configured: missing.length === 0,
        missing,
        clientId,
        clientSecret,
        redirectUri,
        scopes: GOOGLE_SCOPES,
        requiredScopes: GOOGLE_REQUIRED_SCOPES,
        pubsubTopic,
        pushAudience,
        pushServiceAccount,
        // Push needs all three; without them the sync job polls (safe fallback).
        pushConfigured: Boolean(pubsubTopic && pushAudience && pushServiceAccount),
        ...c,
    };
}

function getMicrosoftConfig(env = process.env) {
    const c = common(env);
    const clientId = (env.MS_EMAIL_CLIENT_ID || "").trim();
    const clientSecret = env.MS_EMAIL_CLIENT_SECRET || "";
    const redirectUri = (env.MS_EMAIL_ACCOUNT_REDIRECT_URI || "").trim();
    const missing = [];
    if (!clientId) missing.push("MS_EMAIL_CLIENT_ID");
    if (!clientSecret) missing.push("MS_EMAIL_CLIENT_SECRET");
    if (!redirectUri) missing.push("MS_EMAIL_ACCOUNT_REDIRECT_URI");
    if (!c.tokenKey) missing.push("EMAIL_TOKEN_KEY");
    if (!c.frontendOrigin) missing.push("EMAIL_FRONTEND_ORIGIN");
    const notificationUrl = (env.MS_EMAIL_NOTIFICATION_URL || "").trim();
    return {
        provider: "microsoft",
        configured: missing.length === 0,
        missing,
        clientId,
        clientSecret,
        redirectUri,
        scopes: MICROSOFT_ACCOUNT_SCOPES,
        requiredScopes: MICROSOFT_REQUIRED_SCOPES,
        notificationUrl,
        pushConfigured: /^https:\/\//.test(notificationUrl),
        ...c,
    };
}

function getProviderConfig(provider, env = process.env) {
    if (provider === "google") return getGoogleConfig(env);
    if (provider === "microsoft") return getMicrosoftConfig(env);
    return null;
}

// Safe summary for the UI: whether each provider can be used, which setting NAMES are missing, and whether push is available.
function publicProviderStatus(env = process.env) {
    const out = {};
    for (const provider of ["google", "microsoft"]) {
        const config = getProviderConfig(provider, env);
        out[provider] = { configured: config.configured, missing: config.missing, pushConfigured: config.pushConfigured, scopes: config.scopes };
    }
    return out;
}

module.exports = {
    GOOGLE_SCOPES,
    GOOGLE_REQUIRED_SCOPES,
    MICROSOFT_ACCOUNT_SCOPES,
    MICROSOFT_REQUIRED_SCOPES,
    MICROSOFT_CONSUMER_TENANT,
    getGoogleConfig,
    getMicrosoftConfig,
    getProviderConfig,
    publicProviderStatus,
};
