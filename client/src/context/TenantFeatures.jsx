import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import api from "../services/api";
import socket from "../services/socket";
import { isFeatureEnabled, readStoredFeatures, storeFeatures } from "../utils/tenantFeatures";
import { TenantFeaturesContext } from "./tenantFeaturesContext";

// ==========================================
// TENANT FEATURES (React context)
//
// Holds the list of modules the signed-in company may use, for the portal to decide what to SHOW. The server enforces
// it regardless (see utils/tenantFeatures.js).
//
//   * Legacy Reinsteins session (no company stored)  -> features = null = every module, nothing is ever fetched.
//   * Company session                                -> the list from sign-in, refreshed from GET /tenant-auth/me, and kept
//     current by three signals, so an Owner change reaches a screen that is already open WITHOUT a page reload:
//        1. the socket event "tenant:features-changed" (sent to every connected user of the company),
//        2. any API answer FEATURE_NOT_ENABLED (api.js raises "tenant-features-denied"),
//        3. the browser tab regaining focus.
//
// While a company session has no list yet, `ready` is false and nothing renders (see TenantFeaturesProvider), so a module
// the company does not have is never mounted and never asks for its data, not even for a moment.
// ==========================================

const hasCompanySession = () => {
  try {
    return Boolean(sessionStorage.getItem("company"));
  } catch {
    return false;
  }
};

export function TenantFeaturesProvider({ children }) {
  const tenant = useRef(hasCompanySession());
  const [features, setFeatures] = useState(() => (tenant.current ? readStoredFeatures() : null));
  const [ready, setReady] = useState(() => !tenant.current || readStoredFeatures() !== null);
  const mounted = useRef(true);

  const apply = useCallback((list) => {
    if (!mounted.current || !Array.isArray(list)) return;
    storeFeatures(list);
    setFeatures(list);
    setReady(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!tenant.current) return;
    try {
      const response = await api.get("/tenant-auth/me");
      apply(response.data?.company?.features);
    } catch {
      // A failed refresh keeps what is on screen; a rejected session is handled by ProtectedRoute / the 401 interceptor.
      if (mounted.current) setReady(true);
    }
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    if (!tenant.current) return undefined;

    refresh();

    const onChanged = (message) => apply(message?.features);
    const onDenied = () => refresh();
    const onFocus = () => refresh();

    socket.on("tenant:features-changed", onChanged);
    window.addEventListener("tenant-features-denied", onDenied);
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      socket.off("tenant:features-changed", onChanged);
      window.removeEventListener("tenant-features-denied", onDenied);
      window.removeEventListener("focus", onFocus);
    };
  }, [apply, refresh]);

  const value = useMemo(
    () => ({ features, ready, isEnabled: (featureId) => isFeatureEnabled(features, featureId), refresh }),
    [features, ready, refresh]
  );

  if (!ready) return null;
  return <TenantFeaturesContext.Provider value={value}>{children}</TenantFeaturesContext.Provider>;
}

