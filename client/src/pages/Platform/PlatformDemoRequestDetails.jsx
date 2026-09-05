import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { FaArrowLeft } from "react-icons/fa";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";

// ==========================================
// DEMO REQUEST DETAILS (Phase 7)
//
// GET /api/platform/demo-requests/:id -- full lead details (adds
// `message`, which the list view omits). The status selector below
// PATCHes only { status } -- there is no form field or code path
// here that could send any other property to the backend.
// ==========================================

const STATUSES = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "closed", label: "Closed" },
];

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function PlatformDemoRequestDetails() {
  const { id } = useParams();

  const [demoRequest, setDemoRequest] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadDemoRequest = async () => {
    try {
      setLoading(true);
      const response = await platformApi.get(`/demo-requests/${id}`);
      setDemoRequest(response.data.demoRequest);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load demo request.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDemoRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleStatusChange = async (status) => {
    if (status === demoRequest.status) return;

    try {
      setActionLoading(true);
      const response = await platformApi.patch(`/demo-requests/${id}/status`, { status });
      setDemoRequest(response.data.demoRequest);
      toast.success(`Marked as ${status}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update status.");
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return <div className="platform-page"><div className="platform-empty-state">Loading demo request...</div></div>;
  }

  if (error || !demoRequest) {
    return (
      <div className="platform-page">
        <div className="platform-alert platform-alert-danger">{error || "Demo request not found."}</div>
      </div>
    );
  }

  return (
    <div className="platform-page">

      <Link to="/platform/demo-requests" className="platform-back-link">
        <FaArrowLeft /> Back to Demo Requests
      </Link>

      <div className="platform-page-header">
        <div>
          <h1>{demoRequest.name}</h1>
          <p>{demoRequest.companyName}</p>
        </div>
        <span className={`platform-badge status-${demoRequest.status}`}>{demoRequest.status}</span>
      </div>

      <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
        <div className="platform-result-box" style={{ background: "transparent", border: "none", padding: 0 }}>
          <div className="platform-result-row"><span>Email</span><span>{demoRequest.email}</span></div>
          <div className="platform-result-row"><span>Phone</span><span>{demoRequest.phone || "—"}</span></div>
          <div className="platform-result-row"><span>Employee Count</span><span>{demoRequest.employeeCount || "—"}</span></div>
          <div className="platform-result-row"><span>Requested</span><span>{formatDate(demoRequest.createdAt)}</span></div>
        </div>

        {demoRequest.message && (
          <div style={{ marginTop: 18, paddingTop: 18, borderTop: "1px solid var(--p-border)" }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--p-text-secondary)", marginBottom: 6 }}>Message</div>
            <p style={{ fontSize: 14, color: "var(--p-text)", lineHeight: 1.6, margin: 0, whiteSpace: "pre-wrap" }}>{demoRequest.message}</p>
          </div>
        )}
      </div>

      <div className="platform-card" style={{ padding: 24 }}>
        <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Status</h2>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {STATUSES.map((option) => (
            <button
              key={option.value}
              className={`platform-btn ${demoRequest.status === option.value ? "platform-btn-primary" : "platform-btn-outline"}`}
              onClick={() => handleStatusChange(option.value)}
              disabled={actionLoading || demoRequest.status === option.value}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

    </div>
  );
}

export default PlatformDemoRequestDetails;
