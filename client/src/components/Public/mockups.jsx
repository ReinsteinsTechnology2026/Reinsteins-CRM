import {
  FaLock, FaKey, FaShieldAlt, FaCheck, FaUsers, FaUserClock, FaTasks, FaComments, FaProjectDiagram, FaChartBar, FaCalendarCheck,
  FaPaperclip, FaSync, FaBuilding,
} from "react-icons/fa";

// ==========================================
// REPRESENTATIVE INTERFACE MOCKUPS
// Built from HTML and CSS (no images to download). They show the SHAPE of the real screens, with neutral placeholder labels and
// bars. They contain no customer names, no real figures and no performance claims, and are hidden from assistive technology.
// ==========================================

const SIDEBAR = [
  { icon: FaChartBar, label: "Dashboard", active: true },
  { icon: FaUsers, label: "Employees" },
  { icon: FaUserClock, label: "Attendance" },
  { icon: FaCalendarCheck, label: "Leave" },
  { icon: FaTasks, label: "Tasks" },
  { icon: FaProjectDiagram, label: "TechOps" },
  { icon: FaComments, label: "Chat" },
  { icon: FaKey, label: "ZioVault" },
];

const BARS = [46, 64, 38, 78, 58, 88, 52];

export function DashboardMock() {
  return (
    <div className="ws-mock ws-mock-dashboard" aria-hidden="true">
      <div className="ws-mock-chrome">
        <span /><span /><span />
        <em>Dashboard</em>
      </div>
      <div className="ws-mock-body">
        <div className="ws-mock-side">
          {SIDEBAR.map(({ icon: Icon, label, active }) => (
            <div key={label} className={`ws-mock-nav${active ? " active" : ""}`}>
              <Icon /> <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="ws-mock-main">
          <div className="ws-mock-kpis">
            {["Attendance", "Leave requests", "Active tasks", "Meetings"].map((label, index) => (
              <div className="ws-mock-kpi" key={label} style={{ "--i": index }}>
                <small>{label}</small>
                <i className="ws-skel ws-skel-lg" />
                <i className="ws-skel ws-skel-sm" />
              </div>
            ))}
          </div>
          <div className="ws-mock-panels">
            <div className="ws-mock-panel">
              <small>Activity overview</small>
              <div className="ws-mock-chart">
                {BARS.map((height, index) => (
                  <b key={index} style={{ "--h": `${height}%`, "--i": index }} />
                ))}
              </div>
            </div>
            <div className="ws-mock-panel">
              <small>My work</small>
              {["Review onboarding checklist", "Update shift schedule", "Approve leave request"].map((row, index) => (
                <div className="ws-mock-row" key={row} style={{ "--i": index }}>
                  <span className="ws-dot" />
                  <i>{row}</i>
                  <u className={`ws-pill ws-pill-${index}`} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <span className="ws-mock-tag">Illustrative interface</span>
    </div>
  );
}

export function FloatingChips() {
  return (
    <>
      <div className="ws-chip ws-chip-a" aria-hidden="true"><FaUserClock /> Online <i /></div>
      <div className="ws-chip ws-chip-b" aria-hidden="true"><FaTasks /> Task assigned</div>
      <div className="ws-chip ws-chip-c" aria-hidden="true"><FaLock /> Encrypted in your browser</div>
    </>
  );
}

const VAULT_ITEMS = ["Cloud console", "Staging server", "Shared mailbox", "Design tools"];

export function VaultMock() {
  return (
    <div className="ws-mock ws-mock-vault" aria-hidden="true">
      <div className="ws-mock-chrome">
        <span /><span /><span />
        <em>ZioVault</em>
      </div>
      <div className="ws-vault-body">
        <div className="ws-vault-list">
          <div className="ws-vault-tabs"><b>Company</b><span>Personal</span></div>
          {VAULT_ITEMS.map((item, index) => (
            <div className={`ws-vault-item${index === 0 ? " active" : ""}`} key={item}>
              <FaLock /> <span>{item}</span>
            </div>
          ))}
        </div>
        <div className="ws-vault-detail">
          <div className="ws-vault-head">
            <strong>Cloud console</strong>
            <u className="ws-vault-badge"><FaShieldAlt /> Encrypted</u>
          </div>
          <div className="ws-vault-field"><small>Username</small><span>admin@company</span></div>
          <div className="ws-vault-field"><small>Password</small><span className="ws-vault-secret">••••••••••••••</span></div>
          <div className="ws-vault-strength"><small>Password strength</small><div><i /><i /><i /><i /><i className="off" /></div></div>
          <div className="ws-vault-meta">
            <span><FaPaperclip /> Encrypted attachment</span>
            <span><FaSync /> Rotation reminder</span>
          </div>
          <div className="ws-vault-rights">
            <small>Shared with</small>
            <span>View</span><span>Reveal</span><span>Edit</span>
          </div>
        </div>
      </div>
      <span className="ws-mock-tag">Illustrative interface</span>
    </div>
  );
}

const OWNER_ROWS = [
  { name: "Company A", modules: [true, true, true, false] },
  { name: "Company B", modules: [true, true, false, false] },
  { name: "Company C", modules: [true, true, true, true] },
];
const OWNER_COLUMNS = ["Employees", "Tasks", "ZioVault", "Email"];

export function OwnerMock() {
  return (
    <div className="ws-mock ws-mock-owner" aria-hidden="true">
      <div className="ws-mock-chrome">
        <span /><span /><span />
        <em>Owner Portal</em>
      </div>
      <div className="ws-owner-body">
        <div className="ws-owner-head">
          <FaBuilding /> <strong>Companies</strong>
          <small>Module access per company</small>
        </div>
        <div className="ws-owner-table">
          <div className="ws-owner-row ws-owner-cols">
            <span />
            {OWNER_COLUMNS.map((column) => <em key={column}>{column}</em>)}
          </div>
          {OWNER_ROWS.map((row, rowIndex) => (
            <div className="ws-owner-row" key={row.name} style={{ "--i": rowIndex }}>
              <span>{row.name}</span>
              {row.modules.map((on, index) => (
                <b key={index} className={on ? "on" : ""}>{on ? <FaCheck /> : null}</b>
              ))}
            </div>
          ))}
        </div>
      </div>
      <span className="ws-mock-tag">Illustrative interface</span>
    </div>
  );
}
