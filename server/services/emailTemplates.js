// ==========================================
// EMAIL TEMPLATES
//
// Short, professional, WorkHub-branded HTML +
// plain-text pairs for the task lifecycle events
// listed in the approved Notifications / Email
// Notifications plan. Deliberately simple markup
// (table-based, inline styles) for broad email
// client compatibility -- no external stylesheet,
// no Azure DevOps branding/colors/logo, just the
// existing WorkHub name and gold accent already
// used across the app's own theme.
// ==========================================

const BRAND_COLOR = "#B88734";
const TEXT_COLOR = "#241F1C";
const MUTED_COLOR = "#6b6258";
const { __getCurrentCompanySlug, __getActivePool, __legacyPool } = require('../config/db');

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
}

class EmailConfigError extends Error {}

// Trusted origin for every link in an email. In production it must be set
// explicitly and be a valid http(s) origin -- a localhost fallback there would
// silently mail unusable links. Local development keeps the default.
function baseUrl() {
    const explicit = process.env.APP_BASE_URL;
    if (!explicit && process.env.NODE_ENV === 'production') {
        throw new EmailConfigError('APP_BASE_URL is required in production');
    }
    let url;
    try {
        url = new URL(explicit || "http://localhost:5173");
    } catch (_error) {
        throw new EmailConfigError('APP_BASE_URL is not a valid URL');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new EmailConfigError('APP_BASE_URL must be a trusted HTTP(S) origin');
    }
    return url.origin;
}

let configErrorReported = false;

// Returns null (no email) when APP_BASE_URL is unusable, so the caller still
// creates the in-app notification but queues and sends nothing.
function wrapEmail(options) {
    try {
        return buildEmail(options);
    } catch (error) {
        if (!(error instanceof EmailConfigError)) throw error;
        if (!configErrorReported) {
            configErrorReported = true;
            console.error(`[emailTemplates] Email not created: ${error.message}`);
        }
        return null;
    }
}

function buildEmail({ eventTitle, description, detailLines = [], actionLabel, actionPath, subject }) {

    const companySlug = __getCurrentCompanySlug();
    // No tenant prefix only when the request really runs on the legacy database
    // (routes /admin, /employee). Any other database -- including a tenant database
    // registered under the slug 'reinsteins' -- is addressed as /<slug>/...
    const tenantPath = __getActivePool() === __legacyPool ? '' : `/${encodeURIComponent(companySlug)}`;
    const actionUrl = `${baseUrl()}${tenantPath}${actionPath}`;

    const detailsHtml = detailLines.length
        ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;">${
            detailLines.map(
                (line) => `<tr><td style="padding:4px 0;color:${MUTED_COLOR};font-size:13px;">${escapeHtml(line)}</td></tr>`
            ).join("")
        }</table>`
        : "";

    const html = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#ffffff;">
    <div style="margin-bottom:20px;">
        <span style="font-size:13px;font-weight:700;letter-spacing:.03em;color:${BRAND_COLOR};text-transform:uppercase;">ZioVenture WorkHub</span>
    </div>
    <h2 style="margin:0 0 10px;color:${TEXT_COLOR};font-size:19px;">${escapeHtml(eventTitle)}</h2>
    <p style="margin:0 0 6px;color:${TEXT_COLOR};font-size:14px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(description)}</p>
    ${detailsHtml}
    <a href="${escapeHtml(actionUrl)}" style="display:inline-block;margin-top:12px;padding:11px 22px;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;border-radius:7px;font-size:13.5px;font-weight:600;">${escapeHtml(actionLabel)}</a>
    <p style="margin-top:28px;color:${MUTED_COLOR};font-size:11.5px;">This is an automated notification sent through ZioVenture WorkHub on behalf of your organization. If the button doesn't work, copy this link: ${escapeHtml(actionUrl)}</p>
</div>
`.trim();

    const text =
        `ZioVenture WorkHub\n\n${eventTitle}\n\n${description}\n\n`
        + (detailLines.length ? `${detailLines.join("\n")}\n\n` : "")
        + `${actionLabel}: ${actionUrl}`;

    return { subject: subject || eventTitle, html, text };

}

function taskUrl(taskId, recipientRole = 'employee') {
    return `/${recipientRole === 'admin' ? 'admin' : 'employee'}/task-workspace/${taskId}`;
}

