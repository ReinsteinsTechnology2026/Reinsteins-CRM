const subscriptionLifecycleService = require("../services/subscriptionLifecycleService");
const { LIFECYCLE_SWEEP_INTERVAL_MS, LIFECYCLE_SWEEP_ENABLED } = require("../config/lifecycleConfig");

// ==========================================
// SUBSCRIPTION LIFECYCLE SWEEP (Phase 12C)
//
// Mirrors jobs/notificationSweep.js's exact shape (start/stop/
// runSweepOnce, unref'd interval, enabled/interval via config) --
// deliberately the same pattern, not a new one, kept as its own
// module for the same reason notificationSweep.js is separate: easy
// to find, disable, or reconfigure independently of request handling.
//
// All the actual decision logic lives in subscriptionLifecycleService
// .runSweepOnce() -- this file is purely the scheduling wrapper.
// Idempotency, dedup, and "does not touch tenant business data" are
// all guarantees of that service, not of the timer here.
// ==========================================

let intervalHandle = null;

function start() {

    if (!LIFECYCLE_SWEEP_ENABLED) {
        console.log("[subscriptionLifecycleSweep] Disabled via LIFECYCLE_SWEEP_ENABLED=false.");
        return;
    }

    if (intervalHandle) {
        clearInterval(intervalHandle);
    }

    intervalHandle = setInterval(() => {
        subscriptionLifecycleService.runSweepOnce().catch((error) => {
            console.error("[subscriptionLifecycleSweep] Sweep pass failed:", error.message);
        });
    }, LIFECYCLE_SWEEP_INTERVAL_MS);

    if (intervalHandle.unref) {
        intervalHandle.unref();
    }

    console.log(`[subscriptionLifecycleSweep] Started (interval: ${LIFECYCLE_SWEEP_INTERVAL_MS}ms).`);

}

function stop() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

module.exports = {
    start,
    stop,
    runSweepOnce: subscriptionLifecycleService.runSweepOnce,
};
