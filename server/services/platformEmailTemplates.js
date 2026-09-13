// ==========================================
// ZIOVENTURE PLATFORM EMAIL TEMPLATES (Phase 12L)
//
// A SEPARATE template file from services/emailTemplates.js, not a
// separate email SYSTEM -- both ultimately call the exact same
// services/emailService.js::sendMail() (nodemailer, same SMTP_*
// config, same "never throws" contract). Kept in its own file because
// these emails are a genuinely different brand/audience:
// emailTemplates.js is "Reinsteins WorkHub" branded and goes to a
// tenant's own employees about their tasks; these are "ZioVenture"
// branded (the SaaS platform itself, not any one tenant) and go to a
// company's admin and/or the Platform Owner about billing/subscription
// events. Mixing the two brand identities into one wrapEmail() would
// be more confusing than reusing it, not less.
//
// Never includes: internal database names, tenant DB identifiers,
// payment secrets, or anything beyond what a billing contact should
// see (plan name, dates, a plain-language next step).
// ==========================================

const BRAND_COLOR = "#2878D8";
const TEXT_COLOR = "#1A2233";
const MUTED_COLOR = "#64748B";

function baseUrl() {
    return (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
}

function formatDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function wrapZioVentureEmail({ eventTitle, description, detailLines = [], actionLabel, actionPath }) {
    const actionUrl = `${baseUrl()}${actionPath}`;

    const detailsHtml = detailLines.length
        ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;">${
            detailLines.map((line) => `<tr><td style="padding:4px 0;color:${MUTED_COLOR};font-size:13px;">${line}</td></tr>`).join("")
        }</table>`
        : "";

    const html = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#ffffff;">
    <div style="margin-bottom:20px;">
        <span style="font-size:13px;font-weight:700;letter-spacing:.03em;color:${BRAND_COLOR};text-transform:uppercase;">ZioVenture</span>
    </div>
    <h2 style="margin:0 0 10px;color:${TEXT_COLOR};font-size:19px;">${eventTitle}</h2>
    <p style="margin:0 0 6px;color:${TEXT_COLOR};font-size:14px;line-height:1.6;">${description}</p>
    ${detailsHtml}
    <a href="${actionUrl}" style="display:inline-block;margin-top:12px;padding:11px 22px;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;border-radius:7px;font-size:13.5px;font-weight:600;">${actionLabel}</a>
    <p style="margin-top:28px;color:${MUTED_COLOR};font-size:11.5px;">This is an automated message from ZioVenture. If the button doesn't work, copy this link: ${actionUrl}</p>
</div>
`.trim();

    const text =
        `ZioVenture\n\n${eventTitle}\n\n${description}\n\n`
        + (detailLines.length ? `${detailLines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n")}\n\n` : "")
        + `${actionLabel}: ${actionUrl}`;

    return { subject: eventTitle, html, text };
}

function trialEndingSoonEmail({ companyName, trialEndsAt, planName, daysRemaining }) {
    return wrapZioVentureEmail({
        eventTitle: `Your trial ends in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
        description: `${companyName}'s ZioVenture trial ends on ${formatDate(trialEndsAt)}. Upgrade to a paid plan to keep uninterrupted access.`,
        detailLines: [`Company: ${companyName}`, planName ? `Current plan: ${planName}` : null, `Trial ends: ${formatDate(trialEndsAt)}`].filter(Boolean),
        actionLabel: "Choose a Plan",
        actionPath: "/admin/settings",
    });
}

function trialExpiredEmail({ companyName, trialEndsAt }) {
    return wrapZioVentureEmail({
        eventTitle: "Your trial has ended",
        description: `${companyName}'s ZioVenture trial ended on ${formatDate(trialEndsAt)}. Access is currently paused until a plan is activated.`,
        detailLines: [`Company: ${companyName}`, `Trial ended: ${formatDate(trialEndsAt)}`],
        actionLabel: "Contact Support",
        actionPath: "/contact",
    });
}

function subscriptionExpiringSoonEmail({ companyName, subscriptionExpiresAt, planName, daysRemaining }) {
    return wrapZioVentureEmail({
        eventTitle: `Your subscription expires in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
        description: `${companyName}'s ${planName || "ZioVenture"} subscription expires on ${formatDate(subscriptionExpiresAt)}. Renew to avoid any interruption.`,
        detailLines: [`Company: ${companyName}`, planName ? `Plan: ${planName}` : null, `Expires: ${formatDate(subscriptionExpiresAt)}`].filter(Boolean),
        actionLabel: "Renew Now",
        actionPath: "/admin/settings",
    });
}

function paymentFailedEmail({ companyName, planName, amount, currency }) {
    return wrapZioVentureEmail({
        eventTitle: "Payment failed",
        description: `A payment for ${companyName}'s ${planName || "ZioVenture"} subscription was not successful. Please retry to keep your subscription active.`,
        detailLines: [`Company: ${companyName}`, planName ? `Plan: ${planName}` : null, amount ? `Amount: ${currency || "INR"} ${amount}` : null].filter(Boolean),
        actionLabel: "Retry Payment",
        actionPath: "/admin/settings",
    });
}

function gracePeriodStartedEmail({ companyName, gracePeriodEndsAt, planName }) {
    return wrapZioVentureEmail({
        eventTitle: "Action needed: renew your subscription",
        description: `${companyName}'s subscription has expired, but you have a short grace period to renew before access is paused. Access remains available until ${formatDate(gracePeriodEndsAt)}.`,
        detailLines: [`Company: ${companyName}`, planName ? `Plan: ${planName}` : null, `Access available until: ${formatDate(gracePeriodEndsAt)}`].filter(Boolean),
        actionLabel: "Renew Now",
        actionPath: "/admin/settings",
    });
}

function gracePeriodEndingEmail({ companyName, gracePeriodEndsAt, daysRemaining }) {
    return wrapZioVentureEmail({
        eventTitle: `Grace period ends in ${daysRemaining} day${daysRemaining === 1 ? "" : "s"}`,
        description: `${companyName}'s grace period ends on ${formatDate(gracePeriodEndsAt)}. Renew now to avoid your access being paused.`,
        detailLines: [`Company: ${companyName}`, `Grace period ends: ${formatDate(gracePeriodEndsAt)}`],
        actionLabel: "Renew Now",
        actionPath: "/admin/settings",
    });
}

function subscriptionExpiredEmail({ companyName, planName }) {
    return wrapZioVentureEmail({
        eventTitle: "Your subscription has expired",
        description: `${companyName}'s ${planName || "ZioVenture"} subscription has expired and access is currently paused. Renew to restore access.`,
        detailLines: [`Company: ${companyName}`, planName ? `Plan: ${planName}` : null].filter(Boolean),
        actionLabel: "Renew Now",
        actionPath: "/admin/settings",
    });
}

function subscriptionRenewedEmail({ companyName, planName, subscriptionExpiresAt }) {
    return wrapZioVentureEmail({
        eventTitle: "Subscription renewed",
        description: `${companyName}'s ${planName || "ZioVenture"} subscription has been renewed successfully. Thank you!`,
        detailLines: [`Company: ${companyName}`, planName ? `Plan: ${planName}` : null, `Active until: ${formatDate(subscriptionExpiresAt)}`].filter(Boolean),
        actionLabel: "View Account",
        actionPath: "/admin/settings",
    });
}

module.exports = {
    trialEndingSoonEmail,
    trialExpiredEmail,
    subscriptionExpiringSoonEmail,
    paymentFailedEmail,
    gracePeriodStartedEmail,
    gracePeriodEndingEmail,
    subscriptionExpiredEmail,
    subscriptionRenewedEmail,
};
