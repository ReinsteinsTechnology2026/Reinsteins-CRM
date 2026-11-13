import { Link } from "react-router-dom";
import { FaCheck, FaKey } from "react-icons/fa";

import { Reveal } from "../../components/Public/motion";
import usePageMeta from "../../hooks/usePageMeta";
import { MODULES, ZIOVAULT_CAPABILITIES } from "./siteContent";

import "./InnerPage.css";

// ==========================================
// FEATURES PAGE
// Every module and capability comes from siteContent.js, which was checked against the implemented product. Each module has an id so
// the home page's links (/features#employee-management and so on) land on it.
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
          <nav className="pub-jump" aria-label="Jump to a module">
            {MODULES.map((module) => <a key={module.id} href={`#${module.id}`}>{module.name}</a>)}
            <a href="#ziovault">ZioVault</a>
          </nav>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container">
          <div className="pub-module-grid">
            {MODULES.map(({ id, icon: Icon, name, description, problem, capabilities, benefit, note }, index) => (
              <Reveal as="article" className="pub-module-card" id={id} key={id} delay={(index % 2) * 60}>
                <header>
                  <span className="ws-icon"><Icon aria-hidden="true" /></span>
                  <div>
                    <h2>{name}</h2>
                    <p>{description}</p>
                  </div>
                </header>
                <dl>
                  <div><dt>Why it matters</dt><dd>{problem}</dd></div>
                  <div><dt>In daily operations</dt><dd>{benefit}</dd></div>
                </dl>
                <ul>
                  {capabilities.map((capability) => (
                    <li key={capability}><FaCheck aria-hidden="true" /> {capability}</li>
                  ))}
                </ul>
                {note && <p className="pub-module-note">{note}</p>}
              </Reveal>
            ))}

            <Reveal as="article" className="pub-module-card pub-module-vault" id="ziovault">
              <header>
                <span className="ws-icon"><FaKey aria-hidden="true" /></span>
                <div>
                  <h2>ZioVault</h2>
                  <p>The secure password and secrets management component of ZioVenture. Secrets are encrypted on the user's device, and
                    there is no administrator master key.</p>
                </div>
              </header>
              <ul className="pub-two-col">
                {ZIOVAULT_CAPABILITIES.map((item) => (
                  <li key={item.name}><FaCheck aria-hidden="true" /> <span><strong>{item.name}</strong> {item.copy}</span></li>
                ))}
              </ul>
              <Link to="/#security" className="ws-link">How ZioVault protects your secrets</Link>
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
