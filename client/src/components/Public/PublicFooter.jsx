import { Link } from "react-router-dom";

import "./PublicFooter.css";

function PublicFooter() {
  return (
    <footer className="pub-footer">
      <div className="pub-container pub-footer-inner">

        <div className="pub-footer-brand">
          <span className="pub-navbar-brand">
            <span className="brand-zio">Zio</span><span className="brand-venture">Venture</span>
          </span>
          <p>One platform for employees, work, and daily operations.</p>
        </div>

        <div className="pub-footer-cols">

          <div className="pub-footer-col">
            <h4>Product</h4>
            <Link to="/features">Features</Link>
            <Link to="/solutions">Solutions</Link>
            <Link to="/pricing">Pricing</Link>
          </div>

          <div className="pub-footer-col">
            <h4>Company</h4>
            <Link to="/about">About</Link>
            <Link to="/contact">Contact</Link>
          </div>

          <div className="pub-footer-col">
            <h4>Portal</h4>
            <Link to="/login">Company Login</Link>
            <Link to="/owner/login">Platform Owner</Link>
          </div>

        </div>

      </div>

      <div className="pub-container pub-footer-bottom">
        <span>© {new Date().getFullYear()} ZioVenture. All rights reserved.</span>
      </div>
    </footer>
  );
}

export default PublicFooter;
