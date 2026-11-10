import {
  FaUsers, FaUserClock, FaCalendarCheck, FaCalendarAlt, FaTasks, FaProjectDiagram,
  FaChartBar, FaComments, FaVideo, FaBookOpen, FaTable, FaEnvelope,
  FaSeedling, FaLaptopCode, FaCogs, FaSitemap, FaRocket,
} from "react-icons/fa";

// ==========================================
// PUBLIC WEBSITE CONTENT
//
// Every module and capability below was checked against the implemented product (the feature catalog in
// server/config/tenantFeatures.js, the route files and the ZioVault architecture document). Nothing here is a
// roadmap item, a customer statistic, a testimonial or a price.
// ==========================================

export const MODULES = [
  {
    id: "employee-management",
    icon: FaUsers,
    name: "Employee Management",
    description: "One central record for every person in the company.",
    problem: "Employee details scattered across spreadsheets and chat threads.",
    capabilities: ["Employee profiles and records", "Departments and designations", "Organization chart and reporting lines"],
    benefit: "Everyone knows who works where, and who they report to.",
  },
  {
    id: "attendance",
    icon: FaUserClock,
    name: "Attendance Management",
    description: "Clock in and out, track breaks and working hours.",
    problem: "No reliable view of who is online and how long they have worked.",
    capabilities: ["Online / offline status", "Break tracking", "Live and monthly attendance records"],
    benefit: "Accurate working-hours records without manual registers.",
  },
  {
    id: "leave-management",
    icon: FaCalendarCheck,
    name: "Leave Management",
    description: "Leave requests with a clear approval chain.",
    problem: "Leave approved over chat and forgotten at payroll time.",
    capabilities: ["Employee leave requests", "Manager and administrator approvals", "Team leave visibility"],
    benefit: "Every request has an owner, a decision and a record.",
  },
  {
    id: "shift-management",
    icon: FaCalendarAlt,
    name: "Shift Management",
    description: "Organize shift schedules across your people.",
    problem: "Rosters kept in files that are out of date by the next shift.",
    capabilities: ["Shift schedules built from the employee directory", "Weekly offs", "Shift reports"],
    benefit: "Schedules that everyone can see and trust.",
  },
  {
    id: "task-management",
    icon: FaTasks,
    name: "Task Management",
    description: "Assign work, follow progress and keep people accountable.",
    problem: "Work requests lost between messages, with no owner.",
    capabilities: ["Task assignment and work logs", "Tags, comments and @mentions", "Full activity trail and attachments"],
    benefit: "Clear ownership and a history of what happened on every task.",
  },
  {
    id: "techops",
    icon: FaProjectDiagram,
    name: "TechOps",
    description: "Run technical projects and operational work end to end.",
    problem: "Project plans disconnected from the tasks that deliver them.",
    capabilities: ["Projects, epics, features and user stories", "Sprints and linked work items", "Recycle bin for removed work"],
    benefit: "Plan the way technical teams plan, in the same place work is done.",
  },
  {
    id: "reports",
    icon: FaChartBar,
    name: "Reports and Analytics",
    description: "Visibility across people and operations.",
    problem: "Answers that need hours of copying data between tools.",
    capabilities: ["Employee, attendance, task and leave reports", "Exports for record-keeping", "Access follows your enabled modules"],
    benefit: "Decisions based on the data you already record.",
  },
  {
    id: "team-chat",
    icon: FaComments,
    name: "Team Chat",
    description: "Internal conversations inside the platform.",
    problem: "Team communication split from the work it is about.",
    capabilities: ["Direct and group conversations", "File and image sharing", "Real-time notifications"],
    benefit: "Quick answers without leaving your workspace.",
  },
  {
    id: "meetings",
    icon: FaVideo,
    name: "Meetings",
    description: "Schedule and join video meetings built into the platform.",
    problem: "Separate meeting tools and links nobody can find.",
    capabilities: ["Scheduled and instant video meetings", "Screen sharing", "In-meeting chat"],
    benefit: "Coordinate a team call from the same tool you already use.",
  },
  {
    id: "sop-library",
    icon: FaBookOpen,
    name: "SOP Library",
    description: "A central home for standard operating procedures.",
    problem: "Procedures living in personal folders and old emails.",
    capabilities: ["Upload and organize SOP documents", "View and download for authorized employees", "Administrator-controlled publishing"],
    benefit: "Everyone works from the current procedure.",
  },
  {
    id: "smart-sheets",
    icon: FaTable,
    name: "Smart Sheets",
    description: "A spreadsheet-style workspace for organizing information.",
    problem: "Shared spreadsheets copied around by email.",
    capabilities: ["Collaborative spreadsheets", "Excel import and export", "Sharing with chosen employees"],
    benefit: "Structured data your team can work on together.",
  },
  {
    id: "company-email",
    icon: FaEnvelope,
    name: "Company Email",
    description: "Employee mailboxes on your company's own domain.",
    problem: "Staff using personal addresses for company business.",
    capabilities: ["Company domain setup with DNS instructions", "Domain verification", "Mailbox management for employees"],
    benefit: "A professional company address for your team.",
  },
];

