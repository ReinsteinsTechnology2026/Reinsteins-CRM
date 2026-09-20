import { useEffect, useState } from "react";
import { FaEnvelope, FaCheckCircle, FaTrash, FaSync } from "react-icons/fa";

import api from "../../services/api";

// ==========================================
// ADMIN EMAIL SETTINGS (Phase 16A foundation)
//
// Deliberately minimal -- domain registration/verification and
// mailbox provisioning ONLY. No inbox/compose/threading UI here (see
// the Phase 16A report: that's later phases, once a real mail server
// is connected). Every call below goes through the tenant-protected
// /api/email/* routes, so the company/employee isolation is enforced
// server-side (tenantEmailController.js) regardless of anything this
// component does -- this UI only ever shows what the backend already
// scoped to the logged-in company.
// ==========================================

function AdminEmailSettings() {
  const [domains, setDomains] = useState([]);
  const [mailboxes, setMailboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [newDomain, setNewDomain] = useState("");
  const [domainBusy, setDomainBusy] = useState(false);
  const [domainMessage, setDomainMessage] = useState("");

  const [dnsForDomainId, setDnsForDomainId] = useState(null);
  const [dnsRecords, setDnsRecords] = useState(null);

  const [mailboxForm, setMailboxForm] = useState({ domainId: "", tenantUserId: "", localPart: "" });
  const [mailboxBusy, setMailboxBusy] = useState(false);
  const [mailboxMessage, setMailboxMessage] = useState("");

  async function loadAll() {
    setLoading(true);
    setLoadError("");
    try {
      const [domainsRes, mailboxesRes] = await Promise.all([
        api.get("/email/domains"),
        api.get("/email/mailboxes"),
      ]);
      setDomains(domainsRes.data?.domains || []);
      setMailboxes(mailboxesRes.data?.mailboxes || []);
    } catch (err) {
      // A legacy (non company-aware) session has no tenant JWT, so
      // these calls 401 -- a real, expected state for this phase, not
      // a bug. Shown as a plain message rather than a raw error.
      if (err.response?.status === 401) {
        setLoadError("Business email is only available when signed in through your company's own login link.");
      } else {
        setLoadError("Unable to load email settings right now.");
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleAddDomain(e) {
    e.preventDefault();
    setDomainMessage("");
    setDomainBusy(true);
    try {
      await api.post("/email/domains", { domain: newDomain });
      setNewDomain("");
      setDomainMessage("Domain added. Add the DNS records below to verify ownership.");
      await loadAll();
    } catch (err) {
      setDomainMessage(err.response?.data?.message || "Unable to add domain.");
    } finally {
      setDomainBusy(false);
    }
  }

  async function handleShowDns(domainId) {
    if (dnsForDomainId === domainId) {
      setDnsForDomainId(null);
      setDnsRecords(null);
      return;
    }
    try {
      const res = await api.get(`/email/domains/${domainId}/dns-instructions`);
      setDnsForDomainId(domainId);
      setDnsRecords(res.data?.dns || null);
    } catch (_err) {
      setDnsRecords(null);
    }
  }

  async function handleVerify(domainId) {
    setDomainMessage("");
    try {
      const res = await api.post(`/email/domains/${domainId}/verify`, {});
      const status = res.data?.domain?.verification_status;
      setDomainMessage(
        status === "verified"
          ? "Domain verified."
          : "Verification record not found yet -- DNS changes can take time to propagate. Try again shortly."
      );
      await loadAll();
    } catch (err) {
      setDomainMessage(err.response?.data?.message || "Unable to verify domain.");
    }
  }

  async function handleDeleteDomain(domainId) {
    setDomainMessage("");
    try {
      await api.delete(`/email/domains/${domainId}`);
      await loadAll();
    } catch (err) {
      setDomainMessage(err.response?.data?.message || "Unable to remove domain.");
    }
  }

  async function handleCreateMailbox(e) {
    e.preventDefault();
    setMailboxMessage("");
    setMailboxBusy(true);
    try {
      await api.post("/email/mailboxes", {
        domainId: Number(mailboxForm.domainId),
        tenantUserId: Number(mailboxForm.tenantUserId),
        localPart: mailboxForm.localPart,
      });
      setMailboxForm({ domainId: "", tenantUserId: "", localPart: "" });
      setMailboxMessage("Mailbox created.");
      await loadAll();
    } catch (err) {
      setMailboxMessage(err.response?.data?.message || "Unable to create mailbox.");
    } finally {
      setMailboxBusy(false);
    }
  }

  const verifiedDomains = domains.filter((d) => d.verification_status === "verified");

  return (
    <section className="admin-settings-card">
      <div className="admin-settings-card-header">
        <div className="admin-settings-icon">
          <FaEnvelope />
        </div>
        <div>
          <h2>Business Email</h2>
          <p>
            Give your company its own verified email domain and mailboxes
            (e.g. you@{"{"}yourcompany.com{"}"}). Foundation stage: domains
            and mailboxes are managed here; the inbox itself arrives once
            real mail delivery is connected.
          </p>
        </div>
      </div>

      {loadError && <p className="admin-settings-error">{loadError}</p>}

      {!loadError && !loading && (
        <>
          <h3>Domains</h3>

          <form onSubmit={handleAddDomain} className="admin-email-inline-form">
            <input
              type="text"
              placeholder="yourcompany.com"
              value={newDomain}
              onChange={(e) => setNewDomain(e.target.value)}
              required
            />
            <button type="submit" disabled={domainBusy}>Add Domain</button>
          </form>
          {domainMessage && <p className="admin-settings-hint">{domainMessage}</p>}

          {domains.length === 0 && <p className="admin-settings-hint">No domains yet.</p>}

          <ul className="admin-email-list">
            {domains.map((d) => (
              <li key={d.id}>
                <span>{d.domain}</span>
                <span className={`admin-email-status admin-email-status-${d.verification_status}`}>
                  {d.verification_status === "verified" ? <FaCheckCircle /> : null}
                  {d.verification_status}
                </span>
                {d.verification_status !== "verified" && (
                  <>
                    <button type="button" onClick={() => handleShowDns(d.id)}>DNS Records</button>
                    <button type="button" onClick={() => handleVerify(d.id)}><FaSync /> Verify</button>
                  </>
                )}
                <button type="button" onClick={() => handleDeleteDomain(d.id)}><FaTrash /></button>

                {dnsForDomainId === d.id && dnsRecords && (
                  <div className="admin-email-dns-box">
                    {!dnsRecords.mailServerConfigured && (
                      <p className="admin-settings-hint">
                        Mail infrastructure is not connected yet -- MX/SPF/DKIM values below are placeholders
                        until that is set up (see the Phase 16A report). Add the verification TXT record now to
                        prove domain ownership; the rest can be added once real mail delivery is ready.
                      </p>
                    )}
                    <table>
                      <tbody>
                        {dnsRecords.records.map((r, i) => (
                          <tr key={i}>
                            <td>{r.type}</td>
                            <td>{r.host}</td>
                            <td className="admin-email-dns-value">{r.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ul>

          <h3>Mailboxes</h3>

          {verifiedDomains.length === 0 ? (
            <p className="admin-settings-hint">Verify a domain before creating mailboxes.</p>
          ) : (
            <form onSubmit={handleCreateMailbox} className="admin-email-inline-form">
              <select
                value={mailboxForm.domainId}
                onChange={(e) => setMailboxForm((f) => ({ ...f, domainId: e.target.value }))}
                required
              >
                <option value="">Domain</option>
                {verifiedDomains.map((d) => (
                  <option key={d.id} value={d.id}>{d.domain}</option>
                ))}
              </select>
              <input
                type="text"
                placeholder="mailbox name (e.g. sales)"
                value={mailboxForm.localPart}
                onChange={(e) => setMailboxForm((f) => ({ ...f, localPart: e.target.value }))}
                required
              />
              <input
                type="number"
                placeholder="Employee (tenant user) id"
                value={mailboxForm.tenantUserId}
                onChange={(e) => setMailboxForm((f) => ({ ...f, tenantUserId: e.target.value }))}
                required
              />
              <button type="submit" disabled={mailboxBusy}>Create Mailbox</button>
            </form>
          )}
          {mailboxMessage && <p className="admin-settings-hint">{mailboxMessage}</p>}

          {mailboxes.length === 0 && <p className="admin-settings-hint">No mailboxes yet.</p>}

          <ul className="admin-email-list">
            {mailboxes.map((m) => (
              <li key={m.id}>
                <span>{m.email_address}</span>
                <span className={`admin-email-status admin-email-status-${m.status}`}>{m.status}</span>
                <span className="admin-settings-hint">
                  {m.provisioning_status === "provisioned" ? "connected" : "not yet connected to mail server"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export default AdminEmailSettings;
