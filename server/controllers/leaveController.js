const pool = require("../config/db");
const { createNotification } = require("../services/notificationService");

// ==========================================
// LEAVE APPROVAL WORKFLOW
//
// Employee/Intern submits
//         ↓
// If they have a reporting_manager_id:
//   status = 'pending_manager'
// Else (no manager on file — e.g. rollout day
// one, or a top-of-org person):
//   status = 'pending_final'
//         ↓
// Manager approves -> 'pending_final'
// Manager rejects  -> 'manager_rejected' (ends here)
//         ↓
// Admin/HR final decision -> 'approved' / 'rejected'
//
// manager_id is SNAPSHOTTED on the request at
// submission time — later reporting-manager
// changes never retroactively change who was
// responsible for a decision already made (or
// pending) on an existing request.
//
// Notifications reuse the existing notifications
// table + the existing Socket.IO "notification:new"
// pattern (same convention as chat/task mentions).
// ==========================================

// ==========================================
// NOTIFICATION HELPERS
// ==========================================

async function notifySingleUser(req, userId, title, message, type, referenceType, referenceId) {

    await createNotification({
        req,
        userId,
        title,
        message,
        type,
        referenceType: referenceType || null,
        referenceId: referenceId || null,
    });

}

// Notifies every active Admin/Super Admin/HR — used when a request
// reaches "pending_final" and there isn't one single obvious
// recipient (there can be several final approvers).

async function notifyFinalApprovers(req, { title, message, referenceId }) {

    const [approvers] = await pool.query(
        `
        SELECT id FROM users
        WHERE employment_status = 'active'
        AND (role = 'admin' OR system_access IN ('super_admin', 'admin', 'hr'))
        `
    );

    for (const approver of approvers) {
        // eslint-disable-next-line no-await-in-loop
        await notifySingleUser(req, approver.id, title, message, "leave_pending_final", "leave", referenceId);
    }

}

// ==========================================
// EMPLOYEE/INTERN - APPLY FOR LEAVE
// ==========================================

const applyLeave = async (req, res) => {
    try {

        const userId = req.user.id;

        const { leaveType, fromDate, toDate, reason } = req.body;

        if (!leaveType || !fromDate || !toDate || !reason?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Leave type, dates and reason are required",
            });
        }

        if (new Date(toDate) < new Date(fromDate)) {
            return res.status(400).json({
                success: false,
                message: "To date cannot be before from date",
            });
        }

        const [existingLeaves] = await pool.query(
            `
            SELECT id FROM leave_requests
            WHERE user_id = ?
            AND status IN ('pending_manager', 'pending_final', 'approved')
            AND from_date <= ?
            AND to_date >= ?
            LIMIT 1
            `,
            [userId, toDate, fromDate]
        );

        if (existingLeaves.length > 0) {
            return res.status(400).json({
                success: false,
                message: "You already have a pending or approved leave request for these dates",
            });
        }

        const [userRows] = await pool.query(
            `SELECT reporting_manager_id, full_name FROM users WHERE id = ? LIMIT 1`,
            [userId]
        );

        const managerId = userRows[0]?.reporting_manager_id || null;
        const requesterName = userRows[0]?.full_name || "An employee";
        const initialStatus = managerId ? "pending_manager" : "pending_final";

        const [result] = await pool.query(
            `
            INSERT INTO leave_requests
            (user_id, manager_id, leave_type, from_date, to_date, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            `,
            [userId, managerId, leaveType, fromDate, toDate, reason.trim(), initialStatus]
        );

        if (managerId) {
            await notifySingleUser(
                req,
                managerId,
                "New Leave Request",
                `${requesterName} submitted a ${leaveType} leave request from ${fromDate} to ${toDate}, awaiting your approval.`,
                "leave_pending_manager",
                "leave",
                result.insertId
            );
        } else {
            await notifyFinalApprovers(req, {
                title: "New Leave Request",
                message: `${requesterName} submitted a ${leaveType} leave request from ${fromDate} to ${toDate} (no reporting manager on file) — awaiting final approval.`,
                referenceId: result.insertId,
            });
        }

        return res.status(201).json({
            success: true,
            message: "Leave request submitted successfully",
            leaveId: result.insertId,
        });

    } catch (error) {
        console.error("Apply Leave Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to submit leave request",
        });
    }
};

