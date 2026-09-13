import { useEffect, useState } from "react";

import platformApi from "../../services/platformApi";

// ==========================================
// RECORD PAYMENT MODAL (Phase 10C)
//
// The ONLY way a payment row exists today -- the Platform Owner
// manually records a real, already-received offline payment (bank
// transfer, cheque, etc). POST /api/platform/payments always forces
// paymentProvider="manual" server-side regardless of what this form
// sends, so there is no path here that can fabricate a "razorpay"
// transaction.
// ==========================================

const BILLING_CYCLES = [
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
  { value: "one_time", label: "One-time" },
];

function RecordPaymentModal({ companies, fixedCompanyId, onClose, onCreated }) {
  const [companyId, setCompanyId] = useState(fixedCompanyId ? String(fixedCompanyId) : "");
  const [planId, setPlanId] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [billingCycle, setBillingCycle] = useState("monthly");
  const [markPaid, setMarkPaid] = useState(true);
  const [notes, setNotes] = useState("");

  const [plans, setPlans] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    platformApi.get("/plans")
      .then((response) => setPlans(response.data.plans || []))
      .catch(() => setPlans([]));
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    const amountNum = Number(amount);
    if (!companyId) { setError("Select a company."); return; }
    if (!planId) { setError("Select a plan."); return; }
    if (!Number.isFinite(amountNum) || amountNum <= 0) { setError("Enter a valid amount greater than 0."); return; }
    if (!/^[A-Za-z]{3}$/.test(currency)) { setError("Currency must be a 3-letter code, e.g. INR, USD."); return; }

    try {
      setSubmitting(true);
      const response = await platformApi.post("/payments", {
        companyId: Number(companyId),
        planId: Number(planId),
        amount: amountNum,
        currency: currency.toUpperCase(),
        billingCycle,
        paymentStatus: markPaid ? "paid" : "pending",
        notes: notes.trim() || undefined,
      });
      onCreated(response.data.payment);
    } catch (err) {
      setError(err.response?.data?.message || "Failed to record payment.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>Record Payment</h2>
            <p>Records a real, already-received offline payment. This is not a live payment gateway.</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">
          {error && <div className="platform-alert platform-alert-danger">{error}</div>}

          <form onSubmit={handleSubmit}>

            <div className="platform-form-group">
              <label htmlFor="payment-company">Company</label>
              <select
                id="payment-company"
                value={companyId}
                onChange={(event) => setCompanyId(event.target.value)}
                disabled={!!fixedCompanyId}
              >
                <option value="" disabled>Select a company</option>
                {companies.map((c) => (
                  <option key={c.id} value={c.id}>{c.companyName}</option>
                ))}
              </select>
            </div>

            <div className="platform-form-group">
              <label htmlFor="payment-plan">Plan</label>
              <select id="payment-plan" value={planId} onChange={(event) => setPlanId(event.target.value)}>
                <option value="" disabled>Select a plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            <div style={{ display: "flex", gap: 12 }}>
              <div className="platform-form-group" style={{ flex: 2 }}>
                <label htmlFor="payment-amount">Amount</label>
                <input
                  id="payment-amount"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="4999.00"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </div>
              <div className="platform-form-group" style={{ flex: 1 }}>
                <label htmlFor="payment-currency">Currency</label>
                <input
                  id="payment-currency"
                  type="text"
                  maxLength={3}
                  value={currency}
                  onChange={(event) => setCurrency(event.target.value.toUpperCase())}
                />
              </div>
            </div>

            <div className="platform-form-group">
              <label htmlFor="payment-cycle">Billing Cycle</label>
              <select id="payment-cycle" value={billingCycle} onChange={(event) => setBillingCycle(event.target.value)}>
                {BILLING_CYCLES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            <div className="platform-form-group">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" checked={markPaid} onChange={(event) => setMarkPaid(event.target.checked)} style={{ width: "auto" }} />
                Mark as already paid (an invoice number is generated automatically)
              </label>
              {!markPaid && (
                <p className="platform-form-hint">
                  Saved as Pending. You can mark it Paid later from the payment's details once the funds are confirmed received.
                </p>
              )}
            </div>

            <div className="platform-form-group">
              <label htmlFor="payment-notes">Notes (optional)</label>
              <textarea
                id="payment-notes"
                rows={3}
                maxLength={500}
                placeholder="e.g. Bank transfer ref #, cheque number..."
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </div>

          </form>
        </div>

        <div className="platform-modal-footer">
          <button className="platform-btn platform-btn-outline" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="platform-btn platform-btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? "Recording..." : "Record Payment"}
          </button>
        </div>

      </div>
    </div>
  );
}

export default RecordPaymentModal;
