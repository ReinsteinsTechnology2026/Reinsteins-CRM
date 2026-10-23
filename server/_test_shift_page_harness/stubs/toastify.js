const log = (type) => (message) => { (globalThis.__toasts ||= []).push({ type, message }); };
export const toast = { success: log("success"), error: log("error"), info: log("info") };
