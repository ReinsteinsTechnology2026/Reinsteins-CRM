const crypto = require("crypto");

// ==========================================
// RAZORPAY PROVIDER (Phase 10G/10H -- architecture preparation)
//
// NOT ACTIVATED. No real payment flow runs through this file yet --
// createOrder() only ever calls Razorpay's real API if RAZORPAY_KEY_ID
// and RAZORPAY_KEY_SECRET are both set in the environment, which they
// are not in this deployment. Calling it without those set throws a
// clear "not configured" error instead of silently doing nothing or
// faking a response.
//
// The two signature-verification functions ARE fully real and
// correct today, not stubs -- they're pure cryptographic checks (no
// network call, no credentials required to exercise them), so they
// can be tested now and will work unchanged once real keys are added
// later. This is the security-critical part of a payment integration
// ("never trust client-supplied payment status" / "verify webhook
// signatures"), so it's written correctly from the start rather than
// deferred.
//
// Credentials read ONLY from environment variables, never hardcoded,
// never logged, never sent to the frontend (the one exception, once
// this is actually activated, is RAZORPAY_KEY_ID itself -- Razorpay's
// own checkout.js needs the PUBLIC key id client-side; KEY_SECRET and
// WEBHOOK_SECRET must never leave this server).
// ==========================================

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

function isConfigured() {
    return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function isWebhookConfigured() {
    return Boolean(process.env.RAZORPAY_WEBHOOK_SECRET);
}

// Creates a real Razorpay order via their REST API (Basic Auth with
// key_id:key_secret, exactly as Razorpay's own docs specify -- no SDK
// dependency needed for this one call). Amount must be passed in the
// smallest currency unit (paise for INR), matching Razorpay's own API
// contract -- the caller (paymentController) is responsible for that
// conversion so this function never silently misinterprets units.
async function createOrder({ amountInSmallestUnit, currency, receipt }) {

    if (!isConfigured()) {
        const error = new Error("Payment gateway is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable real payments.");
        error.code = "PROVIDER_NOT_CONFIGURED";
        throw error;
    }

    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");

    const response = await fetch(`${RAZORPAY_API_BASE}/orders`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Basic ${auth}`,
        },
        body: JSON.stringify({ amount: amountInSmallestUnit, currency, receipt }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => "");
        const error = new Error(`Razorpay order creation failed (${response.status}).`);
        error.code = "PROVIDER_REQUEST_FAILED";
        error.providerResponse = body;
        throw error;
    }

    return await response.json();
}

// Verifies a client-reported payment success -- Razorpay's documented
// algorithm: HMAC-SHA256 of "order_id|payment_id" using the key
// secret must equal the signature Razorpay returned to the checkout
// callback. This is what makes "never trust client-supplied payment
// status alone" actually enforceable: a forged { paymentId, status:
// "paid" } from the browser fails this check because the caller
// cannot produce a valid signature without the secret.
function verifyPaymentSignature({ orderId, paymentId, signature }) {

    if (!isConfigured()) {
        const error = new Error("Payment gateway is not configured.");
        error.code = "PROVIDER_NOT_CONFIGURED";
        throw error;
    }

    const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(`${orderId}|${paymentId}`)
        .digest("hex");

    return timingSafeEqualHex(expected, signature);
}

// Verifies a webhook request body against Razorpay's X-Razorpay-Signature
// header -- HMAC-SHA256 of the RAW request body using the separate
// webhook secret (never the same secret as key_secret). `rawBody` must
// be the exact bytes Razorpay sent (a string), not a re-serialized
// JSON.stringify(parsedBody) -- re-serializing can change whitespace/
// key order and silently break verification, which is why the
// webhook route (once wired up) must capture the raw body before
// express.json() parses it.
function verifyWebhookSignature({ rawBody, signature }) {

    if (!isWebhookConfigured()) {
        const error = new Error("Webhook secret is not configured.");
        error.code = "WEBHOOK_NOT_CONFIGURED";
        throw error;
    }

    const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

    return timingSafeEqualHex(expected, signature);
}

// Constant-time comparison -- a plain === on signatures would leak
// timing information about how many leading characters matched,
// which is exactly the kind of side channel signature verification
// exists to avoid.
function timingSafeEqualHex(a, b) {
    if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
        return false;
    }
    try {
        return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
    } catch {
        return false;
    }
}

module.exports = {
    providerName: "razorpay",
    isConfigured,
    isWebhookConfigured,
    createOrder,
    verifyPaymentSignature,
    verifyWebhookSignature,
};
