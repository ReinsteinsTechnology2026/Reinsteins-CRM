import { Link } from "react-router-dom";
import { FaCheck } from "react-icons/fa";

import "./InnerPage.css";
import "./Pricing.css";

// ==========================================
// PRICING PAGE (Phase 6)
//
// No payment processing, no automated billing, no fixed prices --
// every plan routes to /contact (Request a Demo / Contact Us). The
// three tiers map onto the access types the platform already
// supports (complimentary / trial / paid), presented as marketing
// plans rather than exposing that internal terminology directly.
// Ready to wire up real billing later without changing this page's
// structure.
// ==========================================

const PLANS = [
  {
    name: "Starter",
    tagline: "For small teams getting organized.",
    features: [
      "Employee & department management",
      "Attendance tracking",
      "Leave management",
      "Team chat",
      "Admin & employee portals",
    ],
  },
  {
    name: "Professional",
    tagline: "For growing companies that need full project & team tools.",
    featured: true,
    features: [
      "Everything in Starter",
      "Projects, tasks, epics & sprints",
      "Meetings with screen sharing",
      "Real-time notifications",
      "Secure file sharing",
      "Reports & exports",
    ],
  },
  {
    name: "Enterprise",
    tagline: "For organizations with multiple departments and custom needs.",
    features: [
      "Everything in Professional",
      "Dedicated company database",
      "Priority support",
      "Custom onboarding",
      "Volume-based terms",
    ],
  },
];

function Pricing() {
  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="pub-eyebrow">Pricing</span>
          <h1 className="pub-h1">Plans built to grow with you</h1>
          <p className="pub-lede">
            ZioVenture pricing is tailored to your organization's size and needs. Contact us for a plan that fits.
          </p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container">
          <div className="pub-grid pub-grid-3">
            {PLANS.map((plan) => (
              <div className={`pub-pricing-card${plan.featured ? " featured" : ""}`} key={plan.name}>
                {plan.featured && <span className="pub-pricing-badge">Most Popular</span>}
                <div className="pub-pricing-name">{plan.name}</div>
                <div className="pub-pricing-price">Contact for Pricing</div>
                <p className="pub-pricing-tagline">{plan.tagline}</p>
                <ul className="pub-pricing-features">
                  {plan.features.map((feature) => (
                    <li key={feature}><FaCheck />{feature}</li>
                  ))}
                </ul>
                <Link
                  to="/contact"
                  className={`pub-btn ${plan.featured ? "pub-btn-primary" : "pub-btn-outline"}`}
                >
                  Request a Demo
                </Link>
              </div>
            ))}
          </div>

          <p className="pub-pricing-note">
            No automated billing yet — every plan is set up directly with our team.
            Reach out and we'll help you find the right fit.
          </p>
        </div>
      </section>

    </div>
  );
}

export default Pricing;
