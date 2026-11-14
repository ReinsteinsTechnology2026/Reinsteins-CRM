import socket from "./socket";

// ==========================================
// LIVE EMAIL EVENTS
//
// The server pushes four events to the signed-in employee's own Socket.IO room (never to anyone else):
//   email:new        new unread mail arrived in a connected account  -> { accountId, count, latest:{from,subject}, unreadTotal }
//   email:reauth     a provider rejected the stored sign-in          -> { accountId }
//   email:sync-error synchronisation keeps failing for an account    -> { accountId }
//   email:accounts   the set of connected accounts changed           -> {}
// A window "zv:email-event" CustomEvent carries the same {name, payload}, which is how screens that are not mounted near the socket
// (and tests) can trigger the same handlers. subscribe() returns the function that removes every listener again.
// ==========================================

const NAMES = ["email:new", "email:reauth", "email:sync-error", "email:accounts"];

export function subscribeEmailEvents(callback) {
  const handlers = NAMES.map((name) => [name, (payload) => callback(name, payload || {})]);
  for (const [name, handler] of handlers) socket.on(name, handler);
  const onWindow = (event) => event.detail && NAMES.includes(event.detail.name) && callback(event.detail.name, event.detail.payload || {});
  window.addEventListener("zv:email-event", onWindow);
  return () => {
    for (const [name, handler] of handlers) socket.off(name, handler);
    window.removeEventListener("zv:email-event", onWindow);
  };
}
