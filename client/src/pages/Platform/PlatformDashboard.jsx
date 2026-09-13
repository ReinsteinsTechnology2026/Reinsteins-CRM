import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  FaBuilding, FaCheckCircle, FaPauseCircle, FaHourglassHalf,
  FaCalendarCheck, FaFlask, FaExclamationTriangle, FaBan,
  FaUsers, FaUserFriends, FaUserPlus, FaDollarSign, FaCrown, FaClock,
  FaSyncAlt, FaPlus, FaInbox, FaChartLine, FaExclamationCircle, FaEnvelope,
} from "react-icons/fa";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";

import platformApi from "../../services/platformApi";
import { formatMoney } from "../../utils/formatMoney";
import AddCompanyModal from "./AddCompanyModal";

// ==========================================
// PLATFORM OWNER DASHBOARD -- "Command Center"
//
// Every number on this page comes from the SAME reused
// GET /api/platform/companies/stats endpoint (extended, not
// duplicated -- see platformCompanyController.js) plus the existing
// GET /api/platform/demo-requests list. Revenue (Phase 10) reads the
// `paymentStats` field merged into that same response -- itself a
// passthrough of paymentService.getPaymentStats(), the one place
// revenue is ever computed -- and shows ₹0/"no completed payments
// yet" honestly when there are none. Every other chart renders an
// honest empty state if there isn't yet enough real historical data
// to plot.
// ==========================================

const PIE_COLORS = ["#16A66A", "#D99A24", "#D64545", "#7C7ED9", "#2878D8", "#8ED9B7"];

const COMPANY_CARD_DEFS = [
  { key: "total", label: "Total Companies", icon: FaBuilding, tone: "primary" },
  { key: "active", label: "Active Companies", icon: FaCheckCircle, tone: "success" },
  { key: "suspended", label: "Suspended Companies", icon: FaPauseCircle, tone: "danger" },
  { key: "pending", label: "Pending Provisioning", icon: FaHourglassHalf, tone: "pending" },
];

