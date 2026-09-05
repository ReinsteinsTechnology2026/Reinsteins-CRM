import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { FaArrowRight, FaShieldAlt } from "react-icons/fa";

import "./InnerPage.css";
import "./PortalLogin.css";

// ==========================================
// PORTAL LOGIN SELECTOR (Phase 6)
//
// The public "Login" button's destination. Does NOT itself
// authenticate anyone or look up any company -- it only normalizes
// whatever the user types and navigates to /:companySlug/login,
// where Phase 5's existing Login.jsx takes over (including its own
// GET /api/tenant-auth/:companySlug/info lookup and "company not
// found" handling). This page reveals nothing about which slugs are
// valid; it doesn't call the backend at all.
//
// Platform Owner login is a small, secondary link only -- not a
// primary button -- per the explicit "don't expose it prominently"
// instruction.
// ==========================================

function PortalLogin() {
  const navigate = useNavigate();
  const [slug, setSlug] = useState("");

  const handleSubmit = (event) => {
    event.preventDefault();

    const normalized = slug.trim().toLowerCase().replace(/\s+/g, "_");

    if (!normalized) return;

    navigate(`/${normalized}/login`);
  };

  return (
    <div className="pub-inner-page">

      <section className="pub-portal-login-section">
        <div className="pub-container pub-portal-login-container">

          <div className="pub-portal-login-card">

            <span className="pub-eyebrow">Company Portal Login</span>
            <h1 className="pub-h2">Sign in to your company</h1>
            <p className="pub-lede pub-portal-login-lede">
              Enter your company's ID to go to its portal login.
            </p>

            <form onSubmit={handleSubmit} className="pub-portal-login-form">
              <div className="pub-form-group">
                <label htmlFor="company-slug-input">Company ID</label>
                <input
                  id="company-slug-input"
                  type="text"
                  placeholder="e.g. reinsteins"
                  value={slug}
                  onChange={(event) => setSlug(event.target.value)}
                  autoFocus
                />
                <p className="pub-form-hint">This is your company's unique portal name, given to you by your administrator.</p>
              </div>

              <button type="submit" className="pub-btn pub-btn-primary pub-portal-login-submit">
                Continue <FaArrowRight />
              </button>
            </form>

          </div>

          <div className="pub-portal-login-footer">
            <Link to="/platform/login" className="pub-portal-owner-link">
              <FaShieldAlt /> ZioVenture Platform Owner Login
            </Link>
          </div>

        </div>
      </section>

    </div>
  );
}

export default PortalLogin;
