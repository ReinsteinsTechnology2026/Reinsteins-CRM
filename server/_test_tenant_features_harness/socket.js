// Test stub for client/src/services/socket.js: a tiny event emitter the test can fire server events through.
const listeners = new Map();
const socket = {
  on: (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn]),
  off: (event, fn) => listeners.set(event, (listeners.get(event) || []).filter((entry) => entry !== fn)),
  emit: () => {},
  connected: true,
};
globalThis.__tenantFeaturesSocket = {
  fire: (event, payload) => (listeners.get(event) || []).forEach((fn) => fn(payload)),
  count: (event) => (listeners.get(event) || []).length,
};
export const connectSocket = () => {};
export const disconnectSocket = () => {};
export default socket;
