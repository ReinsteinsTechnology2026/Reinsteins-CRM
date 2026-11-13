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
    short: "People directory",
    description: "A single directory of everyone in the company, with their department, designation and reporting line.",
    problem: "Without one source of truth, HR details live in spreadsheets and nobody is sure who reports to whom.",
    capabilities: ["Employee profiles and records", "Departments and designations", "Organization chart, hierarchy and My Team views"],
    benefit: "Managers see their team at a glance, and a new joiner is set up once for every other module to use.",
  },
  {
    id: "attendance",
    icon: FaUserClock,
    name: "Attendance Management",
    short: "Clock in and out",
    description: "Employees clock in and out and log breaks. Administrators see who is online right now.",
    problem: "Registers and chat messages make working hours hard to prove and hard to total.",
    capabilities: ["Online and offline status", "Break tracking", "Live and monthly attendance records"],
    benefit: "Month-end hours come from recorded activity instead of recollection.",
  },
  {
    id: "leave-management",
    icon: FaCalendarCheck,
    name: "Leave Management",
    short: "Requests and approvals",
    description: "Employees apply for leave, and managers and administrators approve it through a defined chain.",
    problem: "Approvals buried in chat and email leave no clean record.",
    capabilities: ["Employee leave requests", "Manager and administrator approvals", "Team leave visibility for approvers"],
    benefit: "Employees know where a request stands, and approvers work from one queue.",
  },
  {
    id: "shift-management",
    icon: FaCalendarAlt,
    name: "Shift Management",
    short: "Rosters and weekly offs",
    description: "Build shift schedules from the employee directory, including weekly offs.",
    problem: "Rosters kept in loose files go stale between one shift and the next.",
    capabilities: ["Schedules built from the employee directory", "Weekly offs", "Shift reports"],
    benefit: "Employees check their own schedule, and administrators review shifts in one place.",
  },
  {
    id: "task-management",
    icon: FaTasks,
    name: "Task Management",
    short: "Assign and track work",
    description: "Create tasks, assign them to people, log work against them and follow every change.",
    problem: "Requests sent in chat get lost, and nobody owns the outcome.",
    capabilities: ["Assignment and work logs", "Tags, comments and @mentions", "Full activity trail and attachments"],
    benefit: "Every task has an owner, a status and a history you can point to.",
  },
  {
    id: "techops",
    icon: FaProjectDiagram,
    name: "TechOps",
    short: "Projects and sprints",
    description: "Plan technical work as projects, epics, features, user stories and sprints, and link related items.",
    problem: "Roadmaps live in one tool while the work happens in another.",
    capabilities: ["Projects, epics, features and user stories", "Sprints and linked work items", "Recycle bin for removed work"],
    benefit: "Technical teams plan and deliver in the same system the rest of the company uses.",
  },
  {
    id: "reports",
    icon: FaChartBar,
    name: "Reports and Analytics",
    short: "Visibility and exports",
    description: "Reports built from your employee, attendance, task and leave data, with exports.",
    problem: "Getting an answer means copying data between tools by hand.",
    capabilities: ["Employee, attendance, task and leave reports", "Exports for record-keeping", "Each report follows the modules enabled for the company"],
    benefit: "Managers answer routine questions from data that is already recorded.",
  },
  {
    id: "team-chat",
    icon: FaComments,
    name: "Team Chat",
    short: "Internal messaging",
    description: "Direct and group conversations inside the platform, with files and images.",
    problem: "Conversations about work happen away from the work itself.",
    capabilities: ["Direct and group conversations", "File and image sharing", "Real-time notifications"],
    benefit: "People ask, answer and share files without switching tools.",
  },
  {
    id: "meetings",
    icon: FaVideo,
    name: "Meetings",
    short: "Video meetings",
    description: "Schedule meetings or start one instantly, with video, screen sharing and in-meeting chat.",
    problem: "Meeting links end up scattered across calendars and tools.",
    capabilities: ["Scheduled and instant video meetings", "Screen sharing", "In-meeting chat"],
    benefit: "Teams meet in the same place they chat and track work.",
  },
  {
    id: "sop-library",
    icon: FaBookOpen,
    name: "SOP Library",
    short: "Standard procedures",
    description: "Administrators upload procedure documents, and authorized employees view and download them.",
    problem: "Procedures live in personal folders and old emails.",
    capabilities: ["Upload and organize SOP documents", "View and download for authorized employees", "Administrator-controlled publishing"],
    benefit: "Staff look up the current procedure instead of asking around.",
  },
  {
    id: "smart-sheets",
    icon: FaTable,
    name: "Smart Sheets",
    short: "Shared workbooks",
    description: "Spreadsheet-style workbooks your team works on together, with Excel import and export.",
    problem: "Spreadsheets get emailed around until the versions diverge.",
    capabilities: ["Collaborative spreadsheets", "Excel import and export", "Sharing with chosen employees"],
    benefit: "One shared workbook, visible only to the people you choose.",
  },
  {
    id: "company-email",
    icon: FaEnvelope,
    name: "Company Email",
    short: "Domain and mailboxes",
    description: "Connect your company's domain and set up mailbox addresses for your employees.",
    problem: "Domain and mailbox setup is scattered across providers and instructions.",
    capabilities: ["Add your company domain and get DNS instructions", "Verify domain ownership", "Create and manage employee mailbox addresses"],
    benefit: "Administrators handle domain verification and mailbox addresses from the same platform.",
    note: "Mailboxes are provisioned from the platform. An in-app inbox is not part of the platform yet.",
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
    copy: "Employees, attendance, leave and tasks in one workspace instead of five separate tools.",
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
