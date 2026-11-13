import { FaEnvelope } from "react-icons/fa";

import DemoRequestForm from "../../components/Public/DemoRequestForm";
import usePageMeta from "../../hooks/usePageMeta";
import "./InnerPage.css";
import "./Contact.css";

// ==========================================
// CONTACT / REQUEST DEMO PAGE
//
// The form (components/Public/DemoRequestForm.jsx) submits to POST /api/public/demo-request -- a public, unauthenticated endpoint that
// ONLY inserts a row into the platform database's demo_requests table. It can never create a company or a tenant database.
// ==========================================

function Contact() {
  usePageMeta(
    "Request a Demo – ZioVenture",
    "Tell us about your company and we will get in touch to schedule a ZioVenture walkthrough."
  );

  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="ws-eyebrow">Contact</span>
          <h1 className="pub-h1">Request a Demo</h1>
          <p className="pub-lede">
            Tell us a bit about your company and we will be in touch to schedule a walkthrough.
          </p>
        </div>
      </section>

      <section className="pub-section pub-contact-section">
        <div className="pub-container pub-contact-grid">

          <div className="pub-contact-card">
            <DemoRequestForm idPrefix="contact" />
          </div>

          <div className="pub-contact-side">
            <h2 className="pub-h3">What happens next?</h2>
            <p><FaEnvelope aria-hidden="true" /> Submit the form and our team will reach out directly.</p>
            <p className="pub-contact-note">
              No account or payment information is needed to request a demo.
            </p>
          </div>

        </div>
      </section>

    </div>
  );
}

export default Contact;
