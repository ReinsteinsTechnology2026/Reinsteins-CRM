// ==========================================
// EMAIL DELIVERY CONFIGURATION (Phase 13F)
//
// Centralized retry settings -- no retry count/delay is ever
// hardcoded elsewhere (emailDeliveryService.js reads only from here).
// Kept as its own file, separate from config/lifecycleConfig.js:
// email retry timing is a distinct concern from subscription
// timing, even though both are lifecycle-adjacent.
// ==========================================

// Maximum number of RETRY attempts after the first failed send (the
// first attempt itself doesn't count against this -- see
// emailDeliveryService.retryFailedEmail). E.g. 3 means up to 3 retries
// (4 total attempts) before an email is left permanently failed.
const EMAIL_MAX_RETRIES = Number(process.env.EMAIL_MAX_RETRIES) || 3;

// Base delay, in minutes, before the FIRST automatic retry is
// eligible. Each subsequent automatic retry backs off exponentially
// (delay * 2^retryCount) -- see emailDeliveryService.processEmailRetries.
// Manual retries (Platform Owner clicking "Retry" in the UI) are not
// subject to this delay, only to the max-retry-count limit.
const EMAIL_RETRY_DELAY_MINUTES = Number(process.env.EMAIL_RETRY_DELAY_MINUTES) || 30;

module.exports = {
    EMAIL_MAX_RETRIES,
    EMAIL_RETRY_DELAY_MINUTES,
};
