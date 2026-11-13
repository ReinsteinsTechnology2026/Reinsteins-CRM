import { Link } from "react-router-dom";

import ZioVentureLogo from "../Common/ZioVentureLogo";

import "./PublicFooter.css";

function PublicFooter() {
  return (
    <footer className="pub-footer">
      <div className="pub-container pub-footer-inner">

        <div className="pub-footer-brand">
          <Link to="/" className="pub-footer-logo" aria-label="ZioVenture home"><ZioVentureLogo size={44} /></Link>
          <p>One connected platform for your people, projects, communication and secrets management.</p>
          <Link to="/#demo" className="ws-btn ws-btn-primary pub-footer-cta">Request a Demo</Link>
        </div>

        <nav className="pub-footer-cols" aria-label="Footer">

          <div className="pub-footer-col">
            <h4>Product</h4>
            <Link to="/#platform">Platform</Link>
            <Link to="/#modules">Modules</Link>
            <Link to="/features">Features</Link>
            <Link to="/#security">ZioVault</Link>
            <Link to="/#owner-portal">Owner Portal</Link>
          </div>

          <div className="pub-footer-col">
            <h4>Company</h4>
            <Link to="/solutions">Solutions</Link>
            <Link to="/pricing">Pricing</Link>
            <Link to="/about">About</Link>
            <Link to="/contact">Contact</Link>
            <Link to="/#faq">FAQ</Link>
          </div>

          <div className="pub-footer-col">
            <h4>Portal</h4>
            <Link to="/login">Company Login</Link>
            <Link to="/owner/login">Platform Owner</Link>
          </div>

        </nav>

      </div>

      <div className="pub-container pub-footer-bottom">
        <span>© {new Date().getFullYear()} ZioVenture. All rights reserved.</span>
      </div>
    </footer>
  );
}

export default PublicFooter;