function taskMentionEmail({ authorName, body, taskTitle, taskNumber, projectName, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: `${authorName} mentioned you in a task`,
        subject: `[ZioVenture WorkHub] ${authorName} mentioned you in #${taskNumber}`,
        description: body,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : null,
        ].filter(Boolean),
        actionLabel: 'View discussion',
        actionPath: taskUrl(taskId, recipientRole),
    });
}

// ==========================================
// TASK ASSIGNED / REASSIGNED / TRANSFERRED
// ==========================================

function assignmentDetails(data) {
    return [
        `Task: #${data.taskNumber} ${data.taskTitle}`,
        data.projectName ? `Project: ${data.projectName}` : null,
        data.userStoryTitle ? `User Story: ${data.userStoryTitle}` : null,
        data.featureTitle ? `Feature: ${data.featureTitle}` : null,
        data.epicTitle ? `Epic: ${data.epicTitle}` : null,
        data.status ? `Status: ${data.status}` : null,
        data.priority ? `Priority: ${data.priority}` : null,
        data.dueDate ? `Due: ${new Date(data.dueDate).toLocaleDateString('en-IN')}` : null,
        `Assigned at: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
    ].filter(Boolean);
}

function taskAssignedEmail({ taskTitle, taskNumber, projectName, actorName, taskId, recipientName, recipientRole, ...rest }) {
    return wrapEmail({
        eventTitle: "New task assigned to you",
        subject: `[ZioVenture WorkHub] Task assigned: ${taskTitle}`,
        description: `${recipientName ? `Hi ${recipientName},\n\n` : ''}${actorName} assigned you a task: "${taskTitle}".`,
        detailLines: assignmentDetails({ taskTitle, taskNumber, projectName, ...rest }),
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

function taskReassignedEmail({ taskTitle, taskNumber, projectName, actorName, taskId, recipientName, recipientRole, ...rest }) {
    return wrapEmail({
        eventTitle: "Task reassigned to you",
        subject: `[ZioVenture WorkHub] Task reassigned: ${taskTitle}`,
        description: `${recipientName ? `Hi ${recipientName},\n\n` : ''}${actorName} reassigned "${taskTitle}" to you.`,
        detailLines: assignmentDetails({ taskTitle, taskNumber, projectName, ...rest }),
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

function taskTransferredEmail({ taskTitle, taskNumber, projectName, actorName, taskId, recipientRole, ...rest }) {
    return wrapEmail({
        eventTitle: "Task transferred to you",
        subject: `[ZioVenture WorkHub] Task transferred: ${taskTitle}`,
        description: `${actorName} transferred "${taskTitle}" to you.`,
        detailLines: assignmentDetails({ taskTitle, taskNumber, projectName, ...rest }),
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

// ==========================================
// REVIEW LIFECYCLE
// ==========================================

function taskSubmittedForReviewEmail({ taskTitle, taskNumber, projectName, actorName, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: "Task submitted for review",
        description: `${actorName} submitted "${taskTitle}" for your review.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Review Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

function taskApprovedEmail({ taskTitle, taskNumber, projectName, actorName, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: "Task approved and closed",
        description: `${actorName} approved and closed "${taskTitle}".`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

function taskSentBackEmail({ taskTitle, taskNumber, projectName, actorName, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: "Task sent back for changes",
        description: `${actorName} sent "${taskTitle}" back for changes.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

// ==========================================
// SPRINT ASSIGNMENT
// ==========================================

function taskSprintChangedEmail({ taskTitle, taskNumber, projectName, sprintChangeText, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: "Sprint assignment updated",
        description: `Your task "${taskTitle}" was ${sprintChangeText}.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

// ==========================================
// DUE SOON / OVERDUE
// ==========================================

function taskDueSoonEmail({ taskTitle, taskNumber, projectName, dueDateLabel, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: "Task due soon",
        description: `"${taskTitle}" is due on ${dueDateLabel}.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

function taskOverdueEmail({ taskTitle, taskNumber, projectName, dueDateLabel, taskId, recipientRole }) {
    return wrapEmail({
        eventTitle: "Task overdue",
        description: `"${taskTitle}" was due on ${dueDateLabel} and is still open.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId, recipientRole),
    });
}

module.exports = {
    taskMentionEmail,
    taskAssignedEmail,
    taskReassignedEmail,
    taskTransferredEmail,
    taskSubmittedForReviewEmail,
    taskApprovedEmail,
    taskSentBackEmail,
    taskSprintChangedEmail,
    taskDueSoonEmail,
    taskOverdueEmail,
};
