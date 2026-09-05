import { useState } from "react";
import { NavLink, Link } from "react-router-dom";
import { FaBars, FaTimes } from "react-icons/fa";

import "./PublicNavbar.css";

// ==========================================
// PUBLIC NAVBAR (Phase 6)
// Shared across every public marketing page. The "Login" button
// goes to /login (the portal selector -- see pages/Public/PortalLogin.jsx),
// never directly to /platform/login or any tenant-specific URL.
// ==========================================

const NAV_LINKS = [
  { to: "/features", label: "Features" },
  { to: "/solutions", label: "Solutions" },
  { to: "/pricing", label: "Pricing" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
];

function PublicNavbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="pub-navbar">
      <div className="pub-container pub-navbar-inner">

        <Link to="/" className="pub-navbar-brand" onClick={() => setMenuOpen(false)}>
          <span className="brand-zio">Zio</span><span className="brand-venture">Venture</span>
        </Link>

        <nav className={`pub-navbar-links${menuOpen ? " open" : ""}`}>
          {NAV_LINKS.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              className={({ isActive }) => `pub-navbar-link${isActive ? " active" : ""}`}
              onClick={() => setMenuOpen(false)}
            >
              {link.label}
            </NavLink>
          ))}

          <Link to="/login" className="pub-btn pub-btn-primary pub-btn-sm pub-navbar-login" onClick={() => setMenuOpen(false)}>
            Login
          </Link>
        </nav>

        <button
          className="pub-navbar-toggle"
          onClick={() => setMenuOpen((current) => !current)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
        >
          {menuOpen ? <FaTimes /> : <FaBars />}
        </button>

      </div>
    </header>
  );
}

export default PublicNavbar;
