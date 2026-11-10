import { Link } from "react-router-dom";
import { FaCheck, FaKey } from "react-icons/fa";

import { Reveal, usePageMeta } from "../../components/Public/motion";
import { MODULES, ZIOVAULT_CAPABILITIES } from "./siteContent";

import "./InnerPage.css";

// ==========================================
// FEATURES PAGE
// Every module and capability comes from siteContent.js, which was checked against the implemented product. Each module has an id so
// the home page's "View details" links (/features#employee-management and so on) land on it.
// ==========================================

const PLATFORM_ITEMS = [
  { name: "Role-based access", copy: "Administrator, executive and employee portals with permission levels." },
  { name: "Company data isolation", copy: "Every company operates on its own isolated database." },
  { name: "Secure file access", copy: "Uploaded files are authenticated and access-controlled, not publicly guessable." },
  { name: "Real-time collaboration", copy: "Chat, meetings and notifications stay correctly scoped to your own company." },
  { name: "Owner-controlled modules", copy: "The platform owner chooses which modules each company can use." },
];

function Features() {
  usePageMeta(
    "Features – ZioVenture",
    "Explore every ZioVenture module: employees, attendance, leave, shifts, tasks, TechOps, reports, chat, meetings, SOPs, Smart Sheets, company email and the ZioVault password vault."
  );

  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="ws-eyebrow">Features</span>
          <h1 className="pub-h1">Everything built into ZioVenture today</h1>
          <p className="pub-lede">A working feature set, organized the way your organization already thinks about work.</p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container">
          <div className="pub-module-list">
            {MODULES.map(({ id, icon: Icon, name, description, problem, capabilities, benefit }) => (
              <Reveal as="article" className="pub-module-row" id={id} key={id}>
                <div className="pub-module-head">
                  <span className="ws-icon"><Icon aria-hidden="true" /></span>
                  <h2>{name}</h2>
                  <p>{description}</p>
                </div>
                <div className="pub-module-body">
                  <p><b>The problem</b>{problem}</p>
                  <ul>
                    {capabilities.map((capability) => (
                      <li key={capability}><FaCheck aria-hidden="true" /> {capability}</li>
                    ))}
                  </ul>
                  <p><b>The benefit</b>{benefit}</p>
                </div>
              </Reveal>
            ))}

            <Reveal as="article" className="pub-module-row pub-module-vault" id="ziovault">
              <div className="pub-module-head">
                <span className="ws-icon"><FaKey aria-hidden="true" /></span>
                <h2>ZioVault</h2>
                <p>The secure password and secrets management component of ZioVenture.</p>
              </div>
              <div className="pub-module-body">
                <ul className="pub-two-col">
                  {ZIOVAULT_CAPABILITIES.map((item) => (
                    <li key={item.name}><FaCheck aria-hidden="true" /> <span><strong>{item.name}</strong> {item.copy}</span></li>
                  ))}
                </ul>
                <Link to="/#security" className="ws-link">How ZioVault protects your secrets</Link>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="pub-section pub-section-subtle">
        <div className="pub-container">
          <Reveal className="pub-category-title">Platform and security</Reveal>
          <div className="pub-feature-list">
            {PLATFORM_ITEMS.map((item) => (
              <Reveal className="pub-feature-item" key={item.name}>
                <FaCheck aria-hidden="true" />
                <div><strong>{item.name}</strong>{item.copy}</div>
              </Reveal>
            ))}
          </div>
          <div className="ws-center"><Link to="/#demo" className="ws-btn ws-btn-primary">Request a Demo</Link></div>
        </div>
      </section>

    </div>
  );
}

export default Features;
