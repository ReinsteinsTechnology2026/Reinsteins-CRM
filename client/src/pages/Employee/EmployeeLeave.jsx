import {
  useEffect,
  useState,
} from "react";


import {
  FaPaperPlane,
  FaBan,
} from "react-icons/fa";

import {
  toast,
} from "react-toastify";

import api from "../../services/api";



import "./EmployeeLeave.css";

function EmployeeLeave() {


  // ==========================================
  // LOGGED-IN USER
  // ==========================================

  const storedUser =
    localStorage.getItem(
      "user"
    );

  let user = null;

  try {
    user =
      storedUser
        ? JSON.parse(
            storedUser
          )
        : null;
  } catch (error) {
    console.error(
      "Unable to read user:",
      error
    );
  }

  // ==========================================
  // STATE
  // ==========================================

  const [
    leaves,
    setLeaves,
  ] = useState([]);

  const [
    leaveType,
    setLeaveType,
  ] = useState(
    "casual"
  );

  const [
    fromDate,
    setFromDate,
  ] = useState("");

  const [
    toDate,
    setToDate,
  ] = useState("");

  const [
    reason,
    setReason,
  ] = useState("");

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    submitting,
    setSubmitting,
  ] = useState(false);

  // ==========================================
  // CANCEL LEAVE
  // Only these two statuses are still awaiting a
  // decision on the backend (leaveController.js
  // cancelLeave) — once a manager or final
  // decision has been recorded, the request is
  // left as accurate history and can no longer be
  // cancelled. The backend enforces this exact
  // same rule independently, so hiding the button
  // here is a UX convenience, not the real guard.
  // ==========================================

  const CANCELLABLE_STATUSES = [
    "pending_manager",
    "pending_final",
  ];

  const [
    cancelTarget,
    setCancelTarget,
  ] = useState(null);

  const [
    cancelling,
    setCancelling,
  ] = useState(false);

  // ==========================================
  // LOAD MY LEAVE REQUESTS
  // ==========================================

  const loadLeaves =
    async () => {
      try {
        setLoading(
          true
        );

        const response =
          await api.get(
            "/leaves/my"
          );

        setLeaves(
          response.data
            ?.leaves ||
            []
        );

      } catch (error) {
        console.error(
          "Load leaves error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to load leave requests"
        );

      } finally {
        setLoading(
          false
        );
      }
    };

  // ==========================================
  // LOAD LEAVES ON PAGE OPEN
  // ==========================================

  useEffect(() => {
    loadLeaves();
  }, []);

  // ==========================================
  // APPLY FOR LEAVE
  // ==========================================

  const handleSubmit =
    async (event) => {
      event.preventDefault();

      if (
        !fromDate ||
        !toDate
      ) {
        toast.error(
          "Please select leave dates"
        );

        return;
      }

      if (
        !reason.trim()
      ) {
        toast.error(
          "Please enter your leave reason"
        );

        return;
      }

      if (
        new Date(
          toDate
        ) <
        new Date(
          fromDate
        )
      ) {
        toast.error(
          "To date cannot be before from date"
        );

        return;
      }

      try {
        setSubmitting(
          true
        );

        await api.post(
          "/leaves",
          {
            leaveType,
            fromDate,
            toDate,
            reason,
          }
        );

        toast.success(
          "Leave request submitted successfully"
        );

        setLeaveType(
          "casual"
        );

        setFromDate("");

        setToDate("");

        setReason("");

        await loadLeaves();

      } catch (error) {
        console.error(
          "Apply leave error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to submit leave request"
        );

      } finally {
        setSubmitting(
          false
        );
      }
    };

  // ==========================================
  // CONFIRM CANCEL LEAVE
  // Reuses the existing PATCH /leaves/:id/cancel
  // endpoint — no new backend route. The backend
  // re-validates ownership and status itself, so
  // this can never cancel someone else's request
  // or a request that has already moved past the
  // pending stages, regardless of what this UI
  // shows.
  // ==========================================

  const handleConfirmCancel =
    async () => {
      if (!cancelTarget) {
        return;
      }

      try {
        setCancelling(
          true
        );

        await api.patch(
          `/leaves/${cancelTarget.id}/cancel`
        );

        toast.success(
          "Leave request cancelled"
        );

        setCancelTarget(
          null
        );

        await loadLeaves();

      } catch (error) {
        console.error(
          "Cancel leave error:",
          error
        );

        toast.error(
          error.response
            ?.data
            ?.message ||
            "Unable to cancel leave request"
        );

      } finally {
        setCancelling(
          false
        );
      }
    };

  // ==========================================
  // FORMAT DATE
  // ==========================================

  const formatDate = (
    value
  ) => {
    if (!value) {
      return "--";
    }

    return new Date(
      value
    ).toLocaleDateString(
      "en-IN",
      {
        day:
          "2-digit",

        month:
          "short",

        year:
          "numeric",
      }
    );
  };

  // ==========================================
  // FORMAT LEAVE TYPE
  // ==========================================

  const formatLeaveType = (
    type
  ) => {
    const types = {
      casual:
        "Casual Leave",

      sick:
        "Sick Leave",

      earned:
        "Earned Leave",

      unpaid:
        "Unpaid Leave",

      other:
        "Other",
    };

    return (
      types[type] ||
      type
    );
  };

  // ==========================================
  // FORMAT STATUS (two-stage workflow)
  // ==========================================

  const formatStatus = (
    status
  ) => {
    const statuses = {
      pending_manager:
        "Pending Manager Approval",

      pending_final:
        "Pending Final Approval",

      manager_rejected:
        "Rejected by Manager",

      approved:
        "Approved",

      rejected:
        "Rejected",

      cancelled:
        "Cancelled",
    };

    return (
      statuses[status] ||
      status
    );
  };

  // ==========================================
  // LOGOUT
  // ==========================================

 
  // ==========================================
  // PAGE
  // ==========================================

