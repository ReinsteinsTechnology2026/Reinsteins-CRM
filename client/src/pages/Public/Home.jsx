import { useState } from "react";
import { Link } from "react-router-dom";
import { FaArrowRight, FaCheck, FaChevronDown, FaLock, FaEnvelope } from "react-icons/fa";

import { Reveal, CountUp, usePageMeta } from "../../components/Public/motion";
import { DashboardMock, FloatingChips, VaultMock, OwnerMock } from "../../components/Public/mockups";
import DemoRequestForm from "../../components/Public/DemoRequestForm";
import {
  MODULES, ZIOVAULT_CAPABILITIES, ZIOVAULT_CRYPTO, OWNER_POINTS, FLOWS, SOLUTIONS, WHY, FAQS, PLATFORM_PILLARS,
} from "./siteContent";

import "./Home.css";

// ==========================================
// PUBLIC HOME PAGE
// Every module, capability and security statement is taken from the implemented product (see siteContent.js). There are no customer
// statistics, testimonials, logos, certifications or prices on this page.
// ==========================================

function SectionHeader({ eyebrow, title, lede, light = false }) {
  return (
    <Reveal className={`ws-section-header${light ? " is-light" : ""}`}>
      <span className="ws-eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      {lede && <p>{lede}</p>}
    </Reveal>
  );
}

const PREVIEWS = [
  { id: "workspace", label: "Workspace", title: "Your daily operations, in one workspace", copy: "A role-based dashboard brings attendance, leave, tasks and communication together for administrators and employees.", Mock: DashboardMock },
  { id: "vault", label: "ZioVault", title: "A password vault your team can trust", copy: "Personal and company vaults with granular sharing, encrypted on the user's device.", Mock: VaultMock },
  { id: "owner", label: "Owner Portal", title: "Manage every company from one place", copy: "Create companies and choose which modules each one can use.", Mock: OwnerMock },
];

function ProductPreview() {
  const [active, setActive] = useState("workspace");
  const current = PREVIEWS.find((preview) => preview.id === active);
  const Mock = current.Mock;

  return (
    <div className="ws-preview">
      <div className="ws-tabs" role="tablist" aria-label="Product previews">
        {PREVIEWS.map((preview) => (
          <button
            key={preview.id}
            type="button"
            role="tab"
            id={`preview-tab-${preview.id}`}
            aria-selected={active === preview.id}
            aria-controls="preview-panel"
            className={`ws-tab${active === preview.id ? " active" : ""}`}
            onClick={() => setActive(preview.id)}
          >
            {preview.label}
          </button>
        ))}
      </div>
      <div className="ws-preview-stage" role="tabpanel" id="preview-panel" aria-labelledby={`preview-tab-${active}`}>
        <div className="ws-preview-copy" key={`copy-${active}`}>
          <h3>{current.title}</h3>
          <p>{current.copy}</p>
        </div>
        <div className="ws-preview-mock" key={`mock-${active}`}>
          <Mock />
        </div>
      </div>
    </div>
  );
}

function Flow({ flow }) {
  return (
    <Reveal className="ws-flow">
      <div className="ws-flow-head">
        <h3>{flow.title}</h3>
        <p>{flow.note}</p>
      </div>
      <ol className="ws-flow-steps">
        {flow.steps.map((step, index) => (
          <li key={step} style={{ "--i": index }}>
            <span className="ws-flow-node">{index + 1}</span>
            <span className="ws-flow-label">{step}</span>
          </li>
        ))}
      </ol>
    </Reveal>
  );
}

