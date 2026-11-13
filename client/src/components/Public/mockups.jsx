import {
  FaLock, FaKey, FaShieldAlt, FaCheck, FaUsers, FaUserClock, FaTasks, FaComments, FaProjectDiagram, FaChartBar, FaCalendarCheck,
  FaPaperclip, FaSync, FaBuilding, FaBell, FaSearch, FaPlus, FaHistory, FaUserShield,
} from "react-icons/fa";

// ==========================================
// REPRESENTATIVE INTERFACE MOCKUPS
// Built from HTML and CSS (nothing to download). They follow the layout of the real screens and use generic SAMPLE data: invented
// names, no company or customer information, no credentials. Every mockup carries an "Illustrative interface" tag and is hidden from
// assistive technology.
// ==========================================

const SIDEBAR = [
  { icon: FaChartBar, label: "Dashboard", active: true },
  { icon: FaProjectDiagram, label: "TechOps" },
  { icon: FaTasks, label: "Tasks" },
  { icon: FaUsers, label: "Employees" },
  { icon: FaUserClock, label: "Attendance" },
  { icon: FaCalendarCheck, label: "Leave" },
  { icon: FaComments, label: "Chat" },
  { icon: FaKey, label: "ZioVault" },
];

const KPIS = [
  { label: "Present today", value: "42", note: "of 48", icon: FaUserClock },
  { label: "On leave", value: "3", note: "approved", icon: FaCalendarCheck },
  { label: "Open tasks", value: "128", note: "in progress", icon: FaTasks },
  { label: "Meetings", value: "5", note: "today", icon: FaComments },
];

const BARS = [62, 78, 70, 88, 82, 40, 24];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const WORK = [
  { who: "AK", title: "Review onboarding checklist", status: "In progress", tone: 1 },
  { who: "MR", title: "Update shift schedule", status: "To do", tone: 2 },
  { who: "SP", title: "Approve leave requests", status: "Review", tone: 0 },
  { who: "JD", title: "Sprint planning notes", status: "Done", tone: 3 },
];

function Chrome({ title }) {
  return (
    <div className="ws-mock-chrome">
      <span /><span /><span />
      <em>{title}</em>
      <b className="ws-mock-tag">Illustrative interface</b>
    </div>
  );
}

