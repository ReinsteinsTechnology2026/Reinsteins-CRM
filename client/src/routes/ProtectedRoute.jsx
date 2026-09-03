import {
  useEffect,
  useState,
} from "react";

import {
  Navigate,
} from "react-router-dom";

import api from "../services/api";

function ProtectedRoute({
  children,
  allowedRole,
}) {
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
          // Verify JWT with backend
          await api.get(
            "/auth/verify"
          );

          // Token is valid
          setUser(
            parsedUser
          );

          setAuthenticated(
            true
          );
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
  }, []);

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
  // ==========================================

  if (
    !authenticated
  ) {
    return (
      <Navigate
        to="/"
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
    if (
      user?.role ===
      "admin"
    ) {
      return (
        <Navigate
          to="/admin"
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
          to="/employee"
          replace
        />
      );
    }

    return (
      <Navigate
        to="/"
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