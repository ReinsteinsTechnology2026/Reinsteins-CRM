import { useEffect, useState } from "react";
import { toast } from "react-toastify";


import api from "../../services/api";

import "./AdminLeave.css";

function AdminLeave() {
  const [leaves, setLeaves] = useState([]);

  const [summary, setSummary] = useState({
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0,
  });

  const [loading, setLoading] = useState(true);

  const [processingId, setProcessingId] =
    useState(null);

  // ==========================================
  // LOAD ALL LEAVE REQUESTS
  // ==========================================

  const loadLeaves = async () => {
    try {
      const response = await api.get(
        "/leaves/admin/all"
      );

      setLeaves(
        response.data.leaves || []
      );

      setSummary(
        response.data.summary || {
          total: 0,
          pending: 0,
          approved: 0,
          rejected: 0,
        }
      );
    } catch (error) {
      console.error(
        "Load admin leaves error:",
        error
      );

      toast.error(
        error.response?.data?.message ||
          "Unable to load leave requests"
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLeaves();
  }, []);

  // ==========================================
  // APPROVE LEAVE
  // ==========================================

  const handleApprove = async (leaveId) => {
    try {
      setProcessingId(leaveId);

      await api.patch(
        `/leaves/admin/${leaveId}/approve`,
        {
          adminComment:
            "Leave request approved",
        }
      );

      toast.success(
        "Leave request approved"
      );

      await loadLeaves();
    } catch (error) {
      console.error(
        "Approve leave error:",
        error
      );

      toast.error(
        error.response?.data?.message ||
          "Unable to approve leave"
      );
    } finally {
      setProcessingId(null);
    }
  };

  // ==========================================
  // REJECT LEAVE
  // ==========================================

  const handleReject = async (leaveId) => {
    const comment = window.prompt(
      "Enter reason for rejecting this leave request:"
    );

    if (comment === null) {
      return;
    }

    try {
      setProcessingId(leaveId);

      await api.patch(
        `/leaves/admin/${leaveId}/reject`,
        {
          adminComment:
            comment.trim() ||
            "Leave request rejected",
        }
      );

      toast.success(
        "Leave request rejected"
      );

      await loadLeaves();
    } catch (error) {
      console.error(
        "Reject leave error:",
        error
      );

      toast.error(
        error.response?.data?.message ||
          "Unable to reject leave"
      );
    } finally {
      setProcessingId(null);
    }
  };

  // ==========================================
  // FORMAT DATE
  // ==========================================

  const formatDate = (value) => {
    if (!value) {
      return "--";
    }

    return new Date(
      value
    ).toLocaleDateString(
      "en-IN",
      {
        day: "2-digit",
        month: "short",
        year: "numeric",
      }
    );
  };

  // ==========================================
  // FORMAT LEAVE TYPE
  // ==========================================

  const formatLeaveType = (type) => {
    const types = {
      casual: "Casual Leave",
      sick: "Sick Leave",
      earned: "Earned Leave",
      unpaid: "Unpaid Leave",
      other: "Other",
    };

    return types[type] || type;
  };

  // ==========================================
  // FORMAT STATUS (two-stage workflow)
  // ==========================================

  const formatStatus = (status) => {
    const statuses = {
      pending_manager: "Pending Manager Approval",
      pending_final: "Pending Final Approval",
      manager_rejected: "Rejected by Manager",
      approved: "Approved",
      rejected: "Rejected",
      cancelled: "Cancelled",
    };

    return statuses[status] || status;
  };

 return (
<>

    <div className="admin-page-content">

          <div className="admin-leave-title">

            <div>
              <h1>
                Leave Management
              </h1>

              <p>
                Review and manage employee
                leave requests
              </p>
            </div>

          </div>

          {/* SUMMARY CARDS */}

          <div className="leave-summary-grid">

            <div className="leave-summary-card">
              <span>
                Total Requests
              </span>

              <strong>
                {summary.total}
              </strong>
            </div>

            <div className="leave-summary-card pending">
              <span>
                Pending
              </span>

              <strong>
                {summary.pending}
              </strong>
            </div>

            <div className="leave-summary-card approved">
              <span>
                Approved
              </span>

              <strong>
                {summary.approved}
              </strong>
            </div>

            <div className="leave-summary-card rejected">
              <span>
                Rejected
              </span>

              <strong>
                {summary.rejected}
              </strong>
            </div>

          </div>

          {/* LEAVE REQUEST TABLE */}

          <section className="admin-leave-card">

            <div className="admin-leave-card-header">

              <h2>
                Employee Leave Requests
              </h2>

              <p>
                Approve or reject employee
                leave applications
              </p>

            </div>

            {loading ? (

              <div className="admin-leave-message">
                Loading leave requests...
              </div>

            ) : leaves.length === 0 ? (

              <div className="admin-leave-message">
                No leave requests available.
              </div>

            ) : (

              <div className="admin-leave-table-wrapper">

                <table className="admin-leave-table">

                  <thead>

                    <tr>
                      <th>Employee</th>
                      <th>Employee ID</th>
                      <th>Leave Type</th>
                      <th>From</th>
                      <th>To</th>
                      <th>Reason</th>
                      <th>Status</th>
                      <th>Manager Comment</th>
                      <th>Final Comment</th>
                      <th>Action</th>
                    </tr>

                  </thead>

                  <tbody>

                    {leaves.map((leave) => (

                      <tr key={leave.id}>

                        <td className="leave-employee-name">
                          {leave.full_name}
                        </td>

                        <td>
                          {leave.employee_id}
                        </td>

                        <td>
                          {formatLeaveType(
                            leave.leave_type
                          )}
                        </td>

                        <td>
                          {formatDate(
                            leave.from_date
                          )}
                        </td>

                        <td>
                          {formatDate(
                            leave.to_date
                          )}
                        </td>

                        <td className="admin-leave-reason">
                          {leave.reason}
                        </td>

                        <td>

                          <span
                            className={`admin-leave-status ${leave.status}`}
                          >
                            {formatStatus(leave.status)}
                          </span>

                        </td>

                        <td>
                          {leave.manager_comment ||
                            "--"}
                        </td>

                        <td>
                          {leave.admin_comment ||
                            "--"}
                        </td>

                        <td>

                          {leave.status ===
                          "pending_final" ? (

                            <div className="leave-action-buttons">

                              <button
                                className="approve-leave-button"
                                disabled={
                                  processingId ===
                                  leave.id
                                }
                                onClick={() =>
                                  handleApprove(
                                    leave.id
                                  )
                                }
                              >
                                Approve
                              </button>

                              <button
                                className="reject-leave-button"
                                disabled={
                                  processingId ===
                                  leave.id
                                }
                                onClick={() =>
                                  handleReject(
                                    leave.id
                                  )
                                }
                              >
                                Reject
                              </button>

                            </div>

                          ) : (

                            <span className="leave-action-completed">
                              Reviewed
                            </span>

                          )}

                        </td>

                      </tr>

                    ))}

                  </tbody>

                </table>

              </div>

            )}

          </section>

        </div>

      </> 

    
  );
}

export default AdminLeave;