import api from "../services/api";
import * as vault from "./crypto/index.js";
import { createVaultApi } from "./vaultApi.js";
import { createVaultSession, sanitizePrefs } from "./vaultSession.js";
import { createClipboard } from "./clipboard.js";

// ==========================================
// ZIOVAULT -- the one session of this browser tab, wired to the real CRM
//
// The vault session is app-wide (not tied to the page being shown), so navigating inside the CRM does not lock it -- the inactivity
// timer, the CRM sign-in watcher and "Lock" do. This is the ONLY file that touches browser storage on the vault's behalf:
//   localStorage   "ziovault:prefs"  -> { autoLockMinutes, clipboardClearSeconds, oldPasswordDays } -- numbers, nothing else
//   sessionStorage "ziovault:draft:*" -> a SEALED (ciphertext) copy of an item being edited when the vault locked
// Nothing decrypted, no key, no recovery key and no master password is ever written to either.
// ==========================================

const PREFS_KEY = "ziovault:prefs";

const prefsStore = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch {
      return {};
    }
  },
  save(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(sanitizePrefs(prefs)));
    } catch {
      // storage unavailable: the preference lasts for this page only
    }
  },
};

const draftStorage = {
  getItem: (key) => {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // not stored: the draft is dropped rather than kept in the clear
    }
  },
  removeItem: (key) => {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // nothing to remove
    }
  },
};

// Who is signed in, from the verified server answer for company sessions (never from anything the page could have edited).
export async function resolveIdentity() {
  let hasCompany = false;
  try {
    hasCompany = Boolean(sessionStorage.getItem("company"));
  } catch {
    hasCompany = false;
  }
  if (hasCompany) {
    const response = await api.get("/tenant-auth/me");
    const company = response.data && response.data.company;
    const user = response.data && response.data.user;
    if (!company || company.id === undefined || !user || user.id === undefined) throw new Error("The signed-in user could not be identified.");
    return { tenantId: String(company.id), userId: user.id, role: user.role, systemAccess: user.systemAccess };
  }
  const stored = JSON.parse(sessionStorage.getItem("user") || "null");
  if (!stored || stored.id === undefined) throw new Error("The signed-in user could not be identified.");
  return { tenantId: "legacy", userId: stored.id, role: stored.role, systemAccess: stored.systemAccess !== undefined ? stored.systemAccess : stored.system_access };
}

// Changes when the CRM sign-in ends or a different person signs in (a token's last characters are enough to notice).
const authFingerprint = () => {
  try {
    const token = sessionStorage.getItem("token") || "";
    return token ? token.slice(-16) : "";
  } catch {
    return "";
  }
};

function createChannel() {
  if (typeof BroadcastChannel === "undefined") return null;
  const channel = new BroadcastChannel("ziovault");
  return {
    post: (message) => channel.postMessage(message),
    onMessage: (handler) => {
      channel.onmessage = (event) => handler(event.data);
    },
    close: () => channel.close(),
  };
}

let instance = null;
let stopWatching = null;
let clipboardInstance = null;

export function getVaultSession() {
  if (instance) return instance;
  instance = createVaultSession({
    api: createVaultApi(api),
    vault,
    getIdentity: resolveIdentity,
    prefsStore,
    draftStorage,
    channel: createChannel(),
  });
  stopWatching = instance.watchAuth(authFingerprint);
  // whenever the vault closes (manual, inactivity, sign-out, expiry, another tab), take back anything we put on the clipboard
  let wasOpen = false;
  instance.subscribe(() => {
    const open = ["unlocked", "setup-recovery"].includes(instance.snapshot().status);
    if (wasOpen && !open && clipboardInstance) clipboardInstance.clearNow();
    wasOpen = open;
  });
  return instance;
}

export function getClipboard() {
  if (!clipboardInstance) {
    clipboardInstance = createClipboard({ getSeconds: () => getVaultSession().snapshot().prefs.clipboardClearSeconds });
  }
  return clipboardInstance;
}

// Used when the signed-in person changes, and by tests.
export async function resetVaultSession() {
  if (stopWatching) stopWatching();
  stopWatching = null;
  if (instance) {
    await instance.lock("logout", { broadcast: false });
    instance.dispose();
  }
  instance = null;
  if (clipboardInstance) await clipboardInstance.clearNow();
  clipboardInstance = null;
}
