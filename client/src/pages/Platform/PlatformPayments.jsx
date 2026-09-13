import { useCallback, useEffect, useState } from "react";
import { FaSearch, FaPlus, FaMoneyBillWave, FaCheckCircle, FaHourglassHalf, FaTimesCircle } from "react-icons/fa";

import platformApi from "../../services/platformApi";
import { formatMoney } from "../../utils/formatMoney";
import RecordPaymentModal from "./RecordPaymentModal";
import PaymentDetailsModal from "./PaymentDetailsModal";
import RazorpayCheckoutModal from "./RazorpayCheckoutModal";

// ==========================================
// PAYMENTS (Platform Owner Dashboard) -- Phase 10C
//
// Real payment records only. Revenue and every summary figure here
// comes straight from GET /payments/stats (paymentService.getPaymentStats
// -- the single place "revenue" is ever computed), never recomputed
// client-side. Filtering runs server-side (GET /payments?...) since
// payment history can grow large and unbounded, unlike the Companies
// page's small, client-filtered list.
// ==========================================

const STATUS_FILTERS = ["all", "pending", "paid", "failed", "refunded", "cancelled"];
const SORT_OPTIONS = [
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "amount_high", label: "Amount: High to Low" },
  { value: "amount_low", label: "Amount: Low to High" },
];

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function PlatformPayments() {
  const [stats, setStats] = useState(null);
  const [payments, setPayments] = useState([]);
  const [companies, setCompanies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [companyFilter, setCompanyFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortBy, setSortBy] = useState("newest");

  const [showRecordModal, setShowRecordModal] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState(null);
  const [checkoutPayment, setCheckoutPayment] = useState(null);

  const loadPayments = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (companyFilter !== "all") params.set("companyId", companyFilter);
      if (search.trim()) params.set("search", search.trim());
      if (dateFrom) params.set("dateFrom", dateFrom);
      if (dateTo) params.set("dateTo", dateTo);
      if (sortBy) params.set("sortBy", sortBy);

      const [paymentsRes, statsRes] = await Promise.all([
        platformApi.get(`/payments?${params.toString()}`),
        platformApi.get("/payments/stats"),
      ]);
      setPayments(paymentsRes.data.payments || []);
      setStats(statsRes.data.stats);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || "Unable to load payments.");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, companyFilter, dateFrom, dateTo, sortBy]);

  // Debounced search -- everything else refetches immediately.
  useEffect(() => {
    const timer = setTimeout(() => { loadPayments(); }, search ? 350 : 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, statusFilter, companyFilter, dateFrom, dateTo, sortBy]);

  useEffect(() => {
    platformApi.get("/companies")
      .then((response) => setCompanies(response.data.companies || []))
      .catch(() => setCompanies([]));
  }, []);

  const handlePaymentCreated = (payment) => {
    setShowRecordModal(false);
    loadPayments();
    setSelectedPayment(payment);
  };

  const handlePaymentUpdated = () => {
    loadPayments();
  };

  const SUMMARY_CARDS = stats ? [
    { key: "totalPayments", label: "Total Payments", value: stats.totalPayments, icon: FaMoneyBillWave, tone: "primary" },
    { key: "paid", label: "Successful Payments", value: stats.paid, icon: FaCheckCircle, tone: "success" },
    { key: "pending", label: "Pending Payments", value: stats.pending, icon: FaHourglassHalf, tone: "pending" },
    { key: "failed", label: "Failed Payments", value: stats.failed, icon: FaTimesCircle, tone: "danger" },
  ] : [];

  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Payments</h1>
          <p>Real payment records only. No payment gateway is live yet -- these are manually recorded, confirmed transactions.</p>
        </div>
        <button className="platform-btn platform-btn-primary" onClick={() => setShowRecordModal(true)}>
          <FaPlus /> Record Payment
        </button>
      </div>

      {error && <div className="platform-alert platform-alert-danger">{error}</div>}

      {stats && (
        <>
          <div className="platform-stat-grid" style={{ marginBottom: 20 }}>
            {SUMMARY_CARDS.map(({ key, label, value, icon: Icon, tone }) => (
              <div className="platform-stat-card" key={key}>
                <div className={`platform-stat-icon tone-${tone}`}><Icon /></div>
                <div>
                  <span className="platform-stat-value">{value ?? 0}</span>
                  <span className="platform-stat-label">{label}</span>
                </div>
              </div>
            ))}
          </div>

          <div className="platform-card" style={{ padding: 24, marginBottom: 20 }}>
            {stats.totalRevenue > 0 ? (
              <>
                <span className="platform-stat-label">Total Revenue (successful payments only)</span>
                <div style={{ fontSize: 32, fontWeight: 700, color: "var(--p-success)", marginTop: 6 }}>
                  {formatMoney(stats.totalRevenue, "INR")}
                </div>
              </>
            ) : (
              <div className="platform-empty-state" style={{ padding: 8 }}>
                Revenue ₹0 — no completed payments yet.
              </div>
            )}
          </div>
        </>
      )}

      <div className="platform-toolbar">
        <div className="platform-search-input">
          <FaSearch />
          <input
            type="text"
            placeholder="Search by invoice number or company…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {STATUS_FILTERS.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Statuses" : s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>

        <select value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}>
          <option value="all">All Companies</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.companyName}</option>
          ))}
        </select>

        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} title="From date" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} title="To date" />

        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
          {SORT_OPTIONS.map((s) => <option key={s.value} value={s.value}>Sort: {s.label}</option>)}
        </select>
      </div>

      <div className="platform-card">
        <div className="platform-table-wrap">
          <table className="platform-table">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Company</th>
                <th>Plan</th>
                <th>Amount</th>
                <th>Cycle</th>
                <th>Status</th>
                <th>Provider</th>
                <th>Paid Date</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={10} className="platform-empty-state">Loading payments...</td></tr>
              )}

              {!loading && payments.length === 0 && (
                <tr><td colSpan={10} className="platform-empty-state">No payments match your filters.</td></tr>
              )}

              {!loading && payments.map((payment) => (
                <tr key={payment.id} className="clickable" onClick={() => setSelectedPayment(payment)}>
                  <td>{payment.invoiceNumber || `#${payment.id}`}</td>
                  <td>
                    <div className="platform-company-name">{payment.companyName}</div>
                    <div className="platform-company-slug">{payment.companySlug}</div>
                  </td>
                  <td>{payment.planName || "—"}</td>
                  <td>{formatMoney(payment.amount, payment.currency)}</td>
                  <td style={{ textTransform: "capitalize" }}>{payment.billingCycle?.replace("_", " ")}</td>
                  <td><span className={`platform-badge status-${payment.paymentStatus}`}>{payment.paymentStatus}</span></td>
                  <td style={{ textTransform: "capitalize" }}>{payment.paymentProvider || "—"}</td>
                  <td>{formatDate(payment.paidAt)}</td>
                  <td>{formatDate(payment.createdAt)}</td>
                  <td style={{ textAlign: "right" }}>
                    {payment.paymentProvider === "razorpay" && payment.paymentStatus === "pending" && (
                      <button
                        className="platform-btn platform-btn-primary platform-btn-sm"
                        onClick={(e) => { e.stopPropagation(); setCheckoutPayment(payment); }}
                      >
                        Pay / Retry
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showRecordModal && (
        <RecordPaymentModal
          companies={companies.filter((c) => c.status === "active" || c.status === "suspended")}
          onClose={() => setShowRecordModal(false)}
          onCreated={handlePaymentCreated}
        />
      )}

      {selectedPayment && (
        <PaymentDetailsModal
          payment={selectedPayment}
          onClose={() => setSelectedPayment(null)}
          onUpdated={handlePaymentUpdated}
        />
      )}

      {checkoutPayment && (
        <RazorpayCheckoutModal
          mode="existing"
          payment={checkoutPayment}
          onClose={() => setCheckoutPayment(null)}
          onSuccess={() => {
            setCheckoutPayment(null);
            loadPayments();
          }}
        />
      )}

    </div>
  );
}

export default PlatformPayments;
