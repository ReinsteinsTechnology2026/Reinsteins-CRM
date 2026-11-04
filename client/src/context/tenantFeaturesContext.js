import { createContext, useContext } from "react";

// Kept apart from the provider component so the provider file exports only a component (fast refresh).
// The default value is what a legacy Reinsteins page (outside any provider) gets: every module enabled.
export const TenantFeaturesContext = createContext({ features: null, ready: true, isEnabled: () => true, refresh: () => {} });

export const useTenantFeatures = () => useContext(TenantFeaturesContext);