export const ZIOVAULT_CAPABILITIES = [
  { name: "Personal Vault", copy: "Every employee gets a private vault for their own logins." },
  { name: "Company Vault", copy: "Shared collections for credentials the company owns." },
  { name: "Granular sharing", copy: "Share one item, and choose whether someone can see details or reveal the secret." },
  { name: "Secure notes", copy: "Store sensitive text next to your logins." },
  { name: "Password generator", copy: "Create strong passwords without leaving the vault." },
  { name: "Password health checks", copy: "Spot weak and reused passwords." },
  { name: "Encrypted attachments", copy: "Files are encrypted on your device before upload." },
  { name: "Audit viewer", copy: "See who accessed, shared or changed company items." },
  { name: "Rotation reminders", copy: "Flag credentials that are due for a change." },
  { name: "Collection re-keying", copy: "Issue fresh keys for a shared collection." },
  { name: "Authorized offboarding", copy: "Remove a leaving employee's company vault access." },
];

export const ZIOVAULT_CRYPTO = [
  { label: "Client-side encryption", value: "Secrets are encrypted in the browser. The server stores ciphertext and key envelopes only." },
  { label: "Argon2id", value: "Your master password is stretched with Argon2id key derivation." },
  { label: "XChaCha20-Poly1305", value: "Authenticated encryption protects every item." },
  { label: "X25519", value: "Public-key exchange is used to share keys with colleagues." },
  { label: "libsodium", value: "Implemented with the libsodium cryptographic library." },
  { label: "No hidden master key", value: "There is no administrator master key and no back door to read a private vault." },
];

export const OWNER_POINTS = [
  { title: "Centralized company management", copy: "Create and manage the companies that run on your platform from one portal." },
  { title: "Tenant-level feature management", copy: "Choose which modules each company can use." },
  { title: "Company-specific access", copy: "A company sees only the modules enabled for it, in its own isolated environment." },
  { title: "Administrative visibility", copy: "Companies, demo requests, plans, users, payments, audit logs and email logs in one place." },
];

export const FLOWS = [
  {
    id: "people",
    title: "From new hire to reporting",
    note: "A typical path through connected modules.",
    steps: ["Employee onboarding", "Employee records", "Shift assignment", "Attendance", "Task assignment", "Reporting"],
  },
  {
    id: "vault",
    title: "From shared credential to offboarding",
    note: "How a company manages access to shared secrets.",
    steps: ["Company Vault", "Secure credential sharing", "Audit visibility", "Rotation reminders", "Authorized offboarding"],
  },
];

export const SOLUTIONS = [
  {
    icon: FaSeedling,
    title: "Small and medium businesses",
    copy: "Employees, attendance, leave and tasks in one affordable-to-run workspace instead of five separate tools.",
  },
  {
    icon: FaRocket,
    title: "Growing organizations",
    copy: "Add structure as headcount grows: departments, reporting lines, approvals and role-based access.",
  },
  {
    icon: FaLaptopCode,
    title: "IT and technology companies",
    copy: "TechOps projects, epics, sprints and user stories, plus ZioVault for the credentials your team shares.",
  },
  {
    icon: FaCogs,
    title: "Operations teams",
    copy: "Shift schedules, attendance, SOPs and tasks that keep day-to-day work consistent.",
  },
  {
    icon: FaSitemap,
    title: "Organizations with multiple departments",
    copy: "Department and designation structures, an organization chart and permissions that follow real roles.",
  },
];

export const WHY = [
  { title: "One connected platform", copy: "People, projects, communication and secrets management share one sign-in and one data model." },
  { title: "Isolated company data", copy: "Every company runs on its own database. Your data is never mixed with another company's." },
  { title: "You choose the modules", copy: "Modules are enabled per company by the platform owner, so teams see what they use." },
  { title: "Role-based portals", copy: "Administrators, executives and employees each get a portal built for their work." },
  { title: "Privacy by cryptography", copy: "ZioVault encrypts on your device, so even administrators cannot read a private vault." },
  { title: "Real-time by default", copy: "Chat, notifications and meetings update live so teams stay in step." },
];

export const FAQS = [
  {
    q: "Is every module available to every company?",
    a: "No. The platform owner enables modules per company, so each company only sees the modules turned on for it.",
  },
  {
    q: "Is my company's data separate from other companies?",
    a: "Yes. Every company runs on its own isolated database, so data is never mixed between companies.",
  },
  {
    q: "Can administrators read employees' private vaults in ZioVault?",
    a: "No. Secrets are encrypted on the employee's device and there is no administrator master key. Authorized administrators can manage the company vault, including offboarding, but that does not give them a way to read private vaults.",
  },
  {
    q: "What happens if I lose my ZioVault master password?",
    a: "ZioVault shows a recovery key when you set it up. If both the master password and the recovery key are lost, the data cannot be recovered. That is a deliberate result of the design.",
  },
  {
    q: "How is ZioVenture priced?",
    a: "Pricing is tailored to your organization. Request a demo and our team will discuss plans with you. No payment information is needed to ask for a demo.",
  },
  {
    q: "How do I get started?",
    a: "Request a demo using the form on this page. Our team will contact you to arrange a walkthrough.",
  },
];

export const PLATFORM_PILLARS = [
  { title: "People", copy: "Employees, attendance, leave and shifts.", icon: FaUsers },
  { title: "Work", copy: "Tasks, TechOps projects and Smart Sheets.", icon: FaTasks },
  { title: "Communication", copy: "Chat, meetings and company email.", icon: FaComments },
  { title: "Knowledge and security", copy: "SOPs, reports and ZioVault.", icon: FaBookOpen },
];
