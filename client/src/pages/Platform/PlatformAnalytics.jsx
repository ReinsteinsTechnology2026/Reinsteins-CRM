import { useEffect, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  PieChart, Pie, Cell,
} from "recharts";

import platformApi from "../../services/platformApi";
import { formatMoney } from "../../utils/formatMoney";

// ==========================================
// ANALYTICS (Platform Owner Dashboard)
//
// Company growth/plan distribution built from GET /companies +
// GET /companies/stats (no new endpoint, no invented metrics -- Phase
// 4/8 behavior, unchanged). Payment analytics (Phase 10K) reads
// GET /payments/stats -- the same paymentService.getPaymentStats()
// every other payment surface reads -- and renders an honest empty
// state instead of a chart whenever there isn't yet enough real
// payment history to plot, rather than ever fabricating one.
// ==========================================

const PIE_COLORS = ["#16A66A", "#D99A24", "#D64545", "#7C7ED9", "#2878D8", "#8ED9B7"];
const STATUS_COLORS = { paid: "#16A66A", pending: "#D99A24", failed: "#D64545", refunded: "#2878D8", cancelled: "#94A3B8" };

function monthLabel(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function paymentMonthLabel(yyyyMm) {
  const [year, month] = yyyyMm.split("-");
  return new Date(Number(year), Number(month) - 1, 1).toLocaleDateString(undefined, { year: "numeric", month: "short" });
}

function PlatformAnalytics() {
  const [companies, setCompanies] = useState([]);
  const [subscriptionStats, setSubscriptionStats] = useState(null);
  const [paymentStats, setPaymentStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        const [companiesRes, statsRes, paymentStatsRes] = await Promise.all([
          platformApi.get("/companies"),
          platformApi.get("/companies/stats"),
          platformApi.get("/payments/stats"),
        ]);
        setCompanies(companiesRes.data.companies);
        setSubscriptionStats(statsRes.data.subscriptionStats);
        setPaymentStats(paymentStatsRes.data.stats);
        setError(null);
      } catch (err) {
        setError(err.response?.data?.message || "Unable to load analytics.");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const growthByMonth = companies.reduce((acc, company) => {
    if (!company.createdAt) return acc;
    const label = monthLabel(company.createdAt);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});
  const growthEntries = Object.entries(growthByMonth).reverse();
  const maxGrowth = Math.max(1, ...growthEntries.map(([, count]) => count));

  const revenueByMonthData = (paymentStats?.revenueByMonth || []).map((r) => ({ month: paymentMonthLabel(r.month), total: r.total }));

  const statusPieData = paymentStats
    ? ["paid", "pending", "failed", "refunded", "cancelled"]
        .map((status) => ({ name: status, value: paymentStats[status] || 0, color: STATUS_COLORS[status] }))
        .filter((d) => d.value > 0)
    : [];

  const cyclePieData = (paymentStats?.revenueByBillingCycle || [])
    .filter((c) => c.total > 0)
    .map((c) => ({ name: c.billingCycle === "one_time" ? "One-time" : c.billingCycle.charAt(0).toUpperCase() + c.billingCycle.slice(1), value: c.total }));

  const hasAnyPaymentHistory = paymentStats && paymentStats.totalPayments > 0;

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Analytics</h1>
          <p>Company growth, subscription distribution, and payment analytics — all computed from real platform data.</p>
        </div>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      {!loading && !error && (
        <>
          <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
            <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>Companies Added by Month</h2>
            {growthEntries.length === 0 ? (
              <p style={{ color: "var(--p-text-secondary)", fontSize: 13.5 }}>No companies yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {growthEntries.map(([label, count]) => (
                  <div key={label} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <span style={{ fontSize: 12.5, color: "var(--p-text-secondary)", width: 90, flexShrink: 0 }}>{label}</span>
                    <div style={{ flex: 1, background: "var(--p-canvas)", borderRadius: 6, overflow: "hidden" }}>
                      <div style={{
                        width: `${(count / maxGrowth) * 100}%`,
                        background: "var(--p-primary)",
                        height: 18,
                        borderRadius: 6,
                        minWidth: 18,
                      }} />
                    </div>
                    <span style={{ fontSize: 13, fontWeight: 600, width: 24, textAlign: "right" }}>{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {subscriptionStats?.planDistribution?.length > 0 && (
            <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
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

          {/* ---------- PAYMENT ANALYTICS (Phase 10K) ---------- */}
          <h2 style={{ fontSize: 15, margin: "24px 0 14px" }}>Payment Analytics</h2>

          {!hasAnyPaymentHistory ? (
            <div className="platform-card" style={{ padding: 24 }}>
              <div className="platform-empty-state" style={{ padding: 8 }}>
                No payment history yet. Charts will appear here once real payments are recorded.
              </div>
            </div>
          ) : (
            <>
              <div className="platform-grid-2col" style={{ marginBottom: 20 }}>
                <div className="platform-card" style={{ padding: 24 }}>
                  <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>Revenue by Month</h2>
                  {revenueByMonthData.length === 0 ? (
                    <div className="platform-empty-state" style={{ padding: 16 }}>No paid payments yet.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={revenueByMonthData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--p-border)" />
                        <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} />
                        <Tooltip formatter={(value) => formatMoney(value, "INR")} />
                        <Bar dataKey="total" name="Revenue" fill="var(--p-primary)" radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>

                <div className="platform-card" style={{ padding: 24 }}>
                  <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>Payments by Status</h2>
                  {statusPieData.length === 0 ? (
                    <div className="platform-empty-state" style={{ padding: 16 }}>No payments yet.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={statusPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                          {statusPieData.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              <div className="platform-grid-2col">
                <div className="platform-card" style={{ padding: 24 }}>
                  <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 16 }}>Monthly vs Yearly vs One-time</h2>
                  {cyclePieData.length === 0 ? (
                    <div className="platform-empty-state" style={{ padding: 16 }}>No paid payments yet.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={220}>
                      <PieChart>
                        <Pie data={cyclePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                          {cyclePieData.map((entry, i) => <Cell key={entry.name} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                        </Pie>
                        <Tooltip formatter={(value) => formatMoney(value, "INR")} />
                      </PieChart>
                    </ResponsiveContainer>
                  )}
                </div>

                <div className="platform-card" style={{ padding: 24 }}>
                  <h2 style={{ fontSize: 15, marginTop: 0, marginBottom: 14 }}>Plan Revenue Distribution</h2>
                  {(paymentStats?.revenueByPlan || []).length === 0 ? (
                    <div className="platform-empty-state" style={{ padding: 16 }}>No paid payments yet.</div>
                  ) : (
                    <div className="platform-result-box" style={{ background: "transparent", border: "none", padding: 0 }}>
                      {paymentStats.revenueByPlan.map((row) => (
                        <div className="platform-result-row" key={row.planId}>
                          <span>{row.planName}</span>
                          <span>{formatMoney(row.total, "INR")} ({row.count} {row.count === 1 ? "payment" : "payments"})</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}

    </div>
  );
}

export default PlatformAnalytics;
