import { useState } from "react";
import { FaCheckCircle } from "react-icons/fa";

import api from "../../services/api";

// ==========================================
// DEMO REQUEST FORM (shared by the home page and /contact)
//
// Submits to POST /api/public/demo-request -- the same public endpoint, with the same payload, the Contact page has always used.
// It only inserts a demo request; it can never create a company. Success is shown ONLY after the server confirms it.
// ==========================================

const EMPLOYEE_COUNT_OPTIONS = ["", "1–10", "11–50", "51–200", "201–500", "500+"];

const INITIAL_FORM = { name: "", companyName: "", email: "", phone: "", employeeCount: "", message: "" };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(form) {
  const errors = {};
  if (!form.name.trim()) errors.name = "Please enter your name.";
  if (!form.companyName.trim()) errors.companyName = "Please enter your company name.";
  if (!form.email.trim()) errors.email = "Please enter your work email.";
  else if (!EMAIL_PATTERN.test(form.email.trim())) errors.email = "Please enter a valid email address.";
  return errors;
}

function DemoRequestForm({ idPrefix = "demo" }) {
  const [form, setForm] = useState(INITIAL_FORM);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);

  const handleChange = (field) => (event) => {
    const value = event.target.value;
    setForm((current) => ({ ...current, [field]: value }));
    if (fieldErrors[field]) setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError(null);

    const errors = validate(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const first = Object.keys(errors)[0];
      const target = document.getElementById(`${idPrefix}-${first === "companyName" ? "company" : first}`);
      if (target) target.focus();
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

  if (success) {
    return (
      <div className="ws-form-success" role="status">
        <FaCheckCircle aria-hidden="true" />
        <h3>Request received</h3>
        <p>Thank you. Our team will reach out shortly.</p>
      </div>
    );
  }

  const field = (name, label, props = {}) => {
    const id = `${idPrefix}-${name === "companyName" ? "company" : name}`;
    const message = fieldErrors[name];
    return (
      <div className={`ws-field${message ? " has-error" : ""}`}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={form[name]}
          onChange={handleChange(name)}
          aria-invalid={message ? "true" : "false"}
          aria-describedby={message ? `${id}-error` : undefined}
          {...props}
        />
        {message && <span className="ws-field-error" id={`${id}-error`}>{message}</span>}
      </div>
    );
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="ws-form">
      {error && <div className="ws-form-alert" role="alert">{error}</div>}

      <div className="ws-form-row">
        {field("name", "Name", { type: "text", placeholder: "Jane Doe", autoComplete: "name" })}
        {field("companyName", "Company name", { type: "text", placeholder: "Acme Inc.", autoComplete: "organization" })}
      </div>

      <div className="ws-form-row">
        {field("email", "Work email", { type: "email", placeholder: "jane@acme.com", autoComplete: "email" })}
        {field("phone", "Phone number (optional)", { type: "text", placeholder: "+1 555 0100", autoComplete: "tel" })}
      </div>

      <div className="ws-field">
        <label htmlFor={`${idPrefix}-size`}>Number of employees</label>
        <select id={`${idPrefix}-size`} value={form.employeeCount} onChange={handleChange("employeeCount")}>
          {EMPLOYEE_COUNT_OPTIONS.map((option) => (
            <option key={option || "none"} value={option}>{option || "Select a range"}</option>
          ))}
        </select>
      </div>

      <div className="ws-field">
        <label htmlFor={`${idPrefix}-message`}>Message (optional)</label>
        <textarea
          id={`${idPrefix}-message`}
          rows={4}
          value={form.message}
          onChange={handleChange("message")}
          placeholder="Tell us about your team and what you are looking for."
        />
      </div>

      <button type="submit" className="ws-btn ws-btn-primary ws-btn-block" disabled={submitting}>
        {submitting ? "Sending…" : "Request a demo"}
      </button>
    </form>
  );
}

export default DemoRequestForm;