// ==========================================
// EMPLOYEE/INTERN - GET MY LEAVE REQUESTS
// ==========================================

const getMyLeaves = async (req, res) => {
    try {

        const userId = req.user.id;

        const [leaves] = await pool.query(
            `
            SELECT
                l.id,
                l.leave_type,
                l.from_date,
                l.to_date,
                l.reason,
                l.status,
                l.manager_id,
                manager.full_name AS manager_name,
                l.manager_decision,
                l.manager_comment,
                l.manager_decided_at,
                l.admin_comment,
                l.final_decided_by,
                finalApprover.full_name AS final_decided_by_name,
                l.final_decided_at,
                l.created_at,
                l.updated_at
            FROM leave_requests l
            LEFT JOIN users manager ON manager.id = l.manager_id
            LEFT JOIN users finalApprover ON finalApprover.id = l.final_decided_by
            WHERE l.user_id = ?
            ORDER BY l.created_at DESC
            `,
            [userId]
        );

        return res.status(200).json({
            success: true,
            leaves,
        });

    } catch (error) {
        console.error("Get My Leaves Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load leave requests",
        });
    }
};

// ==========================================
// EMPLOYEE/INTERN - CANCEL MY OWN LEAVE
// Only while still pending (either stage) —
// once a final/manager decision has been made,
// the record is left as an accurate history.
// ==========================================

const cancelLeave = async (req, res) => {
    try {

        const userId = req.user.id;
        const leaveId = req.params.id;

        const [leaves] = await pool.query(
            `SELECT id, user_id, status FROM leave_requests WHERE id = ? LIMIT 1`,
            [leaveId]
        );

        if (leaves.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Leave request not found",
            });
        }

        if (Number(leaves[0].user_id) !== Number(userId)) {
            return res.status(403).json({
                success: false,
                message: "You can only cancel your own leave request",
            });
        }

        if (!["pending_manager", "pending_final"].includes(leaves[0].status)) {
            return res.status(400).json({
                success: false,
                message: "Only pending leave requests can be cancelled",
            });
        }

        await pool.query(
            `UPDATE leave_requests SET status = 'cancelled' WHERE id = ?`,
            [leaveId]
        );

        return res.status(200).json({
            success: true,
            message: "Leave request cancelled",
        });

    } catch (error) {
        console.error("Cancel Leave Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to cancel leave request",
        });
    }
};

// ==========================================
// MANAGER - PENDING APPROVALS FOR MY DIRECT REPORTS
// ==========================================

const getPendingManagerApprovals = async (req, res) => {
    try {

        const [leaves] = await pool.query(
            `
            SELECT
                l.id,
                l.leave_type,
                l.from_date,
                l.to_date,
                l.reason,
                l.status,
                l.created_at,
                u.id AS user_id,
                u.employee_id,
                u.full_name,
                u.designation,
                u.employment_type
            FROM leave_requests l
            INNER JOIN users u ON u.id = l.user_id
            WHERE l.manager_id = ?
            AND l.status = 'pending_manager'
            ORDER BY l.created_at ASC
            `,
            [req.user.id]
        );

        return res.status(200).json({
            success: true,
            leaves,
        });

    } catch (error) {
        console.error("Get Pending Manager Approvals Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load pending approvals",
        });
    }
};

// ==========================================
// MANAGER - APPROVE / REJECT (stage 1)
// ==========================================