const SUBSCRIPTION_CARD_DEFS = [
  { key: "active", label: "Active Subscriptions", icon: FaCalendarCheck, tone: "success" },
  { key: "trial", label: "Trial Companies", icon: FaFlask, tone: "warning" },
  { key: "expired", label: "Expired Subscriptions", icon: FaExclamationTriangle, tone: "danger" },
  { key: "cancelled", label: "Cancelled Subscriptions", icon: FaBan, tone: "pending" },
];

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function monthLabel(dateString) {
  return new Date(dateString).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function getPlatformUser() {
  try {
    return JSON.parse(sessionStorage.getItem("platformUser"));
  } catch {
    return null;
  }
}

function PlatformDashboard() {
  const navigate = useNavigate();
  const platformUser = getPlatformUser();

  const [stats, setStats] = useState(null);
  const [subscriptionStats, setSubscriptionStats] = useState(null);
  const [platformStats, setPlatformStats] = useState(null);
  const [attentionRequired, setAttentionRequired] = useState(null);
  const [recentActivity, setRecentActivity] = useState([]);
  const [recentCompanies, setRecentCompanies] = useState([]);
  const [companiesForChart, setCompaniesForChart] = useState([]);
  const [newDemoRequestCount, setNewDemoRequestCount] = useState(null);
  const [paymentStats, setPaymentStats] = useState(null);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);

  const loadStats = useCallback(async (isRefresh) => {
    try {
      if (isRefresh) setRefreshing(true); else setLoading(true);

      const [statsResponse, demoRequestsResponse, companiesResponse] = await Promise.all([
        platformApi.get("/companies/stats"),
        platformApi.get("/demo-requests"),
        platformApi.get("/companies"),
      ]);

      setStats(statsResponse.data.stats);
      setSubscriptionStats(statsResponse.data.subscriptionStats);
      setPlatformStats(statsResponse.data.platformStats);
      setAttentionRequired(statsResponse.data.attentionRequired);
      setRecentActivity(statsResponse.data.recentActivity || []);
      setRecentCompanies(statsResponse.data.recentCompanies || []);
      setCompaniesForChart(companiesResponse.data.companies || []);
      setPaymentStats(statsResponse.data.paymentStats || null);
      setNewDemoRequestCount(
        demoRequestsResponse.data.demoRequests.filter((r) => r.status === "new").length
      );
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load dashboard stats.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { loadStats(false); }, [loadStats]);

  const handleCompanyCreated = (company) => {
    setShowAddModal(false);
    loadStats(true);
    if (company) navigate(`/owner/companies/${company.id}`);
  };

  const greetingName = platformUser?.name?.split(" ")[0] || "there";
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // Company growth by month, computed from real createdAt values only
  // -- no synthetic history. Chronological order for the chart.
  const growthByMonth = companiesForChart.reduce((acc, c) => {
    if (!c.createdAt) return acc;
    const label = monthLabel(c.createdAt);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const growthData = Object.entries(growthByMonth).map(([month, count]) => ({ month, count }));

  const statusPieData = stats
    ? [
        { name: "Active", value: stats.active },
        { name: "Suspended", value: stats.suspended },
        { name: "Pending", value: stats.pending },
      ].filter((d) => d.value > 0)
    : [];

  const currentMonthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const currentMonthRevenue = paymentStats?.revenueByMonth?.find((r) => r.month === currentMonthKey)?.total || 0;

  const planPieData = (subscriptionStats?.planDistribution || [])
    .filter((p) => p.companyCount > 0)
    .map((p) => ({ name: p.planName, value: p.companyCount }));

  const hasAnyAttention = attentionRequired && (
    attentionRequired.newDemoRequests > 0 ||
    attentionRequired.expiredSubscriptions.length > 0 ||
    attentionRequired.stalePendingProvisioning.length > 0 ||
    attentionRequired.approachingEmployeeLimit.length > 0 ||
    attentionRequired.expiringSoon?.length > 0 ||
    attentionRequired.gracePeriod?.length > 0 ||
    attentionRequired.failedPayments?.length > 0 ||
    attentionRequired.failedEmails?.length > 0
  );

  return (
    <div className="platform-page" style={{ maxWidth: 1320 }}>

      {/* ---------- HEADER ---------- */}
      <div className="platform-page-header">
        <div>
          <h1>{greeting}, {greetingName} 👋</h1>
          <p>Here's what's happening across your platform today.</p>
          <p style={{ marginTop: 6, fontSize: 12, color: "var(--p-text-muted)" }}>
            {new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
            {lastUpdated && ` · Last updated ${lastUpdated.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            className="platform-btn platform-btn-outline"
            onClick={() => loadStats(true)}
            disabled={refreshing}
          >
            <FaSyncAlt className={refreshing ? "platform-spin" : ""} /> {refreshing ? "Refreshing…" : "Refresh"}
          </button>
          <button className="platform-btn platform-btn-primary" onClick={() => setShowAddModal(true)}>
            <FaPlus /> Add Company
          </button>
        </div>
      </div>

      {loading && <div className="platform-empty-state">Loading dashboard...</div>}
      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      {!loading && !error && stats && (
        <>
          {/* ---------- ATTENTION REQUIRED ---------- */}
          <div className="platform-card" style={{ padding: 24, marginBottom: 24 }}>
            <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
              <FaExclamationCircle style={{ color: "var(--p-warning)" }} /> Attention Required
            </h2>

            {!hasAnyAttention && (
              <div className="platform-empty-state" style={{ padding: 16 }}>
                Nothing needs your attention right now.
              </div>
            )}

            {hasAnyAttention && (
              <div className="platform-stat-grid">
                {attentionRequired.newDemoRequests > 0 && (
                  <Link to="/owner/demo-requests" className="platform-stat-card platform-stat-card-link">
                    <div className="platform-stat-icon tone-info"><FaInbox /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.newDemoRequests}</span>
                      <span className="platform-stat-label">New Demo Requests</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.expiredSubscriptions.length > 0 && (
                  <Link
                    to={`/owner/companies/${attentionRequired.expiredSubscriptions[0].id}`}
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.expiredSubscriptions.map((c) => c.companyName).join(", ")}
                  >
                    <div className="platform-stat-icon tone-danger"><FaExclamationTriangle /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.expiredSubscriptions.length}</span>
                      <span className="platform-stat-label">Expired Subscriptions</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.stalePendingProvisioning.length > 0 && (
                  <Link
                    to={`/owner/companies/${attentionRequired.stalePendingProvisioning[0].id}`}
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.stalePendingProvisioning.map((c) => c.companyName).join(", ")}
                  >
                    <div className="platform-stat-icon tone-pending"><FaHourglassHalf /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.stalePendingProvisioning.length}</span>
                      <span className="platform-stat-label">Stuck in Provisioning</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.approachingEmployeeLimit.length > 0 && (
                  <Link
                    to={`/owner/companies/${attentionRequired.approachingEmployeeLimit[0].id}`}
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.approachingEmployeeLimit.map((c) => `${c.companyName} (${c.employeeCount}/${c.employeeLimit})`).join(", ")}
                  >
                    <div className="platform-stat-icon tone-warning"><FaUsers /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.approachingEmployeeLimit.length}</span>
                      <span className="platform-stat-label">Nearing Employee Limit</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.expiringSoon?.length > 0 && (
                  <Link
                    to={`/owner/companies/${attentionRequired.expiringSoon[0].id}`}
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.expiringSoon.map((c) => c.companyName).join(", ")}
                  >
                    <div className="platform-stat-icon tone-warning"><FaClock /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.expiringSoon.length}</span>
                      <span className="platform-stat-label">Expiring Soon</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.gracePeriod?.length > 0 && (
                  <Link
                    to={`/owner/companies/${attentionRequired.gracePeriod[0].id}`}
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.gracePeriod.map((c) => c.companyName).join(", ")}
                  >
                    <div className="platform-stat-icon tone-warning"><FaHourglassHalf /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.gracePeriod.length}</span>
                      <span className="platform-stat-label">In Grace Period</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.failedPayments?.length > 0 && (
                  <Link
                    to="/owner/payments"
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.failedPayments.map((p) => p.companyName).join(", ")}
                  >
                    <div className="platform-stat-icon tone-danger"><FaExclamationTriangle /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.failedPayments.length}</span>
                      <span className="platform-stat-label">Failed Payments</span>
                    </div>
                  </Link>
                )}
                {attentionRequired.failedEmails?.length > 0 && (
                  <Link
                    to="/owner/email-logs"
                    className="platform-stat-card platform-stat-card-link"
                    title={attentionRequired.failedEmails.map((e) => e.companyName).join(", ")}
                  >
                    <div className="platform-stat-icon tone-danger"><FaEnvelope /></div>
                    <div>
                      <span className="platform-stat-value">{attentionRequired.failedEmails.length}</span>
                      <span className="platform-stat-label">Failed Emails</span>
                    </div>
                  </Link>
                )}
              </div>
            )}
          </div>

          {/* ---------- COMPANY OVERVIEW ---------- */}
          <h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Company Overview</h2>
          <div className="platform-stat-grid" style={{ marginBottom: 28 }}>
            {COMPANY_CARD_DEFS.map(({ key, label, icon: Icon, tone }) => (
              <div className="platform-stat-card" key={key}>
                <div className={`platform-stat-icon tone-${tone}`}><Icon /></div>
                <div>
                  <span className="platform-stat-value">{stats[key] ?? 0}</span>
                  <span className="platform-stat-label">{label}</span>
                </div>
              </div>
            ))}
          </div>

          {/* ---------- SUBSCRIPTION OVERVIEW ---------- */}
          {subscriptionStats && (
            <>
              <h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Subscription Overview</h2>
              <div className="platform-stat-grid" style={{ marginBottom: 28 }}>
                {SUBSCRIPTION_CARD_DEFS.map(({ key, label, icon: Icon, tone }) => (
                  <div className="platform-stat-card" key={key}>
                    <div className={`platform-stat-icon tone-${tone}`}><Icon /></div>
                    <div>
                      <span className="platform-stat-value">{subscriptionStats[key] ?? 0}</span>
                      <span className="platform-stat-label">{label}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ---------- PLATFORM USAGE ---------- */}
          <h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Platform Usage</h2>
          <div className="platform-stat-grid" style={{ marginBottom: 28 }}>
            <Link to="/owner/users" className="platform-stat-card platform-stat-card-link">
              <div className="platform-stat-icon tone-primary"><FaUsers /></div>
              <div>
                <span className="platform-stat-value">{platformStats?.totalUsers ?? 0}</span>
                <span className="platform-stat-label">Total Users</span>
              </div>
            </Link>
            <div className="platform-stat-card">
              <div className="platform-stat-icon tone-success"><FaUserFriends /></div>
              <div>
                <span className="platform-stat-value">{platformStats?.totalEmployees ?? 0}</span>
                <span className="platform-stat-label">Total Employees</span>
              </div>
            </div>
            <div className="platform-stat-card">
              <div className="platform-stat-icon tone-info"><FaUserPlus /></div>
              <div>
                <span className="platform-stat-value">{platformStats?.newUsersThisMonth ?? 0}</span>
                <span className="platform-stat-label">New Users This Month</span>
              </div>
            </div>
          </div>

          {/* ---------- REVENUE (Phase 10) ---------- */}
          <h2 style={{ fontSize: 15, margin: "0 0 14px" }}>Revenue</h2>
          {!paymentStats || paymentStats.totalRevenue === 0 ? (
            <div className="platform-card" style={{ padding: 24, marginBottom: 28 }}>
              <div className="platform-empty-state" style={{ padding: 8 }}>
                Revenue ₹0 — no completed payments yet.
              </div>
            </div>
          ) : (
            <div className="platform-stat-grid" style={{ marginBottom: 28 }}>
              <div className="platform-stat-card">
                <div className="platform-stat-icon tone-success"><FaDollarSign /></div>
                <div>
                  <span className="platform-stat-value">{formatMoney(currentMonthRevenue, "INR")}</span>
                  <span className="platform-stat-label">Monthly Revenue</span>
                </div>
              </div>
              <div className="platform-stat-card">
                <div className="platform-stat-icon tone-success"><FaDollarSign /></div>
                <div>
                  <span className="platform-stat-value">{formatMoney(paymentStats.totalRevenue, "INR")}</span>
                  <span className="platform-stat-label">Total Revenue</span>
                </div>
              </div>
              <div className="platform-stat-card">
                <div className="platform-stat-icon tone-success"><FaCrown /></div>
                <div>
                  <span className="platform-stat-value">{paymentStats.paid ?? 0}</span>
                  <span className="platform-stat-label">Successful Payments</span>
                </div>
              </div>
              <div className="platform-stat-card">
                <div className="platform-stat-icon tone-pending"><FaClock /></div>
                <div>
                  <span className="platform-stat-value">{paymentStats.pending ?? 0}</span>
                  <span className="platform-stat-label">Pending Payments</span>
                </div>
              </div>
            </div>
          )}

          {/* ---------- CHARTS ---------- */}
          <div className="platform-grid-2col" style={{ marginBottom: 28 }}>
            <div className="platform-card" style={{ padding: 24 }}>
              <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}><FaChartLine style={{ marginRight: 6 }} />Company Growth</h2>
              {growthData.length < 2 ? (
                <div className="platform-empty-state" style={{ padding: 16 }}>
                  Analytics will become available once companies have been created across more than one month.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={growthData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--p-border)" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip />
                    <Bar dataKey="count" name="Companies added" fill="var(--p-primary)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="platform-card" style={{ padding: 24 }}>
              <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>Company Status Distribution</h2>
              {statusPieData.length === 0 ? (
                <div className="platform-empty-state" style={{ padding: 16 }}>No companies yet.</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={statusPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                      {statusPieData.map((entry, i) => <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {planPieData.length > 0 && (
            <div className="platform-card" style={{ padding: 24, marginBottom: 28 }}>
              <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>Subscription Plan Distribution</h2>
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={planPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                    {planPieData.map((entry, i) => <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ---------- RECENT COMPANIES ---------- */}
          <div className="platform-card" style={{ marginBottom: 28 }}>
            <div style={{ padding: "24px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2 style={{ fontSize: 15, margin: 0 }}>Recent Companies</h2>
              <Link to="/owner/companies" className="platform-btn platform-btn-outline platform-btn-sm">View All Companies</Link>
            </div>
            <div className="platform-table-wrap" style={{ marginTop: 14 }}>
              <table className="platform-table">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Status</th>
                    <th>Plan</th>
                    <th>Created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {recentCompanies.length === 0 && (
                    <tr><td colSpan={5} className="platform-empty-state">No companies yet.</td></tr>
                  )}
                  {recentCompanies.map((company) => (
                    <tr key={company.id} className="clickable" onClick={() => navigate(`/owner/companies/${company.id}`)}>
                      <td>
                        <div className="platform-company-name">{company.companyName}</div>
                        <div className="platform-company-slug">{company.companySlug}</div>
                      </td>
                      <td><span className={`platform-badge status-${company.status}`}>{company.status}</span></td>
                      <td>{company.subscription?.planName || "—"}</td>
                      <td>{formatDate(company.createdAt)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Link to={`/owner/companies/${company.id}`} className="platform-btn platform-btn-outline platform-btn-sm" onClick={(e) => e.stopPropagation()}>
                          View
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---------- RECENT ACTIVITY ---------- */}
          <div className="platform-card" style={{ padding: 24 }}>
            <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Recent Platform Activity</h2>
            {recentActivity.length === 0 ? (
              <div className="platform-empty-state" style={{ padding: 16 }}>No recent activity yet.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {recentActivity.map((event, i) => (
                  <div
                    key={i}
                    className="platform-activity-row"
                    onClick={() => {
                      if (event.type === "company_created") navigate(`/owner/companies/${event.companyId}`);
                      if (event.type === "demo_request_received") navigate("/owner/demo-requests");
                    }}
                  >
                    <span className={`platform-activity-dot ${event.type === "company_created" ? "tone-success" : "tone-info"}`} />
                    <span className="platform-activity-text">
                      {event.type === "company_created" && <>Company <strong>{event.companyName}</strong> was created</>}
                      {event.type === "demo_request_received" && <>Demo request received from <strong>{event.requesterName}</strong> ({event.companyName})</>}
                    </span>
                    <span className="platform-activity-time">{formatDate(event.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {showAddModal && (
        <AddCompanyModal
          onClose={() => setShowAddModal(false)}
          onCreated={handleCompanyCreated}
          onPartialSuccess={() => loadStats(true)}
        />
      )}

    </div>
  );
}

export default PlatformDashboard;