return (
<>

        {/* ====================================
            HEADER
        ==================================== */}

  

        {/* ====================================
            LEAVE CONTENT
        ==================================== */}

       <div className="employee-page-content"> 

          {/* ==================================
              APPLY FOR LEAVE
          ================================== */}

          <section className="leave-apply-card">

            <div className="leave-section-header">

              <h2>
                Apply for Leave
              </h2>

              <p>
                Submit a leave
                request for admin
                approval
              </p>

            </div>

            <form
              className="leave-form"
              onSubmit={
                handleSubmit
              }
            >

              {/* ==============================
                  LEAVE TYPE
              ============================== */}

              <div className="leave-form-group">

                <label>
                  Leave Type
                </label>

                <select
                  value={
                    leaveType
                  }
                  onChange={(
                    event
                  ) =>
                    setLeaveType(
                      event.target
                        .value
                    )
                  }
                >

                  <option value="casual">
                    Casual Leave
                  </option>

                  <option value="sick">
                    Sick Leave
                  </option>

                  <option value="earned">
                    Earned Leave
                  </option>

                  <option value="unpaid">
                    Unpaid Leave
                  </option>

                  <option value="other">
                    Other
                  </option>

                </select>

              </div>

              {/* ==============================
                  DATES
              ============================== */}

              <div className="leave-date-grid">

                <div className="leave-form-group">

                  <label>
                    From Date
                  </label>

                  <input
                    type="date"
                    value={
                      fromDate
                    }
                    onChange={(
                      event
                    ) =>
                      setFromDate(
                        event.target
                          .value
                      )
                    }
                  />

                </div>

                <div className="leave-form-group">

                  <label>
                    To Date
                  </label>

                  <input
                    type="date"
                    value={
                      toDate
                    }
                    min={
                      fromDate
                    }
                    onChange={(
                      event
                    ) =>
                      setToDate(
                        event.target
                          .value
                      )
                    }
                  />

                </div>

              </div>

              {/* ==============================
                  REASON
              ============================== */}

              <div className="leave-form-group">

                <label>
                  Reason for Leave
                </label>

                <textarea
                  rows="5"
                  placeholder="Explain the reason for your leave request..."
                  value={
                    reason
                  }
                  onChange={(
                    event
                  ) =>
                    setReason(
                      event.target
                        .value
                    )
                  }
                />

              </div>

              {/* ==============================
                  SUBMIT
              ============================== */}

              <button
                type="submit"
                className="leave-submit-button"
                disabled={
                  submitting
                }
              >

                <FaPaperPlane />

                {submitting
                  ? "Submitting..."
                  : "Submit Leave Request"}

              </button>

            </form>

          </section>

          {/* ==================================
              LEAVE HISTORY
          ================================== */}

          <section className="leave-history-card">

            <div className="leave-section-header">

              <h2>
                Leave History
              </h2>

              <p>
                View the status of
                your leave requests
              </p>

            </div>

            {/* LOADING */}

            {loading ? (

              <div className="leave-message">

                Loading leave
                requests...

              </div>

            ) : leaves.length ===
              0 ? (

              /* EMPTY */

              <div className="leave-message">

                You have not
                submitted any
                leave requests.

              </div>

            ) : (

              /* TABLE */

              <div className="leave-table-wrapper">

                <table className="leave-table">

                  <thead>

                    <tr>

                      <th>
                        Leave Type
                      </th>

                      <th>
                        From
                      </th>

                      <th>
                        To
                      </th>

                      <th>
                        Reason
                      </th>

                      <th>
                        Status
                      </th>

                      <th>
                        Manager Comment
                      </th>

                      <th>
                        Final Comment
                      </th>

                      <th>
                        Action
                      </th>

                    </tr>

                  </thead>

                  <tbody>

                    {leaves.map(
                      (
                        leave
                      ) => (

                        <tr
                          key={
                            leave.id
                          }
                        >

                          {/* LEAVE TYPE */}

                          <td>

                            {formatLeaveType(
                              leave
                                .leave_type
                            )}

                          </td>

                          {/* FROM DATE */}

                          <td>

                            {formatDate(
                              leave
                                .from_date
                            )}

                          </td>

                          {/* TO DATE */}

                          <td>

                            {formatDate(
                              leave
                                .to_date
                            )}

                          </td>

                          {/* REASON */}

                          <td className="leave-reason-cell">

                            {
                              leave
                                .reason
                            }

                          </td>

                          {/* STATUS */}

                          <td>

                            <span
                              className={`leave-status ${leave.status}`}
                            >

                              {formatStatus(
                                leave.status
                              )}

                            </span>

                          </td>

                          {/* MANAGER COMMENT */}

                          <td>

                            {
                              leave
                                .manager_comment ||
                              "--"
                            }

                          </td>

                          {/* FINAL COMMENT */}

                          <td>

                            {
                              leave
                                .admin_comment ||
                              "--"
                            }

                          </td>

                          {/* ACTION */}

                          <td>

                            {CANCELLABLE_STATUSES.includes(
                              leave.status
                            ) ? (

                              <button
                                type="button"
                                className="leave-cancel-button"
                                onClick={() =>
                                  setCancelTarget(
                                    leave
                                  )
                                }
                              >
                                <FaBan />
                                Cancel
                              </button>

                            ) : (

                              <span className="leave-action-none">
                                --
                              </span>

                            )}

                          </td>

                        </tr>

                      )
                    )}

                  </tbody>

                </table>

              </div>

            )}

          </section>

        </div>

        {/* ====================================
            CANCEL LEAVE CONFIRMATION MODAL
        ==================================== */}

        {cancelTarget && (

          <div className="leave-cancel-modal-overlay">

            <div className="leave-cancel-modal">

              <div className="leave-cancel-modal-header">
                <h2>Cancel Leave Request</h2>
              </div>

              <div className="leave-cancel-modal-body">

                <p className="leave-cancel-modal-question">
                  Are you sure you want to cancel this leave request?
                </p>

                <div className="leave-cancel-modal-details">

                  <div className="leave-cancel-modal-detail-row">
                    <span>Leave Type</span>
                    <strong>
                      {formatLeaveType(
                        cancelTarget.leave_type
                      )}
                    </strong>
                  </div>

                  <div className="leave-cancel-modal-detail-row">
                    <span>Start Date</span>
                    <strong>
                      {formatDate(
                        cancelTarget.from_date
                      )}
                    </strong>
                  </div>

                  <div className="leave-cancel-modal-detail-row">
                    <span>End Date</span>
                    <strong>
                      {formatDate(
                        cancelTarget.to_date
                      )}
                    </strong>
                  </div>

                  <div className="leave-cancel-modal-detail-row">
                    <span>Current Status</span>
                    <span
                      className={`leave-status ${cancelTarget.status}`}
                    >
                      {formatStatus(
                        cancelTarget.status
                      )}
                    </span>
                  </div>

                </div>

              </div>

              <div className="leave-cancel-modal-actions">

                <button
                  type="button"
                  className="leave-keep-button"
                  disabled={cancelling}
                  onClick={() =>
                    setCancelTarget(null)
                  }
                >
                  Keep Leave
                </button>

                <button
                  type="button"
                  className="leave-confirm-cancel-button"
                  disabled={cancelling}
                  onClick={handleConfirmCancel}
                >
                  {cancelling
                    ? "Cancelling..."
                    : "Cancel Leave Request"}
                </button>

              </div>

            </div>

          </div>

        )}

      </>


  );
}

export default EmployeeLeave;