const managerDecideLeave = async (req, res) => {
    try {

        const leaveId = req.params.id;
        const { decision, comment } = req.body;

        if (!["approved", "rejected"].includes(decision)) {
            return res.status(400).json({
                success: false,
                message: "Invalid decision",
            });
        }

        const [leaves] = await pool.query(
            `SELECT id, user_id, manager_id, leave_type, status FROM leave_requests WHERE id = ? LIMIT 1`,
            [leaveId]
        );

        if (leaves.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Leave request not found",
            });
        }

        const leave = leaves[0];

        if (Number(leave.manager_id) !== Number(req.user.id)) {
            return res.status(403).json({
                success: false,
                message: "You are not the assigned reporting manager for this request",
            });
        }

        // Structurally shouldn't be reachable (a reporting manager
        // can never equal the requester per validateReportingManagerAssignment's
        // self-reporting check) — kept as a defensive backend check
        // regardless, per "Manager cannot approve their own leave."

        if (Number(leave.user_id) === Number(req.user.id)) {
            return res.status(403).json({
                success: false,
                message: "You cannot approve your own leave request",
            });
        }

        if (leave.status !== "pending_manager") {
            return res.status(400).json({
                success: false,
                message: "This request is not awaiting manager approval",
            });
        }

        const cleanedComment = comment?.trim() || null;
        const newStatus = decision === "approved" ? "pending_final" : "manager_rejected";

        await pool.query(
            `
            UPDATE leave_requests
            SET status = ?, manager_decision = ?, manager_comment = ?, manager_decided_at = NOW()
            WHERE id = ?
            `,
            [newStatus, decision, cleanedComment, leaveId]
        );

        if (decision === "approved") {

            await notifyFinalApprovers(req, {
                title: "Leave Awaiting Final Approval",
                message: `A ${leave.leave_type} leave request has been approved by the reporting manager and now needs final approval.`,
                referenceId: leaveId,
            });

            await notifySingleUser(
                req,
                leave.user_id,
                "Leave Approved by Manager",
                `Your ${leave.leave_type} leave request was approved by your reporting manager and is now pending final approval.`,
                "leave_manager_approved",
                "leave",
                leaveId
            );

        } else {

            await notifySingleUser(
                req,
                leave.user_id,
                "Leave Request Rejected",
                `Your ${leave.leave_type} leave request was rejected by your reporting manager.` +
                    (cleanedComment ? ` Comment: ${cleanedComment}` : ""),
                "leave_rejected",
                "leave",
                leaveId
            );

        }

        return res.status(200).json({
            success: true,
            message: decision === "approved"
                ? "Leave approved and sent for final approval"
                : "Leave request rejected",
        });

    } catch (error) {
        console.error("Manager Decide Leave Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to record your decision",
        });
    }
};

// ==========================================
// ADMIN/HR - GET ALL LEAVE REQUESTS (overview,
// every status — unchanged purpose from before,
// just carries the new columns too)
// ==========================================

const getAllLeaves = async (req, res) => {
    try {
        const [leaves] = await pool.query(
            `
            SELECT
                l.id,
                l.leave_type,
                l.from_date,
                l.to_date,
                l.reason,
                l.status,
                l.manager_id,
                manager.full_name AS manager_name,
                l.manager_decision,
                l.manager_comment,
                l.manager_decided_at,
                l.admin_comment,
                l.final_decided_by,
                finalApprover.full_name AS final_decided_by_name,
                l.final_decided_at,
                l.created_at,
                l.updated_at,

                u.id AS user_id,
                u.employee_id,
                u.full_name,
                u.email

            FROM leave_requests l

            INNER JOIN users u
                ON l.user_id = u.id

            LEFT JOIN users manager ON manager.id = l.manager_id
            LEFT JOIN users finalApprover ON finalApprover.id = l.final_decided_by

            WHERE
                u.role = 'employee'

            ORDER BY
                CASE
                    WHEN l.status IN ('pending_manager', 'pending_final') THEN 0
                    WHEN l.status = 'approved' THEN 1
                    ELSE 2
                END,

                l.created_at DESC
            `
        );

        const pending = leaves.filter((leave) => ["pending_manager", "pending_final"].includes(leave.status)).length;
        const approved = leaves.filter((leave) => leave.status === "approved").length;
        const rejected = leaves.filter((leave) => ["rejected", "manager_rejected"].includes(leave.status)).length;

        return res.status(200).json({
            success: true,

            summary: {
                total: leaves.length,
                pending,
                approved,
                rejected,
            },

            leaves,
        });
    } catch (error) {
        console.error("Get All Leaves Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load leave requests",
        });
    }
};

