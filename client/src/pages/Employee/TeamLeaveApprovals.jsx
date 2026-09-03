import { useEffect, useState } from "react";

import { FaCheck, FaTimes } from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./MyTeam.css";

function getCurrentUser() {
  try {
    return JSON.parse(sessionStorage.getItem("user"));
  } catch {
    return null;
  }
}

// ==========================================
// TEAM LEAVE APPROVALS
//
// Two independent sections:
//
// 1. "Pending my approval as reporting manager"
//    — visible to EVERYONE, since any employee
//    or intern could have direct reports pointing
//    at them regardless of their system_access
//    label. Backend already scopes this to only
//    requests where manager_id === requester.
//
// 2. "Final approval queue" — only rendered for
//    Super Admin/Admin/HR/Executive (system_access),
//    since none of these can reach the Admin
//    portal's own Leave Management page (that
//    page is gated on role==='admin', and they
//    are role='employee'). This is what gives HR
//    and Executive (Founder/Chairman) a real
//    place to do final approval.
//
// Task transfers no longer go through an approval
// workflow (see taskManagementController.js —
// transfer is now direct-only), so the section
// that used to live here has been removed.
// ==========================================

function TeamLeaveApprovals() {

  const user = getCurrentUser();

  const canFinalApprove = ["super_admin", "admin", "hr", "executive"].includes(user?.systemAccess);

  const [managerQueue, setManagerQueue] = useState([]);
  const [finalQueue, setFinalQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processingId, setProcessingId] = useState(null);

  const load = async () => {
    try {
      setLoading(true);

      const requests = [api.get("/leaves/manager/pending")];

      if (canFinalApprove) {
        requests.push(api.get("/leaves/admin/pending-final"));
      }

      const responses = await Promise.all(requests);

      setManagerQueue(responses[0].data.leaves || []);

      if (canFinalApprove) {
        setFinalQueue(responses[1].data.leaves || []);
      }

    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load leave approvals");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleManagerDecision = async (leaveId, decision) => {

    let comment = null;

    if (decision === "rejected") {
      comment = window.prompt("Optional: enter a reason for rejecting this request");
      if (comment === null) return;
    }

    try {
      setProcessingId(leaveId);

      await api.patch(`/leaves/manager/${leaveId}/decide`, { decision, comment });

      toast.success(decision === "approved" ? "Approved and sent for final approval" : "Request rejected");

      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to record your decision");
    } finally {
      setProcessingId(null);
    }
  };

  const handleFinalDecision = async (leaveId, decision) => {

    const comment = window.prompt(
      decision === "approved" ? "Optional comment" : "Optional reason for rejecting"
    );

    if (comment === null) return;

    try {
      setProcessingId(leaveId);

      await api.patch(`/leaves/admin/${leaveId}/${decision === "approved" ? "approve" : "reject"}`, {
        adminComment: comment,
      });

      toast.success(decision === "approved" ? "Leave approved" : "Leave rejected");

      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to record final decision");
    } finally {
      setProcessingId(null);
    }
  };

  const formatDate = (value) => {
    if (!value) return "--";
    return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  };

  return (

    <div className="employee-page-content">

      <section className="my-team-card">

        <div className="my-team-header">
          <h2>Pending My Approval</h2>
          <p>Leave requests from your direct reports, awaiting your decision.</p>
        </div>

        {loading ? (
          <div className="my-team-empty">Loading...</div>
        ) : managerQueue.length === 0 ? (
          <div className="my-team-empty">Nothing is waiting on your approval right now.</div>
        ) : (
          <div className="leave-approval-list">
            {managerQueue.map((leave) => (
              <div className="leave-approval-row" key={leave.id}>
                <div className="leave-approval-info">
                  <strong>{leave.full_name} ({leave.employee_id})</strong>
                  <span>{leave.leave_type} · {formatDate(leave.from_date)} → {formatDate(leave.to_date)}</span>
                  <span className="leave-approval-reason">{leave.reason}</span>
                </div>
                <div className="leave-approval-actions">
                  <button
                    type="button"
                    className="leave-approve-button"
                    disabled={processingId === leave.id}
                    onClick={() => handleManagerDecision(leave.id, "approved")}
                  >
                    <FaCheck /> Approve
                  </button>
                  <button
                    type="button"
                    className="leave-reject-button"
                    disabled={processingId === leave.id}
                    onClick={() => handleManagerDecision(leave.id, "rejected")}
                  >
                    <FaTimes /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

      </section>

      {canFinalApprove && (

        <section className="my-team-card">

          <div className="my-team-header">
            <h2>Final Approval Queue</h2>
            <p>Requests already approved by their reporting manager (or with no manager on file), awaiting final decision.</p>
          </div>

          {loading ? (
            <div className="my-team-empty">Loading...</div>
          ) : finalQueue.length === 0 ? (
            <div className="my-team-empty">Nothing is waiting on final approval right now.</div>
          ) : (
            <div className="leave-approval-list">
              {finalQueue.map((leave) => (
                <div className="leave-approval-row" key={leave.id}>
                  <div className="leave-approval-info">
                    <strong>{leave.full_name} ({leave.employee_id})</strong>
                    <span>{leave.leave_type} · {formatDate(leave.from_date)} → {formatDate(leave.to_date)}</span>
                    <span className="leave-approval-reason">{leave.reason}</span>
                    {leave.manager_name && (
                      <span className="leave-approval-manager">
                        Manager decision: {leave.manager_decision} by {leave.manager_name}
                        {leave.manager_comment ? ` — "${leave.manager_comment}"` : ""}
                      </span>
                    )}
                  </div>
                  <div className="leave-approval-actions">
                    <button
                      type="button"
                      className="leave-approve-button"
                      disabled={processingId === leave.id}
                      onClick={() => handleFinalDecision(leave.id, "approved")}
                    >
                      <FaCheck /> Approve
                    </button>
                    <button
                      type="button"
                      className="leave-reject-button"
                      disabled={processingId === leave.id}
                      onClick={() => handleFinalDecision(leave.id, "rejected")}
                    >
                      <FaTimes /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

        </section>

      )}

    </div>

  );

}

export default TeamLeaveApprovals;
