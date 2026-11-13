import { Link } from "react-router-dom";
import { FaCheck } from "react-icons/fa";

import { Reveal } from "../../components/Public/motion";
import usePageMeta from "../../hooks/usePageMeta";
import "./InnerPage.css";
import "./Pricing.css";

// ==========================================
// PRICING PAGE
//
// Contact-for-pricing only. The platform stores subscription plans for the platform owner, but the benefits of a named public tier are
// not defined anywhere that could be verified, so this page names no plans, publishes no prices and lists no per-plan features. It only
// states what is true: pricing is arranged with the team, and the platform owner chooses the modules a company uses.
// ==========================================

const STEPS = [
  { title: "Tell us about your organization", copy: "Request a demo and describe your team, your departments and what you want to manage." },
  { title: "See the modules that fit", copy: "We walk you through the modules relevant to your organization." },
  { title: "Agree the setup with our team", copy: "Your company is set up with the modules you choose, and pricing is agreed with our team." },
];

const POINTS = [
  "Pricing reflects the size and needs of your organization",
  "The platform owner chooses which modules your company can use",
  "Every company runs on its own isolated database",
  "No payment information is needed to request a demo",
];

function Pricing() {
  usePageMeta("Pricing – ZioVenture", "ZioVenture pricing is tailored to your organization. Request a demo to discuss your setup with our team.");

  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="ws-eyebrow">Pricing</span>
          <h1 className="pub-h1">Pricing tailored to your organization</h1>
          <p className="pub-lede">
            ZioVenture is set up directly with our team. We do not publish fixed prices; contact us and we will discuss what fits.
          </p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container pub-pricing-layout">
          <ol className="pub-steps">
            {STEPS.map((step, index) => (
              <Reveal as="li" key={step.title} delay={index * 60}>
                <span className="pub-step-num">{index + 1}</span>
                <div><h2>{step.title}</h2><p>{step.copy}</p></div>
              </Reveal>
            ))}
          </ol>

          <Reveal className="pub-pricing-card">
            <h2>What to expect</h2>
            <ul>
              {POINTS.map((point) => <li key={point}><FaCheck aria-hidden="true" /> {point}</li>)}
            </ul>
            <Link to="/#demo" className="ws-btn ws-btn-primary ws-btn-block">Request a Demo</Link>
            <Link to="/contact" className="ws-btn ws-btn-outline ws-btn-block">Contact us</Link>
          </Reveal>
        </div>
      </section>

    </div>
  );
}

export default Pricing;
