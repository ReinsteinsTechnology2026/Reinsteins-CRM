import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import platformApi from "../services/platformApi";

// ==========================================
// PLATFORM PROTECTED ROUTE (Phase 4)
//
// Isolated counterpart to routes/ProtectedRoute.jsx (the tenant
// portal's route guard) -- deliberately not reused/extended, so
// tenant and platform auth stay two independent verification paths
// end to end (storage keys, API client, and now the guard itself).
//
// Verifies the CURRENT platformToken against the backend
// (GET /api/platform/auth/me, protected by platformProtect) on every
// mount rather than trusting a locally-stored flag -- a tenant JWT
// stored under "token" is never read here at all, and a platformToken
// that fails platformProtect's verification (wrong secret, revoked
// account, forged) is rejected the same way regardless of what's in
// sessionStorage.
// ==========================================

function PlatformProtectedRoute({ children }) {
  const [loading, setLoading] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    const verify = async () => {
      const token = sessionStorage.getItem("platformToken");

      if (!token) {
        setAuthenticated(false);
        setLoading(false);
        return;
      }

      try {
        await platformApi.get("/auth/me");
        setAuthenticated(true);
      } catch (error) {
        sessionStorage.removeItem("platformToken");
        sessionStorage.removeItem("platformUser");
        setAuthenticated(false);
      } finally {
        setLoading(false);
      }
    };

    verify();
  }, []);

  if (loading) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0B1220",
          color: "#E2E8F0",
        }}
      >
        Loading...
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/owner/login" replace />;
  }

  return children;
}

export default PlatformProtectedRoute;
