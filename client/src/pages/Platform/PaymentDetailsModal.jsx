import { useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import { formatMoney } from "../../utils/formatMoney";
import RazorpayCheckoutModal from "./RazorpayCheckoutModal";

// ==========================================
// PAYMENT DETAILS MODAL (Phase 10C, extended Phase 11J)
//
// Read-only detail view plus manual status transitions. A Razorpay
// payment can NEVER be manually marked "paid" here -- the backend
// rejects that (see platformPaymentController.js's updatePaymentStatus),
// so a pending Razorpay payment only offers "Pay / Retry" (real
// checkout + server-side verification) and "Cancel", never "Mark as
// Paid". A manually-recorded payment (paymentProvider "manual" or
// unset) keeps the exact Phase 10 behavior unchanged.
// ==========================================

const MANUAL_TRANSITIONS = {
  pending: ["paid", "failed", "cancelled"],
  paid: ["refunded"],
  failed: [],
  refunded: [],
  cancelled: [],
};

// A Razorpay payment can never skip straight to "paid" manually -- see
// module header. It can still be abandoned/cancelled by the Platform
// Owner (e.g. a stale pending checkout nobody ever completed).
const RAZORPAY_TRANSITIONS = {
  pending: ["cancelled"],
  paid: ["refunded"],
  failed: [],
  refunded: [],
  cancelled: [],
};

const STATUS_LABELS = {
  paid: "Mark as Paid",
  failed: "Mark as Failed",
  cancelled: "Cancel",
  refunded: "Mark as Refunded",
};

function formatDate(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function PaymentDetailsModal({ payment, onClose, onUpdated }) {
  const [current, setCurrent] = useState(payment);
  const [updating, setUpdating] = useState(false);
  const [showCheckoutModal, setShowCheckoutModal] = useState(false);

  const handleTransition = async (status) => {
    try {
      setUpdating(true);
      const response = await platformApi.patch(`/payments/${current.id}/status`, { status });
      setCurrent(response.data.payment);
      onUpdated(response.data.payment);
      toast.success(`Payment marked ${status}.`);
    } catch (err) {
      toast.error(err.response?.data?.message || "Failed to update payment status.");
    } finally {
      setUpdating(false);
    }
  };

  const isRazorpay = current.paymentProvider === "razorpay";
  const availableTransitions = (isRazorpay ? RAZORPAY_TRANSITIONS : MANUAL_TRANSITIONS)[current.paymentStatus] || [];
  const canPayOrRetry = isRazorpay && current.paymentStatus === "pending";

  return (
    <>
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>Payment {current.invoiceNumber || `#${current.id}`}</h2>
            <p>Recorded {formatDate(current.createdAt)}</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">
          <div className="platform-result-box">
            <div className="platform-result-row">
              <span>Company</span>
              <span><Link to={`/owner/companies/${current.companyId}`}>{current.companyName || "—"}</Link></span>
            </div>
            <div className="platform-result-row"><span>Plan</span><span>{current.planName || "—"}</span></div>
            <div className="platform-result-row"><span>Amount</span><span>{formatMoney(current.amount, current.currency)}</span></div>
            <div className="platform-result-row"><span>Billing Cycle</span><span style={{ textTransform: "capitalize" }}>{current.billingCycle?.replace("_", " ")}</span></div>
            <div className="platform-result-row">
              <span>Status</span>
              <span><span className={`platform-badge status-${current.paymentStatus}`}>{current.paymentStatus}</span></span>
            </div>
            <div className="platform-result-row"><span>Provider</span><span style={{ textTransform: "capitalize" }}>{current.paymentProvider || "—"}</span></div>
            {isRazorpay && (
              <div className="platform-result-row"><span>Razorpay Order ID</span><span>{current.providerOrderId || "—"}</span></div>
            )}
            <div className="platform-result-row"><span>Provider Payment ID</span><span>{current.providerPaymentId || "—"}</span></div>
            <div className="platform-result-row"><span>Invoice Number</span><span>{current.invoiceNumber || "Not yet assigned"}</span></div>
            <div className="platform-result-row"><span>Paid At</span><span>{formatDate(current.paidAt)}</span></div>
            <div className="platform-result-row"><span>Created At</span><span>{formatDate(current.createdAt)}</span></div>
            <div className="platform-result-row"><span>Last Updated</span><span>{formatDate(current.updatedAt)}</span></div>
            {current.notes && (
              <div className="platform-result-row"><span>Notes</span><span>{current.notes}</span></div>
            )}
          </div>

          {canPayOrRetry && (
            <div style={{ marginTop: 18 }}>
              <button className="platform-btn platform-btn-primary platform-btn-sm" onClick={() => setShowCheckoutModal(true)}>
                Pay / Retry with Razorpay
              </button>
            </div>
          )}

          {availableTransitions.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <p style={{ fontSize: 12.5, color: "var(--p-text-secondary)", marginBottom: 10 }}>Update status</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {availableTransitions.map((status) => (
                  <button
                    key={status}
                    className={`platform-btn platform-btn-sm ${status === "paid" ? "platform-btn-primary" : "platform-btn-outline"}`}
                    onClick={() => handleTransition(status)}
                    disabled={updating}
                  >
                    {updating ? "Updating..." : STATUS_LABELS[status]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="platform-modal-footer">
          <button className="platform-btn platform-btn-outline" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>

    {showCheckoutModal && (
      <RazorpayCheckoutModal
        mode="existing"
        payment={current}
        onClose={() => setShowCheckoutModal(false)}
        onSuccess={(updatedPayment) => {
          setShowCheckoutModal(false);
          setCurrent(updatedPayment);
          onUpdated(updatedPayment);
        }}
      />
    )}
    </>
  );
}

export default PaymentDetailsModal;
