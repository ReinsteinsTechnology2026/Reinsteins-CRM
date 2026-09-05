import { Link } from "react-router-dom";
import { FaBullseye, FaShieldAlt, FaUsers } from "react-icons/fa";

import "./InnerPage.css";
import "./About.css";

// ==========================================
// ABOUT PAGE (Phase 6)
// General, honest copy about the platform's purpose and approach --
// no fabricated founding dates, team bios, or company facts that
// can't be verified.
// ==========================================

const VALUES = [
  {
    icon: FaBullseye,
    title: "Built to be used every day",
    copy: "ZioVenture is designed around the tools a company actually needs daily — employees, attendance, tasks, and communication — not a sprawling feature list nobody uses.",
  },
  {
    icon: FaShieldAlt,
    title: "Data isolation by design",
    copy: "Every company on ZioVenture runs on its own isolated database. Your organization's data is never mixed with another company's.",
  },
  {
    icon: FaUsers,
    title: "One platform, every role",
    copy: "Admins and employees each get a portal built for what they actually do, with permissions that follow real organizational roles.",
  },
];

function About() {
  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="pub-eyebrow">About ZioVenture</span>
          <h1 className="pub-h1">A single platform for how organizations run</h1>
          <p className="pub-lede">
            ZioVenture brings employee management, work management, and internal
            communication together — built as a multi-company platform from the ground up.
          </p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container pub-about-body">
          <p>
            ZioVenture started as the operating system behind a single, real company's
            day-to-day work — attendance, leave, projects, tasks, and internal
            communication all handled in one place. That same platform now powers
            multiple companies, each with its own fully isolated, secure environment.
          </p>
          <p>
            We built ZioVenture because most organizations end up stitching together
            separate tools for HR, project management, and communication. ZioVenture
            keeps that in one platform, with the security and structure a growing
            company needs.
          </p>
        </div>
      </section>

      <section className="pub-section pub-section-subtle">
        <div className="pub-container">
          <div className="pub-grid pub-grid-3">
            {VALUES.map(({ icon: Icon, title, copy }) => (
              <div className="pub-card" key={title}>
                <div className="pub-card-icon"><Icon /></div>
                <h3 className="pub-h3">{title}</h3>
                <p>{copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="pub-section pub-cta">
        <div className="pub-container pub-cta-inner">
          <h2 className="pub-h2">Want to see it for yourself?</h2>
          <Link to="/contact" className="pub-btn pub-btn-primary">Request a Demo</Link>
        </div>
      </section>

    </div>
  );
}

export default About;
