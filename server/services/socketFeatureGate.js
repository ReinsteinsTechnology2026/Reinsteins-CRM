const { featureForSocketEvent } = require("../config/tenantFeatures");
const { disabledBody } = require("../middleware/featureGate");

// ==========================================
// SOCKET FEATURE GATE
//
// Builds the `onTenantEvent(eventName, handler)` function a connected socket registers all of its events through (app.js).
// An event that belongs to a module the company does not have is refused BEFORE its handler runs:
//   * with an acknowledgement callback -> the callback gets { success:false, code:"FEATURE_NOT_ENABLED", ... }
//   * without one                      -> the socket receives "feature:not-enabled" { event, ... }
//
// Who is asking comes from the verified token at connect time (socket.tenantContext.companyId), never from the event payload.
// The list is re-read on EVERY event (a few-second cache in the service), so switching a feature off takes effect for
// sockets that are already connected. A legacy socket has no companyId and keeps every module. If the configuration cannot
// be read the event is refused (fail closed).
//
// Events of one socket must keep reaching their handlers in the order they arrived (smartsheet:join before smartsheet:op), so
// the checks run one after another on a per-socket chain.
// ==========================================

function createOnTenantEvent({ socket, getEnabledFeatureIds, runWithTenantContext }) {
    let checkChain = Promise.resolve();

    async function verdictFor(eventName) {
        const featureId = featureForSocketEvent(eventName);
        const companyId = socket.tenantContext && socket.tenantContext.companyId;
        if (!featureId || !companyId) return { allowed: true };
        try {
            const enabled = await getEnabledFeatureIds(companyId);
            return enabled.includes(featureId) ? { allowed: true } : { allowed: false, featureId };
        } catch (error) {
            console.error("[feature-gate] socket check failed:", error.message);
            return { allowed: false, featureId };
        }
    }

    return function onTenantEvent(eventName, handler) {
        socket.on(eventName, async (...args) => {
            const verdict = await (checkChain = checkChain.then(() => verdictFor(eventName)));
            if (!verdict.allowed) {
                const body = disabledBody([verdict.featureId]);
                const ack = args.length > 0 && typeof args[args.length - 1] === "function" ? args[args.length - 1] : null;
                if (ack) ack(body);
                else socket.emit("feature:not-enabled", { event: eventName, ...body });
                return undefined;
            }
            return runWithTenantContext(socket.tenantContext, () => handler(...args));
        });
    };
}

module.exports = { createOnTenantEvent };
