import { Link } from "react-router-dom";
import {
  FaUsers, FaClock, FaCalendarCheck, FaProjectDiagram, FaComments,
  FaVideo, FaBell, FaLock, FaBuilding, FaShieldAlt,
  FaLayerGroup, FaBolt,
} from "react-icons/fa";

import "./Home.css";

// ==========================================
// PUBLIC HOME PAGE (Phase 6)
// Every feature named below is real and currently implemented in
// the ZioVenture portal -- no invented or planned-only functionality.
// ==========================================

const FEATURES = [
  { icon: FaUsers, title: "Employee Management", copy: "Employee records, departments, designations, and reporting structure in one place." },
  { icon: FaClock, title: "Attendance Management", copy: "Login/logout tracking, break time, and daily work duration." },
  { icon: FaCalendarCheck, title: "Leave Management", copy: "Leave requests with manager and admin approval workflows." },
  { icon: FaProjectDiagram, title: "Projects & Tasks", copy: "Projects, epics, user stories, tasks, and sprints, tracked end to end." },
  { icon: FaComments, title: "Team Chat", copy: "Direct and group conversations with file and image sharing." },
  { icon: FaVideo, title: "Meetings", copy: "Built-in video meetings with screen sharing and in-meeting chat." },
  { icon: FaBell, title: "Notifications", copy: "Real-time notifications for tasks, leave, chat, and meetings." },
  { icon: FaLock, title: "Secure File Sharing", copy: "Uploaded files are access-controlled and isolated per company." },
  { icon: FaBuilding, title: "Multi-Organization Management", copy: "Departments and organizational structure built for growing teams." },
];

const WHY = [
  { icon: FaLayerGroup, title: "One Platform for Daily Operations", copy: "Employees, attendance, leave, projects, chat, and meetings — no more juggling five different tools." },
  { icon: FaShieldAlt, title: "Secure Company Data Isolation", copy: "Every company runs on its own isolated database. Your data is never mixed with anyone else's." },
  { icon: FaBolt, title: "Real-Time Collaboration", copy: "Chat, notifications, and meetings update live, so your team stays in sync." },
  { icon: FaUsers, title: "Admin and Employee Portals", copy: "Purpose-built views for administrators and employees, with role-based access throughout." },
];

function Home() {
  return (
    <>
      {/* ---------- HERO ---------- */}
      <section className="pub-hero">
        <div className="pub-container pub-hero-inner">
          <span className="pub-eyebrow">ZioVenture Platform</span>
          <h1 className="pub-h1">
            Everything Your Organization Needs.<br />One Powerful Platform.
          </h1>
          <p className="pub-lede pub-hero-lede">
            ZioVenture helps companies manage employees, work, communication, and daily
            operations in one secure platform — built for teams that are ready to grow.
          </p>
          <div className="pub-hero-actions">
            <Link to="/contact" className="pub-btn pub-btn-primary">Request a Demo</Link>
            <Link to="/features" className="pub-btn pub-btn-outline">Explore Features</Link>
          </div>
        </div>
        <div className="pub-hero-glow" aria-hidden="true" />
      </section>

      {/* ---------- FEATURES PREVIEW ---------- */}
      <section className="pub-section">
        <div className="pub-container">
          <div className="pub-section-header">
            <span className="pub-eyebrow">What's Inside</span>
            <h2 className="pub-h2">A complete workplace platform</h2>
            <p className="pub-lede">Real, working functionality — not a roadmap.</p>
          </div>

          <div className="pub-grid pub-grid-3">
            {FEATURES.map(({ icon: Icon, title, copy }) => (
              <div className="pub-card" key={title}>
                <div className="pub-card-icon"><Icon /></div>
                <h3 className="pub-h3">{title}</h3>
                <p>{copy}</p>
              </div>
            ))}
          </div>

          <div className="pub-features-more">
            <Link to="/features" className="pub-btn pub-btn-outline">See All Features</Link>
          </div>
        </div>
      </section>

      {/* ---------- WHY GROWORGS ---------- */}
      <section className="pub-section pub-section-subtle">
        <div className="pub-container">
          <div className="pub-section-header">
            <span className="pub-eyebrow">Why ZioVenture</span>
            <h2 className="pub-h2">Built for how organizations actually work</h2>
          </div>

          <div className="pub-grid pub-grid-2 pub-why-grid">
            {WHY.map(({ icon: Icon, title, copy }) => (
              <div className="pub-why-item" key={title}>
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

      {/* ---------- CTA ---------- */}
      <section className="pub-section pub-section-dark pub-cta">
        <div className="pub-container pub-cta-inner">
          <h2 className="pub-h2">Ready to Grow Your Organization?</h2>
          <p className="pub-lede">
            See ZioVenture in action, or reach out with questions — we'll get back to you quickly.
          </p>
          <div className="pub-hero-actions">
            <Link to="/contact" className="pub-btn pub-btn-light">Request a Demo</Link>
            <Link to="/contact" className="pub-btn pub-btn-outline">Contact Us</Link>
          </div>
        </div>
      </section>
    </>
  );
}

export default Home;