export function DashboardMock() {
  return (
    <div className="ws-mock ws-mock-dashboard" aria-hidden="true">
      <Chrome title="Your Company · Dashboard" />
      <div className="ws-mock-body">
        <div className="ws-mock-side">
          {SIDEBAR.map(({ icon: Icon, label, active }) => (
            <div key={label} className={`ws-mock-nav${active ? " active" : ""}`}>
              <Icon /> <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="ws-mock-main">
          <div className="ws-mock-top">
            <div><strong>Good morning</strong><small>Here is today at a glance</small></div>
            <div className="ws-mock-top-right"><FaSearch /><FaBell /><i>AD</i></div>
          </div>
          <div className="ws-mock-kpis">
            {KPIS.map(({ label, value, note, icon: Icon }, index) => (
              <div className="ws-mock-kpi" key={label} style={{ "--i": index }}>
                <span className="ws-mock-kpi-icon"><Icon /></span>
                <div><small>{label}</small><b>{value}</b><em>{note}</em></div>
              </div>
            ))}
          </div>
          <div className="ws-mock-panels">
            <div className="ws-mock-panel">
              <div className="ws-mock-panel-head"><small>Attendance this week</small><u>Sample data</u></div>
              <div className="ws-mock-chart">
                {BARS.map((height, index) => (
                  <div key={DAYS[index]}><b style={{ "--h": `${height}%`, "--i": index }} /><i>{DAYS[index]}</i></div>
                ))}
              </div>
            </div>
            <div className="ws-mock-panel">
              <div className="ws-mock-panel-head"><small>My work</small><u>4 items</u></div>
              {WORK.map((row, index) => (
                <div className="ws-mock-row" key={row.title} style={{ "--i": index }}>
                  <i className="ws-avatar">{row.who}</i>
                  <span>{row.title}</span>
                  <u className={`ws-status ws-status-${row.tone}`}>{row.status}</u>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FloatingChips() {
  return (
    <>
      <div className="ws-chip ws-chip-a" aria-hidden="true"><FaUserClock /> Online <i /></div>
      <div className="ws-chip ws-chip-b" aria-hidden="true"><FaLock /> Encrypted in your browser</div>
    </>
  );
}

const VAULT_ITEMS = [
  { name: "Cloud console", sub: "Company · Infrastructure" },
  { name: "Staging server", sub: "Company · Infrastructure" },
  { name: "Shared mailbox", sub: "Company · Operations" },
  { name: "Design tools", sub: "Company · Marketing" },
  { name: "Personal logins", sub: "Personal vault" },
];

export function VaultMock() {
  return (
    <div className="ws-mock ws-mock-vault" aria-hidden="true">
      <Chrome title="ZioVault" />
      <div className="ws-vault-body">
        <div className="ws-vault-list">
          <div className="ws-vault-tabs"><b>Company</b><span>Personal</span><i><FaPlus /></i></div>
          {VAULT_ITEMS.map((item, index) => (
            <div className={`ws-vault-item${index === 0 ? " active" : ""}`} key={item.name}>
              <span className="ws-vault-item-icon"><FaLock /></span>
              <div><strong>{item.name}</strong><small>{item.sub}</small></div>
            </div>
          ))}
        </div>
        <div className="ws-vault-detail">
          <div className="ws-vault-head">
            <strong>Cloud console</strong>
            <u className="ws-vault-badge"><FaShieldAlt /> Encrypted on device</u>
          </div>
          <div className="ws-vault-field"><small>Username</small><span>admin@company.example</span></div>
          <div className="ws-vault-field"><small>Password</small><span className="ws-vault-secret">••••••••••••••••</span></div>
          <div className="ws-vault-strength"><small>Password health</small><div><i /><i /><i /><i /><i className="off" /></div></div>
          <div className="ws-vault-meta">
            <span><FaPaperclip /> 1 encrypted attachment</span>
            <span><FaSync /> Rotation due soon</span>
            <span><FaHistory /> Audit trail</span>
          </div>
          <div className="ws-vault-rights">
            <small>Shared with</small>
            <i className="ws-avatar">AK</i><i className="ws-avatar">MR</i><i className="ws-avatar">SP</i>
            <span>View</span><span>Reveal</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const OWNER_ROWS = [
  { name: "Company A", plan: "Active", modules: [true, true, true, false] },
  { name: "Company B", plan: "Active", modules: [true, true, false, false] },
  { name: "Company C", plan: "Active", modules: [true, true, true, true] },
  { name: "Company D", plan: "Onboarding", modules: [true, false, false, false] },
];
const OWNER_COLUMNS = ["Employees", "Tasks", "ZioVault", "Email"];

export function OwnerMock() {
  return (
    <div className="ws-mock ws-mock-owner" aria-hidden="true">
      <Chrome title="Owner Portal" />
      <div className="ws-owner-wrap">
        <div className="ws-owner-nav">
          {[FaBuilding, FaUsers, FaChartBar, FaUserShield].map((Icon, index) => (
            <span key={index} className={index === 0 ? "active" : ""}><Icon /></span>
          ))}
        </div>
        <div className="ws-owner-body">
          <div className="ws-owner-head">
            <strong>Companies</strong>
            <small>Choose the modules each company can use</small>
          </div>
          <div className="ws-owner-table">
            <div className="ws-owner-row ws-owner-cols">
              <span>Company</span>
              {OWNER_COLUMNS.map((column) => <em key={column}>{column}</em>)}
            </div>
            {OWNER_ROWS.map((row, rowIndex) => (
              <div className="ws-owner-row" key={row.name} style={{ "--i": rowIndex }}>
                <span><strong>{row.name}</strong><small>{row.plan}</small></span>
                {row.modules.map((on, index) => (
                  <b key={index} className={on ? "on" : ""}>{on ? <FaCheck /> : null}</b>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
