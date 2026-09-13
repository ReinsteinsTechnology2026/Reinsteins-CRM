const express = require("express");

const router = express.Router();

const {
    listPayments,
    getPaymentStats,
    getPaymentDetails,
    createPayment,
    updatePaymentStatus,
    handleRazorpayWebhook,
    createCheckoutPayment,
    createOrderForExistingPayment,
    verifyPayment,
} = require("../controllers/platformPaymentController");
const { platformProtect } = require("../middleware/platformAuthMiddleware");
const { paymentSensitiveLimiter } = require("../middleware/rateLimiters");

// ==========================================
// PLATFORM PAYMENT ROUTES (Phase 10, extended Phase 11)
// Mounted at /api/platform/payments in app.js.
//
// Every route here requires an authenticated, active Platform Owner
// EXCEPT the webhook route -- that one authenticates via Razorpay's
// signature instead of a JWT (see platformPaymentController.js's
// handleRazorpayWebhook for why, and the security guarantees that
// replace platformProtect there).
//
// Route order matters: /stats and /checkout must be registered before
// /:id, or Express would match "/stats"/"/checkout" as :id="stats" --
// same convention already used in platformCompanyRoutes.js.
// ==========================================

router.post("/webhook/razorpay", handleRazorpayWebhook);

router.get("/", platformProtect, listPayments);
router.get("/stats", platformProtect, getPaymentStats);
router.post("/", platformProtect, createPayment);
// Phase 14F -- the three routes that actually talk to Razorpay or
// decide payment success get the tighter sensitive limiter, on top of
// platformProtect. /:id/status (manual mark paid/failed/etc) does not
// -- it's a routine admin action with no external-provider surface.
router.post("/checkout", platformProtect, paymentSensitiveLimiter, createCheckoutPayment);
router.get("/:id", platformProtect, getPaymentDetails);
router.patch("/:id/status", platformProtect, updatePaymentStatus);
router.post("/:id/create-order", platformProtect, paymentSensitiveLimiter, createOrderForExistingPayment);
router.post("/:id/verify", platformProtect, paymentSensitiveLimiter, verifyPayment);

module.exports = router;
