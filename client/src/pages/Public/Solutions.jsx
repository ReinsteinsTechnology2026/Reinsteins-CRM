import { Link } from "react-router-dom";
import { FaSeedling, FaLaptopCode, FaHandshake, FaGlobe, FaSitemap } from "react-icons/fa";

import "./InnerPage.css";
import "./Solutions.css";

// ==========================================
// SOLUTIONS PAGE (Phase 6)
// Describes who ZioVenture suits, in terms of how a company is
// structured/operates -- not specific industries or integrations
// that aren't actually supported.
// ==========================================

const SOLUTIONS = [
  {
    icon: FaSeedling,
    title: "Growing Companies",
    copy: "As headcount grows, spreadsheets and scattered tools stop working. ZioVenture gives you employee management, attendance, and leave in one place from day one.",
  },
  {
    icon: FaLaptopCode,
    title: "Technology Companies",
    copy: "Project and task management built around how software teams actually work — epics, user stories, sprints, and a full task activity trail.",
  },
  {
    icon: FaHandshake,
    title: "Service Businesses",
    copy: "Keep client-facing project work, internal tasks, and team communication organized under one company account.",
  },
  {
    icon: FaGlobe,
    title: "Distributed Teams",
    copy: "Team chat, meetings, and real-time notifications keep people in sync — wherever they're working from.",
  },
  {
    icon: FaSitemap,
    title: "Organizations with Multiple Departments",
    copy: "Department and designation structures, reporting lines, and role-based access built for organizations that aren't flat.",
  },
];

function Solutions() {
  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="pub-eyebrow">Solutions</span>
          <h1 className="pub-h1">Built for how your organization actually works</h1>
          <p className="pub-lede">
            ZioVenture adapts to the shape of your company, not the other way around.
          </p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container">
          <div className="pub-solutions-list">
            {SOLUTIONS.map(({ icon: Icon, title, copy }) => (
              <div className="pub-solution-row" key={title}>
                <div className="pub-card-icon"><Icon /></div>
                <div>
                  <h3 className="pub-h3">{title}</h3>
                  <p>{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pub-section pub-section-subtle pub-cta">
        <div className="pub-container pub-cta-inner">
          <h2 className="pub-h2">Not sure if ZioVenture fits your team?</h2>
          <p className="pub-lede">Tell us about your organization and we'll walk you through it.</p>
          <Link to="/contact" className="pub-btn pub-btn-primary">Request a Demo</Link>
        </div>
      </section>

    </div>
  );
}

export default Solutions;
