import { Navigate } from "react-router-dom";
import { FaLock } from "react-icons/fa";

import EmptyState from "../UI/EmptyState";
import { useTenantFeatures } from "../../context/tenantFeaturesContext";
import { FEATURE_DISABLED_MESSAGE, firstEnabledLanding } from "../../utils/tenantFeatures";

import "./FeatureGate.css";

// ==========================================
// FEATURE GATE (route level)
//
// Wraps a module's page. When the company does not have the module, the page is NOT rendered at all -- so it never mounts and
// never requests its data -- and a clear notice takes its place. (The server refuses the module's APIs regardless; this is
// what the user sees instead of a broken page, including after the Owner switches a module off while it is open.)
//
// `landing`: used for the portal's home page. If the dashboard itself is not enabled, send the user to the first module that
// is, instead of showing a dead end. (Relative redirect: resolves under the current portal, /admin or /:company/employee ...)
// ==========================================

export function FeatureDisabled() {
  return (
    <div className="feature-disabled" data-testid="feature-disabled">
      <EmptyState
        icon={<FaLock />}
        title={FEATURE_DISABLED_MESSAGE}
        description="If you think you should have access, please contact your administrator."
      />
    </div>
  );
}

function FeatureGate({ feature, landing = false, portal = "employee", children }) {
  const { features, isEnabled } = useTenantFeatures();

  if (!feature || isEnabled(feature)) return children;

  if (landing) {
    const target = firstEnabledLanding(features, portal);
    if (target) return <Navigate to={target} replace />;
  }

  return <FeatureDisabled />;
}

export default FeatureGate;