function Home() {
  usePageMeta(
    "ZioVenture – One Platform for Your People, Projects and Operations",
    "ZioVenture brings employee management, attendance, leave, tasks, projects, chat, meetings and the ZioVault password vault together in one connected platform."
  );

  return (
    <div className="ws-home">

      {/* ---------- HERO ---------- */}
      <section className="ws-hero" aria-labelledby="hero-title">
        <div className="ws-hero-bg" aria-hidden="true"><i /><i /><i /></div>
        <div className="ws-container ws-hero-grid">
          <div className="ws-hero-copy">
            <span className="ws-eyebrow ws-hero-in" style={{ "--d": "0ms" }}>ZioVenture Platform</span>
            <h1 id="hero-title" className="ws-hero-in" style={{ "--d": "80ms" }}>
              One Platform. <span>Complete Control Over Your Business.</span>
            </h1>
            <p className="ws-hero-in" style={{ "--d": "160ms" }}>
              ZioVenture brings your people, projects, communication, workflows and business operations together in one connected
              platform. Manage your organization with greater visibility, collaboration and control.
            </p>
            <div className="ws-hero-actions ws-hero-in" style={{ "--d": "240ms" }}>
              <Link to="/#demo" className="ws-btn ws-btn-primary">Request a Demo <FaArrowRight aria-hidden="true" /></Link>
              <Link to="/#modules" className="ws-btn ws-btn-ghost">Explore Features</Link>
            </div>
            <ul className="ws-hero-points ws-hero-in" style={{ "--d": "320ms" }}>
              <li><FaCheck aria-hidden="true" /> Isolated database per company</li>
              <li><FaCheck aria-hidden="true" /> Role-based portals</li>
              <li><FaCheck aria-hidden="true" /> Client-side encrypted vault</li>
            </ul>
          </div>
          <div className="ws-hero-visual ws-hero-in" style={{ "--d": "200ms" }}>
            <DashboardMock />
            <FloatingChips />
          </div>
        </div>
      </section>

      {/* ---------- PLATFORM OVERVIEW ---------- */}
      <section className="ws-section" id="platform" aria-labelledby="platform-title">
        <div className="ws-container">
          <SectionHeader
            eyebrow="Platform overview"
            title={<span id="platform-title">Everything your organization runs on, connected</span>}
            lede="Instead of stitching together separate tools for HR, projects, communication and credentials, ZioVenture gives each company one workspace."
          />
          <div className="ws-pillars">
            {PLATFORM_PILLARS.map(({ icon: Icon, title, copy }, index) => (
              <Reveal className="ws-pillar" key={title} delay={index * 80}>
                <span className="ws-icon"><Icon aria-hidden="true" /></span>
                <h3>{title}</h3>
                <p>{copy}</p>
              </Reveal>
            ))}
          </div>
          <Reveal className="ws-stats">
            <div><strong><CountUp end={MODULES.length} /></strong><span>integrated modules</span></div>
            <div><strong><CountUp end={ZIOVAULT_CAPABILITIES.length} /></strong><span>ZioVault capabilities</span></div>
            <div><strong>1</strong><span>isolated database per company</span></div>
          </Reveal>
        </div>
      </section>

      {/* ---------- MODULE DIRECTORY ---------- */}
      <section className="ws-section ws-section-tint" id="modules" aria-labelledby="modules-title">
        <div className="ws-container">
          <SectionHeader
            eyebrow="Complete module directory"
            title={<span id="modules-title">Twelve modules. One connected platform.</span>}
            lede="Each module solves a specific day-to-day problem. Your platform owner chooses which ones your company uses."
          />
          <div className="ws-modules">
            {MODULES.map(({ id, icon: Icon, name, description, problem, capabilities, benefit }, index) => (
              <Reveal as="article" className="ws-module" key={id} delay={(index % 3) * 80}>
                <span className="ws-icon"><Icon aria-hidden="true" /></span>
                <h3>{name}</h3>
                <p className="ws-module-desc">{description}</p>
                <p className="ws-module-problem"><b>The problem</b> {problem}</p>
                <ul>
                  {capabilities.map((capability) => (
                    <li key={capability}><FaCheck aria-hidden="true" /> {capability}</li>
                  ))}
                </ul>
                <p className="ws-module-benefit"><b>The benefit</b> {benefit}</p>
                <Link to={`/features#${id}`} className="ws-link">View details <FaArrowRight aria-hidden="true" /></Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- PRODUCT PREVIEWS ---------- */}
      <section className="ws-section" id="product" aria-labelledby="product-title">
        <div className="ws-container">
          <SectionHeader
            eyebrow="Product previews"
            title={<span id="product-title">See how the product is organized</span>}
            lede="Representative interface previews of the workspace, ZioVault and the Owner Portal."
          />
          <Reveal><ProductPreview /></Reveal>
        </div>
      </section>

      {/* ---------- ZIOVAULT ---------- */}
      <section className="ws-section ws-section-dark ws-vault" id="security" aria-labelledby="vault-title">
        <div className="ws-vault-glow" aria-hidden="true" />
        <div className="ws-container">
          <SectionHeader
            light
            eyebrow="ZioVault · Security"
            title={<span id="vault-title">The password vault built into your platform</span>}
            lede="ZioVault is the secure password and secrets management component of the ZioVenture ecosystem. Secrets are encrypted on the user's device before they leave it."
          />

          <div className="ws-vault-grid">
            <Reveal className="ws-vault-visual"><VaultMock /></Reveal>
            <div className="ws-vault-caps">
              {ZIOVAULT_CAPABILITIES.map((capability, index) => (
                <Reveal className="ws-cap" key={capability.name} delay={(index % 4) * 60}>
                  <FaCheck aria-hidden="true" />
                  <div><strong>{capability.name}</strong><span>{capability.copy}</span></div>
                </Reveal>
              ))}
            </div>
          </div>

          <div className="ws-crypto" role="list" aria-label="Security architecture">
            {ZIOVAULT_CRYPTO.map((item, index) => (
              <Reveal className="ws-crypto-item" key={item.label} delay={(index % 3) * 70} role="listitem">
                <FaLock aria-hidden="true" />
                <strong>{item.label}</strong>
                <span>{item.value}</span>
              </Reveal>
            ))}
          </div>

          <Reveal className="ws-privacy">
            <div>
              <h3>Personal privacy and company administration are different things</h3>
              <p>
                <b>Personal vault.</b> Only its owner can open it. Administrators cannot read it, and there is no master key that
                could.
              </p>
              <p>
                <b>Company vault.</b> Shared collections that belong to the company. Authorized administrators can create collections
                and remove a leaving employee's access, but access to a secret still depends on the keys a person has been given.
              </p>
            </div>
            <p className="ws-privacy-note">
              Like any browser-based encryption, ZioVault cannot erase what someone has already seen or copied, and a lost master
              password with no recovery key means lost data.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ---------- OWNER PORTAL ---------- */}
      <section className="ws-section" id="owner-portal" aria-labelledby="owner-title">
        <div className="ws-container ws-owner-grid">
          <div>
            <SectionHeader
              eyebrow="Owner Portal"
              title={<span id="owner-title">Multi-company management from one portal</span>}
              lede="For organizations that run ZioVenture for more than one company, the Owner Portal keeps provisioning and access in one place."
            />
            <ul className="ws-owner-points">
              {OWNER_POINTS.map((point, index) => (
                <Reveal as="li" key={point.title} delay={index * 80}>
                  <span className="ws-check"><FaCheck aria-hidden="true" /></span>
                  <div><strong>{point.title}</strong><span>{point.copy}</span></div>
                </Reveal>
              ))}
            </ul>
          </div>
          <Reveal className="ws-owner-visual"><OwnerMock /></Reveal>
        </div>
      </section>

      {/* ---------- WORKFLOWS ---------- */}
      <section className="ws-section ws-section-tint" id="workflows" aria-labelledby="workflows-title">
        <div className="ws-container">
          <SectionHeader
            eyebrow="Workflow and productivity"
            title={<span id="workflows-title">Modules that work together</span>}
            lede="Each step happens in a connected module, with the same people and records. These are the steps your team carries out; they are not automatic triggers."
          />
          <div className="ws-flows">
            {FLOWS.map((flow) => <Flow key={flow.id} flow={flow} />)}
          </div>
        </div>
      </section>

      {/* ---------- SOLUTIONS ---------- */}
      <section className="ws-section" id="solutions" aria-labelledby="solutions-title">
        <div className="ws-container">
          <SectionHeader
            eyebrow="Business solutions"
            title={<span id="solutions-title">Shaped around how your organization works</span>}
          />
          <div className="ws-solutions">
            {SOLUTIONS.map(({ icon: Icon, title, copy }, index) => (
              <Reveal className="ws-solution" key={title} delay={(index % 3) * 80}>
                <span className="ws-icon"><Icon aria-hidden="true" /></span>
                <div><h3>{title}</h3><p>{copy}</p></div>
              </Reveal>
            ))}
          </div>
          <Reveal className="ws-center"><Link to="/solutions" className="ws-btn ws-btn-outline">More about solutions</Link></Reveal>
        </div>
      </section>

      {/* ---------- WHY ZIOVENTURE ---------- */}
      <section className="ws-section ws-section-tint" id="why" aria-labelledby="why-title">
        <div className="ws-container">
          <SectionHeader eyebrow="Why ZioVenture" title={<span id="why-title">Built for how organizations actually work</span>} />
          <div className="ws-why">
            {WHY.map((item, index) => (
              <Reveal className="ws-why-item" key={item.title} delay={(index % 3) * 70}>
                <h3>{item.title}</h3>
                <p>{item.copy}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- PRICING ---------- */}
      <section className="ws-section" id="pricing" aria-labelledby="pricing-title">
        <div className="ws-container">
          <Reveal className="ws-pricing">
            <div>
              <span className="ws-eyebrow">Pricing</span>
              <h2 id="pricing-title">Plans tailored to your organization</h2>
              <p>
                ZioVenture is set up directly with our team, so pricing reflects the size and needs of your organization. We do not
                publish fixed prices, and no payment information is needed to ask.
              </p>
            </div>
            <div className="ws-pricing-actions">
              <Link to="/pricing" className="ws-btn ws-btn-outline">View plans</Link>
              <Link to="/#demo" className="ws-btn ws-btn-primary">Request a Demo</Link>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- FAQ ---------- */}
      <section className="ws-section ws-section-tint" id="faq" aria-labelledby="faq-title">
        <div className="ws-container ws-narrow">
          <SectionHeader eyebrow="FAQ" title={<span id="faq-title">Frequently asked questions</span>} />
          <div className="ws-faq">
            {FAQS.map((item, index) => (
              <Reveal as="details" className="ws-faq-item" key={item.q} delay={index * 40}>
                <summary>{item.q}<FaChevronDown aria-hidden="true" /></summary>
                <p>{item.a}</p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- DEMO ---------- */}
      <section className="ws-section ws-section-dark ws-demo" id="demo" aria-labelledby="demo-title">
        <div className="ws-container ws-demo-grid">
          <Reveal className="ws-demo-copy">
            <span className="ws-eyebrow">Request a demo</span>
            <h2 id="demo-title">See ZioVenture with your own team in mind</h2>
            <p>Tell us a little about your company and we will be in touch to arrange a walkthrough.</p>
            <ul>
              <li><FaCheck aria-hidden="true" /> A walkthrough of the modules that fit your team</li>
              <li><FaCheck aria-hidden="true" /> No account or payment details needed</li>
            </ul>
          </Reveal>
          <Reveal className="ws-form-card" delay={100}>
            <DemoRequestForm idPrefix="home-demo" />
          </Reveal>
        </div>
      </section>

      {/* ---------- CONTACT ---------- */}
      <section className="ws-section ws-contact" id="contact" aria-labelledby="contact-title">
        <div className="ws-container">
          <Reveal className="ws-contact-card">
            <FaEnvelope aria-hidden="true" />
            <div>
              <h2 id="contact-title">Questions before you decide?</h2>
              <p>Send us a message with the same form and our team will reply directly.</p>
            </div>
            <Link to="/contact" className="ws-btn ws-btn-primary">Contact us</Link>
          </Reveal>
        </div>
      </section>

    </div>
  );
}

export default Home;
