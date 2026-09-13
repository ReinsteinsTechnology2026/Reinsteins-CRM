import { FaEnvelope } from "react-icons/fa";

// ==========================================
// SUPPORT (Platform Owner Dashboard)
//
// No ticketing system exists yet -- this is an honest placeholder,
// not a stand-in that pretends to be a working support inbox. Demo
// Requests (leads from the public site) already has its own
// dedicated page and is a different thing from support tickets, so
// this intentionally doesn't conflate the two.
// ==========================================

function PlatformSupport() {
  return (
    <div className="platform-page">

      <div className="platform-page-header">
        <div>
          <h1>Support</h1>
          <p>Support ticketing is not built yet.</p>
        </div>
      </div>

      <div className="platform-card" style={{ padding: 32, textAlign: "center" }}>
        <FaEnvelope style={{ fontSize: 28, color: "var(--p-text-muted)", marginBottom: 14 }} />
        <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>No support inbox connected</h2>
        <p style={{ fontSize: 13.5, color: "var(--p-text-secondary)", maxWidth: 420, margin: "0 auto" }}>
          This section will show company support requests once ticketing is built. For now, company admins should be
          directed to reach the ZioVenture team directly.
        </p>
      </div>

    </div>
  );
}

export default PlatformSupport;
