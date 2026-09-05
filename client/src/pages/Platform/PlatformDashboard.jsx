import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  FaBuilding,
  FaCheckCircle,
  FaPauseCircle,
  FaHourglassHalf,
  FaGift,
  FaFlask,
  FaCrown,
  FaInbox,
  FaCalendarCheck,
  FaExclamationTriangle,
  FaBan,
} from "react-icons/fa";

import platformApi from "../../services/platformApi";

// ==========================================
// PLATFORM DASHBOARD (Phase 4, extended Phase 7)
//
// Summary cards derived entirely from GET /api/platform/companies/stats,
// which itself is a pure GROUP BY over companies.status/access_type --
// no invented fields, no tenant data. This is the minimum backend
// support needed for accurate counts, added this phase.
//
// The "New Demo Requests" card (Phase 7) deliberately does NOT add a
// new backend stats endpoint -- it reuses the existing
// GET /api/platform/demo-requests list and counts status === 'new'
// client-side, which is the whole payload the Demo Requests page
// already needs anyway. Adding a dedicated /demo-requests/stats
// endpoint just for one number would be more backend surface than
// this one count justifies.
// ==========================================

const CARD_DEFS = [
  { key: "total", label: "Total Companies", icon: FaBuilding, tone: "primary" },
  { key: "active", label: "Active Companies", icon: FaCheckCircle, tone: "success" },
  { key: "suspended", label: "Suspended Companies", icon: FaPauseCircle, tone: "danger" },
  { key: "pending", label: "Pending Provisioning", icon: FaHourglassHalf, tone: "pending" },
  { key: "complimentary", label: "Complimentary", icon: FaGift, tone: "info" },
  { key: "trial", label: "Trial", icon: FaFlask, tone: "warning" },
  { key: "paid", label: "Paid", icon: FaCrown, tone: "success" },
];

const SUBSCRIPTION_CARD_DEFS = [
  { key: "active", label: "Active Subscriptions", icon: FaCalendarCheck, tone: "success" },
  { key: "trial", label: "Trial Companies", icon: FaFlask, tone: "warning" },
  { key: "expired", label: "Expired Subscriptions", icon: FaExclamationTriangle, tone: "danger" },
  { key: "cancelled", label: "Cancelled Subscriptions", icon: FaBan, tone: "pending" },
];

function PlatformDashboard() {
  const [stats, setStats] = useState(null);
  const [subscriptionStats, setSubscriptionStats] = useState(null);
  const [newDemoRequestCount, setNewDemoRequestCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const loadStats = async () => {
      try {
        // /companies/stats now also returns subscriptionStats (Phase
        // 8) -- reused rather than adding a second dashboard endpoint.
        const [statsResponse, demoRequestsResponse] = await Promise.all([
          platformApi.get("/companies/stats"),
          platformApi.get("/demo-requests"),
        ]);
        setStats(statsResponse.data.stats);
        setSubscriptionStats(statsResponse.data.subscriptionStats);
        setNewDemoRequestCount(
          demoRequestsResponse.data.demoRequests.filter((request) => request.status === "new").length
        );
      } catch (err) {
        setError(
          err.response?.data?.message || "Unable to load dashboard stats."
        );
      } finally {
        setLoading(false);
      }
    };

    loadStats();
  }, []);

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Overview of every company on GrowOrgs.</p>
        </div>
        <Link to="/platform/companies" className="platform-btn platform-btn-primary">
          Manage Companies
        </Link>
      </div>

      {loading && <div className="platform-empty-state">Loading dashboard...</div>}

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      {!loading && !error && stats && (
        <div className="platform-stat-grid">
          <Link to="/platform/demo-requests" className="platform-stat-card platform-stat-card-link">
            <div className="platform-stat-icon tone-info">
              <FaInbox />
            </div>
            <div>
              <span className="platform-stat-value">{newDemoRequestCount ?? 0}</span>
              <span className="platform-stat-label">New Demo Requests</span>
            </div>
          </Link>

          {CARD_DEFS.map(({ key, label, icon: Icon, tone }) => (
            <div className="platform-stat-card" key={key}>
              <div className={`platform-stat-icon tone-${tone}`}>
                <Icon />
              </div>
              <div>
                <span className="platform-stat-value">{stats[key] ?? 0}</span>
                <span className="platform-stat-label">{label}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && !error && subscriptionStats && (
        <>
          <h2 style={{ fontSize: 15, margin: "28px 0 14px" }}>Subscriptions</h2>
          <div className="platform-stat-grid">
            {SUBSCRIPTION_CARD_DEFS.map(({ key, label, icon: Icon, tone }) => (
              <div className="platform-stat-card" key={key}>
                <div className={`platform-stat-icon tone-${tone}`}>
                  <Icon />
                </div>
                <div>
                  <span className="platform-stat-value">{subscriptionStats[key] ?? 0}</span>
                  <span className="platform-stat-label">{label}</span>
                </div>
              </div>
            ))}
          </div>

          {subscriptionStats.planDistribution?.length > 0 && (
            <div className="platform-card" style={{ padding: 24, marginTop: 20 }}>
              <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Plan Distribution</h2>
              <div className="platform-result-box" style={{ background: "transparent", border: "none", padding: 0 }}>
                {subscriptionStats.planDistribution.map((row) => (
                  <div className="platform-result-row" key={row.planId}>
                    <span>{row.planName}</span>
                    <span>{row.companyCount} {row.companyCount === 1 ? "company" : "companies"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

    </div>
  );
}

export default PlatformDashboard;
