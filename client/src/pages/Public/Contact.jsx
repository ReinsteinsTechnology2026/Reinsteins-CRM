import { useState } from "react";
import { FaEnvelope, FaCheckCircle } from "react-icons/fa";

import api from "../../services/api";
import "./InnerPage.css";
import "./Contact.css";

// ==========================================
// CONTACT / REQUEST DEMO PAGE (Phase 6)
//
// Submits to POST /api/public/demo-request -- a public, unauthenticated
// endpoint that ONLY inserts a row into groworgs_platform_db.demo_requests.
// This form can NEVER create a company or a tenant database: the
// backend handler (controllers/publicController.js) has no import of
// any provisioning service at all.
// ==========================================

const EMPLOYEE_COUNT_OPTIONS = [
  "", "1–10", "11–50", "51–200", "201–500", "500+",
];

const INITIAL_FORM = {
  name: "",
  companyName: "",
  email: "",
  phone: "",
  employeeCount: "",
  message: "",
};

function Contact() {
  const [form, setForm] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (field) => (event) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    if (!form.name.trim() || !form.companyName.trim() || !form.email.trim()) {
      setError("Name, company name, and work email are required.");
      return;
    }

    try {
      setSubmitting(true);

      await api.post("/public/demo-request", {
        name: form.name.trim(),
        companyName: form.companyName.trim(),
        email: form.email.trim(),
        phone: form.phone.trim() || undefined,
        employeeCount: form.employeeCount || undefined,
        message: form.message.trim() || undefined,
      });

      setSuccess(true);
      setForm(INITIAL_FORM);

    } catch (err) {
      setError(err.response?.data?.message || "Unable to submit your request. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="pub-eyebrow">Contact</span>
          <h1 className="pub-h1">Request a Demo</h1>
          <p className="pub-lede">
            Tell us a bit about your company and we'll be in touch to schedule a walkthrough.
          </p>
        </div>
      </section>

      <section className="pub-section pub-contact-section">
        <div className="pub-container pub-contact-grid">

          <div className="pub-contact-card">

            {success ? (
              <div className="pub-contact-success">
                <FaCheckCircle />
                <h3 className="pub-h3">Request received</h3>
                <p>Thank you — our team will reach out shortly.</p>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>

                {error && <div className="pub-alert pub-alert-danger">{error}</div>}

                <div className="pub-form-row">
                  <div className="pub-form-group">
                    <label htmlFor="contact-name">Name</label>
                    <input id="contact-name" type="text" value={form.name} onChange={handleChange("name")} placeholder="Jane Doe" />
                  </div>
                  <div className="pub-form-group">
                    <label htmlFor="contact-company">Company Name</label>
                    <input id="contact-company" type="text" value={form.companyName} onChange={handleChange("companyName")} placeholder="Acme Inc." />
                  </div>
                </div>

                <div className="pub-form-row">
                  <div className="pub-form-group">
                    <label htmlFor="contact-email">Work Email</label>
                    <input id="contact-email" type="email" value={form.email} onChange={handleChange("email")} placeholder="jane@acme.com" />
                  </div>
                  <div className="pub-form-group">
                    <label htmlFor="contact-phone">Phone Number (optional)</label>
                    <input id="contact-phone" type="text" value={form.phone} onChange={handleChange("phone")} placeholder="+1 555 0100" />
                  </div>
                </div>

                <div className="pub-form-group">
                  <label htmlFor="contact-size">Number of Employees</label>
                  <select id="contact-size" value={form.employeeCount} onChange={handleChange("employeeCount")}>
                    {EMPLOYEE_COUNT_OPTIONS.map((option) => (
                      <option key={option || "none"} value={option}>{option || "Select a range"}</option>
                    ))}
                  </select>
                </div>

                <div className="pub-form-group">
                  <label htmlFor="contact-message">Message</label>
                  <textarea id="contact-message" rows={4} value={form.message} onChange={handleChange("message")} placeholder="Tell us about your team and what you're looking for." />
                </div>

                <button type="submit" className="pub-btn pub-btn-primary pub-contact-submit" disabled={submitting}>
                  {submitting ? "Sending..." : "Request a Demo"}
                </button>

              </form>
            )}

          </div>

          <div className="pub-contact-side">
            <h3 className="pub-h3">What happens next?</h3>
            <p><FaEnvelope /> Submit the form and our team will reach out directly.</p>
            <p className="pub-contact-note">
              We typically respond within one business day. No account or payment
              information is needed to request a demo.
            </p>
          </div>

        </div>
      </section>

    </div>
  );
}

export default Contact;
