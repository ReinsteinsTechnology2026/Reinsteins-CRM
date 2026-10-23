// Minimal event emitter standing in for socket.io-client (no network)
const handlers = {};
const socket = {
    on: (name, fn) => { (handlers[name] ||= new Set()).add(fn); },
    off: (name, fn) => { handlers[name]?.delete(fn); },
    emit: (name, payload) => { for (const fn of [...(handlers[name] || [])]) fn(payload); },
};
export const connectSocket = () => {};
export default socket;
