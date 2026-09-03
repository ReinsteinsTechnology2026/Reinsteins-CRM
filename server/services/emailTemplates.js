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

function baseUrl() {
    return (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
}

function wrapEmail({ eventTitle, description, detailLines = [], actionLabel, actionPath }) {

    const actionUrl = `${baseUrl()}${actionPath}`;

    const detailsHtml = detailLines.length
        ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;">${
            detailLines.map(
                (line) => `<tr><td style="padding:4px 0;color:${MUTED_COLOR};font-size:13px;">${line}</td></tr>`
            ).join("")
        }</table>`
        : "";

    const html = `
<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#ffffff;">
    <div style="margin-bottom:20px;">
        <span style="font-size:13px;font-weight:700;letter-spacing:.03em;color:${BRAND_COLOR};text-transform:uppercase;">Reinsteins WorkHub</span>
    </div>
    <h2 style="margin:0 0 10px;color:${TEXT_COLOR};font-size:19px;">${eventTitle}</h2>
    <p style="margin:0 0 6px;color:${TEXT_COLOR};font-size:14px;line-height:1.6;">${description}</p>
    ${detailsHtml}
    <a href="${actionUrl}" style="display:inline-block;margin-top:12px;padding:11px 22px;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;border-radius:7px;font-size:13.5px;font-weight:600;">${actionLabel}</a>
    <p style="margin-top:28px;color:${MUTED_COLOR};font-size:11.5px;">This is an automated message from Reinsteins WorkHub. If the button doesn't work, copy this link: ${actionUrl}</p>
</div>
`.trim();

    const text =
        `Reinsteins WorkHub\n\n${eventTitle}\n\n${description}\n\n`
        + (detailLines.length ? `${detailLines.map((l) => l.replace(/<[^>]+>/g, "")).join("\n")}\n\n` : "")
        + `${actionLabel}: ${actionUrl}`;

    return { subject: eventTitle, html, text };

}

function taskUrl(taskId) {
    return `/employee/task-workspace/${taskId}`;
}

// ==========================================
// TASK ASSIGNED / REASSIGNED / TRANSFERRED
// ==========================================

function taskAssignedEmail({ taskTitle, taskNumber, projectName, actorName, taskId }) {
    return wrapEmail({
        eventTitle: "New task assigned to you",
        description: `${actorName} assigned you a task: "${taskTitle}".`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

function taskReassignedEmail({ taskTitle, taskNumber, projectName, actorName, taskId }) {
    return wrapEmail({
        eventTitle: "Task reassigned to you",
        description: `${actorName} reassigned "${taskTitle}" to you.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

function taskTransferredEmail({ taskTitle, taskNumber, projectName, actorName, taskId }) {
    return wrapEmail({
        eventTitle: "Task transferred to you",
        description: `${actorName} transferred "${taskTitle}" to you.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

// ==========================================
// REVIEW LIFECYCLE
// ==========================================

function taskSubmittedForReviewEmail({ taskTitle, taskNumber, projectName, actorName, taskId }) {
    return wrapEmail({
        eventTitle: "Task submitted for review",
        description: `${actorName} submitted "${taskTitle}" for your review.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Review Task",
        actionPath: taskUrl(taskId),
    });
}

function taskApprovedEmail({ taskTitle, taskNumber, projectName, actorName, taskId }) {
    return wrapEmail({
        eventTitle: "Task approved and closed",
        description: `${actorName} approved and closed "${taskTitle}".`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

function taskSentBackEmail({ taskTitle, taskNumber, projectName, actorName, taskId }) {
    return wrapEmail({
        eventTitle: "Task sent back for changes",
        description: `${actorName} sent "${taskTitle}" back for changes.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

// ==========================================
// SPRINT ASSIGNMENT
// ==========================================

function taskSprintChangedEmail({ taskTitle, taskNumber, projectName, sprintChangeText, taskId }) {
    return wrapEmail({
        eventTitle: "Sprint assignment updated",
        description: `Your task "${taskTitle}" was ${sprintChangeText}.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

// ==========================================
// DUE SOON / OVERDUE
// ==========================================

function taskDueSoonEmail({ taskTitle, taskNumber, projectName, dueDateLabel, taskId }) {
    return wrapEmail({
        eventTitle: "Task due soon",
        description: `"${taskTitle}" is due on ${dueDateLabel}.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

function taskOverdueEmail({ taskTitle, taskNumber, projectName, dueDateLabel, taskId }) {
    return wrapEmail({
        eventTitle: "Task overdue",
        description: `"${taskTitle}" was due on ${dueDateLabel} and is still open.`,
        detailLines: [
            `Task: #${taskNumber} ${taskTitle}`,
            projectName ? `Project: ${projectName}` : "Project: Unassigned (legacy task)",
        ],
        actionLabel: "Open Task",
        actionPath: taskUrl(taskId),
    });
}

module.exports = {
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
