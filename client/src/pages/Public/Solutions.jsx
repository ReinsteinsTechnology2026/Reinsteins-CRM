import { Link } from "react-router-dom";

import { Reveal, usePageMeta } from "../../components/Public/motion";
import { SOLUTIONS } from "./siteContent";

import "./InnerPage.css";
import "./Solutions.css";

// ==========================================
// SOLUTIONS PAGE
// Describes who ZioVenture suits in terms of how a company is structured and operates. It does not claim industry-specific automation
// or integrations that have not been built.
// ==========================================

function Solutions() {
  usePageMeta(
    "Solutions – ZioVenture",
    "ZioVenture for small and medium businesses, growing organizations, IT and technology companies, operations teams and multi-department organizations."
  );

  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="ws-eyebrow">Solutions</span>
          <h1 className="pub-h1">Built for how your organization actually works</h1>
          <p className="pub-lede">ZioVenture adapts to the shape of your company, not the other way around.</p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container">
          <div className="pub-solutions-list">
            {SOLUTIONS.map(({ icon: Icon, title, copy }, index) => (
              <Reveal className="pub-solution-row" key={title} delay={(index % 2) * 80}>
                <span className="ws-icon"><Icon aria-hidden="true" /></span>
                <div>
                  <h2 className="pub-h3">{title}</h2>
                  <p>{copy}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="pub-section pub-section-subtle pub-cta">
        <div className="pub-container pub-cta-inner">
          <h2 className="pub-h2">Not sure if ZioVenture fits your team?</h2>
          <p className="pub-lede">Tell us about your organization and we will walk you through it.</p>
          <Link to="/#demo" className="ws-btn ws-btn-primary">Request a Demo</Link>
        </div>
      </section>

    </div>
  );
}

export default Solutions;