// ==========================================
// ADMIN/HR - PENDING FINAL APPROVAL QUEUE
// ==========================================

const getPendingFinalApprovals = async (req, res) => {
    try {

        const [leaves] = await pool.query(
            `
            SELECT
                l.id,
                l.leave_type,
                l.from_date,
                l.to_date,
                l.reason,
                l.manager_decision,
                l.manager_comment,
                l.created_at,
                u.id AS user_id,
                u.employee_id,
                u.full_name,
                u.designation,
                manager.full_name AS manager_name
            FROM leave_requests l
            INNER JOIN users u ON u.id = l.user_id
            LEFT JOIN users manager ON manager.id = l.manager_id
            WHERE l.status = 'pending_final'
            ORDER BY l.created_at ASC
            `
        );

        return res.status(200).json({
            success: true,
            leaves,
        });

    } catch (error) {
        console.error("Get Pending Final Approvals Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load pending final approvals",
        });
    }
};

// ==========================================
// ADMIN/HR - FINAL APPROVE
// ==========================================

const approveLeave = async (req, res) => {
    try {
        const leaveId = req.params.id;

        const { adminComment } = req.body;

        const [leaves] = await pool.query(
            `SELECT id, user_id, leave_type, status FROM leave_requests WHERE id = ? LIMIT 1`,
            [leaveId]
        );

        if (leaves.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Leave request not found",
            });
        }

        const leave = leaves[0];

        if (leave.status !== "pending_final") {
            return res.status(400).json({
                success: false,
                message: "Only requests awaiting final approval can be approved",
            });
        }

        await pool.query(
            `
            UPDATE leave_requests
            SET status = 'approved', admin_comment = ?, final_decided_by = ?, final_decided_at = NOW()
            WHERE id = ?
            `,
            [adminComment?.trim() || null, req.user.id, leaveId]
        );

        const notificationMessage = adminComment?.trim()
            ? `Your ${leave.leave_type} leave request has been approved. Comment: ${adminComment.trim()}`
            : `Your ${leave.leave_type} leave request has been approved.`;

        await notifySingleUser(req, leave.user_id, "Leave Request Approved", notificationMessage, "leave_approved", "leave", leaveId);

        return res.status(200).json({
            success: true,
            message: "Leave request approved and employee notified",
        });
    } catch (error) {
        console.error("Approve Leave Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to approve leave request",
        });
    }
};

// ==========================================
// ADMIN/HR - FINAL REJECT
// ==========================================

const rejectLeave = async (req, res) => {
    try {
        const leaveId = req.params.id;

        const { adminComment } = req.body;

        const [leaves] = await pool.query(
            `SELECT id, user_id, leave_type, status FROM leave_requests WHERE id = ? LIMIT 1`,
            [leaveId]
        );

        if (leaves.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Leave request not found",
            });
        }

        const leave = leaves[0];

        if (leave.status !== "pending_final") {
            return res.status(400).json({
                success: false,
                message: "Only requests awaiting final approval can be rejected",
            });
        }

        await pool.query(
            `
            UPDATE leave_requests
            SET status = 'rejected', admin_comment = ?, final_decided_by = ?, final_decided_at = NOW()
            WHERE id = ?
            `,
            [adminComment?.trim() || null, req.user.id, leaveId]
        );

        const notificationMessage = adminComment?.trim()
            ? `Your ${leave.leave_type} leave request has been rejected. Comment: ${adminComment.trim()}`
            : `Your ${leave.leave_type} leave request has been rejected.`;

        await notifySingleUser(req, leave.user_id, "Leave Request Rejected", notificationMessage, "leave_rejected", "leave", leaveId);

        return res.status(200).json({
            success: true,
            message: "Leave request rejected and employee notified",
        });
    } catch (error) {
        console.error("Reject Leave Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to reject leave request",
        });
    }
};

module.exports = {
    applyLeave,
    getMyLeaves,
    cancelLeave,
    getPendingManagerApprovals,
    managerDecideLeave,
    getAllLeaves,
    getPendingFinalApprovals,
    approveLeave,
    rejectLeave,
};
