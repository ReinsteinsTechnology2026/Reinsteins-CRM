const razorpayProvider = require("./razorpayProvider");

// ==========================================
// PAYMENT PROVIDER FACTORY (Phase 10G)
//
// One lookup point for "which payment provider implementation do I
// use" -- so a future second provider (Stripe, for international
// customers) is added by dropping in a new stripeProvider.js with the
// same function shape (isConfigured/createOrder/verifyPaymentSignature/
// verifyWebhookSignature) and registering it here, never by changing
// any call site that already uses getProvider().
// ==========================================

const PROVIDERS = {
    razorpay: razorpayProvider,
};

function getProvider(providerName) {
    const provider = PROVIDERS[providerName];
    if (!provider) {
        const error = new Error(`Unsupported payment provider: "${providerName}".`);
        error.code = "UNSUPPORTED_PROVIDER";
        throw error;
    }
    return provider;
}

function listAvailableProviders() {
    return Object.keys(PROVIDERS).map((name) => ({
        name,
        configured: PROVIDERS[name].isConfigured(),
    }));
}

module.exports = { getProvider, listAvailableProviders };
