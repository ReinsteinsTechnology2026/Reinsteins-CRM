import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import platformApi from "../../services/platformApi";
import { formatMoney } from "../../utils/formatMoney";
import { loadRazorpayScript } from "../../utils/loadRazorpayScript";

// ==========================================
// RAZORPAY CHECKOUT MODAL (Phase 11D)
//
// Two entry points, same modal:
//   mode="new"      -- Platform Owner is starting a fresh subscription
//                       checkout (company + plan + billing cycle chosen
//                       elsewhere). Calls POST /payments/checkout,
//                       which creates the pending payment row AND the
//                       Razorpay order in one step.
//   mode="existing" -- retrying an existing pending Razorpay payment
//                       (checkout was closed/failed earlier). Calls
//                       POST /payments/:id/create-order, which reuses
//                       the existing order if one was already created.
//
// The backend remains the source of truth end to end: this component
// never marks anything "paid" itself -- Razorpay's success callback
// is just the trigger to call POST /payments/:id/verify, and only
// that server-side response (signature checked against the order id
// and amount THIS SERVER already fixed at order-creation time) is
// ever trusted.
// ==========================================

function billingCycleLabel(cycle) {
  if (cycle === "yearly") return "Yearly";
  if (cycle === "monthly") return "Monthly";
  return cycle;
}

function RazorpayCheckoutModal({ mode, companyId, companyName, planId, planName, billingCycle, payment: existingPayment, onClose, onSuccess }) {
  const [order, setOrder] = useState(null); // { paymentId, orderId, keyId, amountInSmallestUnit, currency }
  const [display, setDisplay] = useState({
    companyName: companyName || existingPayment?.companyName,
    planName: planName || existingPayment?.planName,
    billingCycle: billingCycle || existingPayment?.billingCycle,
    amount: existingPayment?.amount,
    currency: existingPayment?.currency || "INR",
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [paying, setPaying] = useState(false);

  const createOrder = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = mode === "new"
        ? await platformApi.post("/payments/checkout", { companyId, planId, billingCycle })
        : await platformApi.post(`/payments/${existingPayment.id}/create-order`);

      const { payment, razorpay } = response.data;
      setOrder({
        paymentId: payment.id,
        orderId: razorpay.orderId,
        keyId: razorpay.keyId,
        amountInSmallestUnit: razorpay.amount,
        currency: razorpay.currency,
      });
      setDisplay({
        companyName: payment.companyName,
        planName: payment.planName,
        billingCycle: payment.billingCycle,
        amount: payment.amount,
        currency: payment.currency,
      });
    } catch (err) {
      setError(err.response?.data?.message || "Unable to prepare Razorpay checkout.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    createOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleVerify = async (response) => {
    try {
      const verifyRes = await platformApi.post(`/payments/${order.paymentId}/verify`, {
        razorpayOrderId: response.razorpay_order_id,
        razorpayPaymentId: response.razorpay_payment_id,
        razorpaySignature: response.razorpay_signature,
      });
      toast.success(
        verifyRes.data.subscriptionActivated
          ? "Payment verified — subscription activated."
          : "Payment verified."
      );
      onSuccess(verifyRes.data.payment);
    } catch (err) {
      toast.error(err.response?.data?.message || "Payment verification failed. If money was deducted, it will be reconciled shortly — do not retry blindly.");
    } finally {
      setPaying(false);
    }
  };

  const handlePayClick = async () => {
    if (!order) return;
    const scriptLoaded = await loadRazorpayScript();
    if (!scriptLoaded) {
      toast.error("Unable to load Razorpay Checkout. Check your internet connection and try again.");
      return;
    }

    setPaying(true);

    const rzp = new window.Razorpay({
      key: order.keyId,
      amount: order.amountInSmallestUnit,
      currency: order.currency,
      order_id: order.orderId,
      name: "ZioVenture",
      description: `${display.planName || "Subscription"} — ${billingCycleLabel(display.billingCycle)}`,
      handler: (response) => handleVerify(response),
      modal: {
        ondismiss: () => {
          setPaying(false);
          toast.info("Checkout closed. You can retry anytime — the payment is still pending.");
        },
      },
      theme: { color: "#2878D8" },
    });

    rzp.on("payment.failed", (response) => {
      setPaying(false);
      toast.error(`Payment failed: ${response.error?.description || "Unknown error"}. You can retry.`);
    });

    rzp.open();
  };

  const notConfigured = error && /not configured/i.test(error);

  return (
    <div className="platform-modal-backdrop" onClick={onClose}>
      <div className="platform-modal" onClick={(event) => event.stopPropagation()}>

        <div className="platform-modal-header">
          <div>
            <h2>Pay with Razorpay</h2>
            <p>Test Mode checkout — no real money is processed until a live gateway is explicitly enabled.</p>
          </div>
          <button className="platform-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="platform-modal-body">

          {loading && <div className="platform-empty-state">Preparing checkout…</div>}

          {error && (
            <div className="platform-alert platform-alert-danger">
              {error}
              {notConfigured && (
                <p style={{ margin: "8px 0 0", fontSize: 12.5 }}>
                  Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET (Test Mode keys) to the server's .env and restart the backend to enable checkout.
                </p>
              )}
            </div>
          )}

          {!loading && order && (
            <>
              <div className="platform-result-box" style={{ marginBottom: 18 }}>
                <div className="platform-result-row"><span>Company</span><span>{display.companyName}</span></div>
                <div className="platform-result-row"><span>Plan</span><span>{display.planName}</span></div>
                <div className="platform-result-row"><span>Billing Cycle</span><span>{billingCycleLabel(display.billingCycle)}</span></div>
                <div className="platform-result-row"><span>Amount</span><span>{formatMoney(display.amount, display.currency)}</span></div>
              </div>

              <button
                className="platform-btn platform-btn-primary"
                style={{ width: "100%", justifyContent: "center" }}
                onClick={handlePayClick}
                disabled={paying}
              >
                {paying ? "Waiting for Razorpay…" : "Pay with Razorpay"}
              </button>
            </>
          )}

          {!loading && error && !notConfigured && (
            <button className="platform-btn platform-btn-outline" style={{ marginTop: 12 }} onClick={createOrder}>
              Retry
            </button>
          )}

        </div>

        <div className="platform-modal-footer">
          <button className="platform-btn platform-btn-outline" onClick={onClose}>Close</button>
        </div>

      </div>
    </div>
  );
}

export default RazorpayCheckoutModal;
