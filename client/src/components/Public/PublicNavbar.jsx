import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { FaBars, FaTimes } from "react-icons/fa";

import ZioVentureLogo from "../Common/ZioVentureLogo";

import "./PublicNavbar.css";

// ==========================================
// PUBLIC NAVBAR
// Shared by every public marketing page. "Login" goes to /login (the portal selector), never straight to a tenant or the Owner Portal.
// Entries that start with "/#" scroll to a section of the home page; the rest are routes.
// ==========================================

const NAV_LINKS = [
  { to: "/#platform", label: "Platform" },
  { to: "/features", label: "Features" },
  { to: "/solutions", label: "Solutions" },
  { to: "/#security", label: "Security" },
  { to: "/pricing", label: "Pricing" },
  { to: "/about", label: "About" },
  { to: "/contact", label: "Contact" },
];

function PublicNavbar() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();

  const close = () => setMenuOpen(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // the open menu locks page scroll and closes on Escape
  useEffect(() => {
    if (!menuOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const isHashActive = (to) => location.pathname === "/" && `/${location.hash}` === to;

  return (
    <header className={`pub-navbar${scrolled ? " is-scrolled" : ""}`}>
      <div className="pub-container pub-navbar-inner">

        <Link to="/" className="pub-navbar-brand" onClick={close} aria-label="ZioVenture home">
          <ZioVentureLogo size={40} />
        </Link>

        <nav id="pub-nav" className={`pub-navbar-links${menuOpen ? " open" : ""}`} aria-label="Main">
          {NAV_LINKS.map((link) =>
            link.to.startsWith("/#") ? (
              <Link
                key={link.to}
                to={link.to}
                className={`pub-navbar-link${isHashActive(link.to) ? " active" : ""}`}
                onClick={close}
              >
                {link.label}
              </Link>
            ) : (
              <NavLink
                key={link.to}
                to={link.to}
                className={({ isActive }) => `pub-navbar-link${isActive ? " active" : ""}`}
                onClick={close}
              >
                {link.label}
              </NavLink>
            )
          )}

          <div className="pub-navbar-actions">
            <Link to="/login" className="ws-btn ws-btn-outline pub-navbar-login" onClick={close}>Login</Link>
            <Link to="/#demo" className="ws-btn ws-btn-primary pub-navbar-demo" onClick={close}>Request a Demo</Link>
          </div>
        </nav>

        <button
          type="button"
          className="pub-navbar-toggle"
          onClick={() => setMenuOpen((current) => !current)}
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          aria-controls="pub-nav"
        >
          {menuOpen ? <FaTimes /> : <FaBars />}
        </button>

      </div>
      {menuOpen && <button type="button" className="pub-navbar-scrim" aria-label="Close menu" onClick={close} tabIndex={-1} />}
    </header>
  );
}

export default PublicNavbar;
