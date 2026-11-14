const { EventEmitter } = require("events");

// A tiny in-process event bus between the mail services and the Socket.IO server (wired in app.js).
//   "new-mail"   { companyId, userId, accountId, provider, count, latest: { from, subject }, unreadTotal }
//   "reauth"     { companyId, userId, accountId, provider }        the provider rejected the stored sign-in
//   "sync-error" { companyId, userId, accountId, provider, message }
//   "accounts"   { companyId, userId }                             the set of accounts / their state changed
// Listeners must never throw into the emitter: the services wrap emit() so a faulty listener cannot break a sync.
const bus = new EventEmitter();
bus.setMaxListeners(20);

function safeEmit(name, payload) {
    try {
        bus.emit(name, payload);
    } catch (error) {
        console.error(`[email-events] listener for "${name}" failed:`, error && error.message);
    }
}

module.exports = { bus, safeEmit };
