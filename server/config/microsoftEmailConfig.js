// ==========================================
// MICROSOFT 365 EMAIL CONFIGURATION
//
// Read from the environment at call time (never cached), so tests can set variables and the server picks up a
// changed value on restart. NOTHING here is a secret default: with the variables unset the feature reports
// "not configured" and every Microsoft call fails closed.
//
//   MS_EMAIL_CLIENT_ID       Application (client) ID of ONE multi-tenant app registration owned by ZioVenture.
//   MS_EMAIL_CLIENT_SECRET   Its client secret (confidential web client). Never logged, never sent to the browser.
//   MS_EMAIL_REDIRECT_URI    The exact redirect URI registered on the app, e.g. https://crm.zioventure.com/api/email/ms/callback
//   MS_EMAIL_TOKEN_KEY       32 random bytes, base64 -- encrypts the stored OAuth tokens (AES-256-GCM).
//   MS_EMAIL_FRONTEND_ORIGIN Where the browser is sent after the callback, e.g. https://crm.zioventure.com
// ==========================================

// Delegated permissions only -- least privilege for the mail client. No application (tenant-wide) permission.
//   offline_access            refresh tokens (so the employee is not asked to sign in every hour)
//   openid profile email      identity claims, used to prove WHICH account and tenant signed in
//   User.Read                 the signed-in user's own profile
//   Mail.ReadWrite            read, move, flag, delete and draft the user's OWN mail
//   Mail.Send                 send as the user
//   MailboxSettings.ReadWrite automatic replies (out of office), time zone
//   People.Read               contact autocomplete (relevant people)
const MS_SCOPES = [
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

const LOGIN_HOST = "https://login.microsoftonline.com";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// A Microsoft tenant id is a GUID. Anything else is rejected before it is placed into a URL.
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getConfig(env = process.env) {
    const clientId = (env.MS_EMAIL_CLIENT_ID || "").trim();
    const clientSecret = env.MS_EMAIL_CLIENT_SECRET || "";
    const redirectUri = (env.MS_EMAIL_REDIRECT_URI || "").trim();
    const tokenKey = env.MS_EMAIL_TOKEN_KEY || "";
    const frontendOrigin = (env.MS_EMAIL_FRONTEND_ORIGIN || "").trim().replace(/\/+$/, "");

    const missing = [];
    if (!clientId) missing.push("MS_EMAIL_CLIENT_ID");
    if (!clientSecret) missing.push("MS_EMAIL_CLIENT_SECRET");
    if (!redirectUri) missing.push("MS_EMAIL_REDIRECT_URI");
    if (!tokenKey) missing.push("MS_EMAIL_TOKEN_KEY");
    if (!frontendOrigin) missing.push("MS_EMAIL_FRONTEND_ORIGIN");

    return {
        configured: missing.length === 0,
        // Names only, never values -- safe to show an administrator.
        missing,
        clientId,
        clientSecret,
        redirectUri,
        tokenKey,
        frontendOrigin,
        scopes: MS_SCOPES,
    };
}

// Safe summary for the admin UI: presence flags and the scope list, no values.
function publicStatus(env = process.env) {
    const config = getConfig(env);
    return { configured: config.configured, missing: config.missing, scopes: config.scopes };
}

module.exports = { getConfig, publicStatus, MS_SCOPES, LOGIN_HOST, GRAPH_BASE, GUID_PATTERN };
