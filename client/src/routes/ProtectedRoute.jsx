import {
  useEffect,
  useState,
} from "react";

import {
  Navigate,
  useParams,
} from "react-router-dom";

import api from "../services/api";

// ==========================================
// COMPANY-AWARE ROUTE PROTECTION (Phase 5)
//
// When this component is rendered under a company-scoped route
// (e.g. "/:companySlug/admin/..."), useParams() below picks up
// companySlug automatically -- no prop needed, no new component.
// Under the existing unprefixed routes ("/admin/...", "/employee/...")
// companySlug is simply undefined, and every branch below that checks
// it falls through to the EXACT verification/redirect behavior this
// component already had -- so legacy Reinsteins routes are
// byte-identical in behavior to before this phase.
//
// The critical security property lives entirely in the
// company-scoped branch: it verifies against GET /api/tenant-auth/me
// (protected by the backend's tenantProtect, which re-resolves the
// caller's company FRESH from their JWT on every request -- see
// tenantAuthMiddleware.js) and compares the SERVER-RETURNED company
// slug against the URL's companySlug param. A user cannot get this
// check to pass for a company other than the one their actual token
// belongs to by editing the URL, localStorage, or anything else
// client-side -- the comparison is always against what the backend
// verified, never against what the URL merely claims.
// ==========================================

function ProtectedRoute({
  children,
  allowedRole,
}) {
  const { companySlug } = useParams();

  const [
    loading,
    setLoading,
  ] = useState(true);

  const [
    authenticated,
    setAuthenticated,
  ] = useState(false);

  const [
    user,
    setUser,
  ] = useState(null);

  // Only set when companySlug is present -- the company the caller's
  // token ACTUALLY resolves to, straight from the backend. Used to
  // redirect a user who edited the URL to point at a different
  // company back to their own, real company's dashboard.
  const [
    actualCompanySlug,
    setActualCompanySlug,
  ] = useState(null);

  // ==========================================
  // VERIFY AUTHENTICATION
  // ==========================================

  useEffect(() => {
    const verifyAuthentication =
      async () => {
        const token =
          sessionStorage.getItem(
            "token"
          );

        const storedUser =
          sessionStorage.getItem(
            "user"
          );

        // No session found
        if (
          !token ||
          !storedUser
        ) {
          setAuthenticated(
            false
          );

          setLoading(
            false
          );

          return;
        }

        // Parse stored user
        let parsedUser;

        try {
          parsedUser =
            JSON.parse(
              storedUser
            );
        } catch (error) {
          console.error(
            "Invalid stored user:",
            error
          );

          sessionStorage.removeItem(
            "token"
          );

          sessionStorage.removeItem(
            "user"
          );

          setAuthenticated(
            false
          );

          setLoading(
            false
          );

          return;
        }

        try {

          if (companySlug) {

            // Company-scoped route: verify via the tenant-aware
            // endpoint and cross-check the company it resolves to.
            const response =
              await api.get(
                "/tenant-auth/me"
              );

            const resolvedSlug =
              response.data?.company?.slug;

            setActualCompanySlug(
              resolvedSlug || null
            );

            if (
              resolvedSlug !==
              companySlug
            ) {
              // Authenticated, but for a DIFFERENT company than this
              // URL claims -- never render this route's children.
              setUser(
                parsedUser
              );

              setAuthenticated(
                false
              );

              setLoading(
                false
              );

              return;
            }

            setUser(
              response.data.user || parsedUser
            );

            setAuthenticated(
              true
            );

          } else {

            // Legacy, unprefixed route -- unchanged from before this
            // phase.
            await api.get(
              "/auth/verify"
            );

            setUser(
              parsedUser
            );

            setAuthenticated(
              true
            );

          }

        } catch (error) {
          console.error(
            "Authentication verification failed:",
            error
          );

          // Remove invalid session
          sessionStorage.removeItem(
            "token"
          );

          sessionStorage.removeItem(
            "user"
          );

          setUser(
            null
          );

          setAuthenticated(
            false
          );
        } finally {
          setLoading(
            false
          );
        }
      };

    verifyAuthentication();
  }, [companySlug]);

  // ==========================================
  // LOADING
  // ==========================================

  if (loading) {
    return (
      <div
        style={{
          minHeight:
            "100vh",

          display:
            "flex",

          alignItems:
            "center",

          justifyContent:
            "center",
        }}
      >
        <h3>
          Loading...
        </h3>
      </div>
    );
  }

  // ==========================================
  // NOT AUTHENTICATED
  // (or authenticated for a DIFFERENT company than this URL --
  // companySlug !== actualCompanySlug, handled the same way: never
  // render this route's children)
  // ==========================================

  if (
    !authenticated
  ) {
    if (companySlug) {

      // Authenticated, but for a different, real company (the URL
      // was edited/guessed) -- send them to THEIR OWN company's own
      // dashboard, never render anything for the URL's company.
      if (actualCompanySlug) {
        const ownRolePath =
          user?.role === "admin" ? "admin" : "employee";

        return (
          <Navigate
            to={`/${actualCompanySlug}/${ownRolePath}`}
            replace
          />
        );
      }

      // No valid session at all for this company route.
      return (
        <Navigate
          to={`/${companySlug}/login`}
          replace
        />
      );
    }

    // Legacy, unprefixed route -- "/" is now the public marketing
    // homepage (Phase 6), not a login form, so an unauthenticated
    // legacy admin/employee request goes to the actual legacy login
    // form instead.
    return (
      <Navigate
        to="/legacy-login"
        replace
      />
    );
  }

  // ==========================================
  // ROLE CHECK
  // ==========================================

  if (
    allowedRole &&
    user?.role !==
      allowedRole
  ) {
    const adminPath =
      companySlug ? `/${companySlug}/admin` : "/admin";

    const employeePath =
      companySlug ? `/${companySlug}/employee` : "/employee";

    const fallbackPath =
      companySlug ? `/${companySlug}/login` : "/legacy-login";

    if (
      user?.role ===
      "admin"
    ) {
      return (
        <Navigate
          to={adminPath}
          replace
        />
      );
    }

    if (
      user?.role ===
      "employee"
    ) {
      return (
        <Navigate
          to={employeePath}
          replace
        />
      );
    }

    return (
      <Navigate
        to={fallbackPath}
        replace
      />
    );
  }

  // ==========================================
  // ACCESS GRANTED
  // ==========================================

  return children;
}

export default ProtectedRoute;