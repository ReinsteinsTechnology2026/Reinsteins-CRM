import { FaCheck } from "react-icons/fa";

import "./InnerPage.css";

// ==========================================
// FEATURES PAGE (Phase 6)
// Every item below corresponds to a real, currently-implemented
// feature in the ZioVenture portal -- verified against the actual
// controllers/services in this codebase, not aspirational.
// ==========================================

const CATEGORIES = [
  {
    title: "Workforce Management",
    items: [
      { name: "Employee Records", copy: "Full employee profiles, onboarding, and employment history." },
      { name: "Departments & Designations", copy: "Organize your company by department and role." },
      { name: "Attendance Tracking", copy: "Login/logout, break time, and daily work duration." },
      { name: "Leave Management", copy: "Leave requests with manager and admin approval steps." },
      { name: "Reports & Exports", copy: "Employee reports, exportable for record-keeping." },
    ],
  },
  {
    title: "Work Management",
    items: [
      { name: "Projects & Organizations", copy: "Structure work by project, with organization-level grouping." },
      { name: "Tasks, Epics & User Stories", copy: "Break work down the way your team already plans it." },
      { name: "Sprints", copy: "Sprint-based planning and tracking for iterative teams." },
      { name: "Task Activity, Comments & Mentions", copy: "A full activity trail on every task, with @mentions." },
      { name: "Task Attachments", copy: "Attach files directly to tasks and activity updates." },
    ],
  },
  {
    title: "Communication",
    items: [
      { name: "Team Chat", copy: "Direct and group conversations, built into the portal." },
      { name: "Meetings", copy: "Built-in video meetings with screen sharing and an in-meeting chat panel." },
      { name: "Real-Time Notifications", copy: "Live updates for tasks, leave, chat, and meetings." },
      { name: "File & Image Sharing", copy: "Share files and images directly in chat and meetings." },
    ],
  },
  {
    title: "Platform & Security",
    items: [
      { name: "Role-Based Access", copy: "Admin and employee roles, with granular permission levels." },
      { name: "Company Data Isolation", copy: "Every company operates on its own isolated database." },
      { name: "Secure File Access", copy: "Uploaded files are authenticated and access-controlled, not publicly guessable." },
      { name: "Real-Time, Tenant-Aware Collaboration", copy: "Chat, meetings, and notifications stay correctly scoped to your own company." },
      { name: "Separate Admin & Employee Portals", copy: "Purpose-built views for administrators and employees." },
    ],
  },
];

function Features() {
  return (
    <div className="pub-inner-page">

      <section className="pub-inner-hero">
        <div className="pub-container">
          <span className="pub-eyebrow">Features</span>
          <h1 className="pub-h1">Everything built into ZioVenture today</h1>
          <p className="pub-lede">
            A real, working feature set — organized the way your organization already thinks about work.
          </p>
        </div>
      </section>

      <section className="pub-section">
        <div className="pub-container">
          {CATEGORIES.map((category) => (
            <div className="pub-category" key={category.title}>
              <div className="pub-category-title">{category.title}</div>
              <div className="pub-feature-list">
                {category.items.map((item) => (
                  <div className="pub-feature-item" key={item.name}>
                    <FaCheck />
                    <div>
                      <strong>{item.name}</strong>
                      {item.copy}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
}

export default Features;
