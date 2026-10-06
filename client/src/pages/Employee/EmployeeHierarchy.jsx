import { useEffect, useState } from "react";

import { useLocation, useNavigate } from "react-router-dom";
import { getPortalBasePath } from "../../utils/portalBasePath";

import { FaSitemap, FaArrowUp, FaArrowDown, FaUsers } from "react-icons/fa";

import { toast } from "react-toastify";

import { getMyHierarchy, getOrgChildren } from "../../services/hierarchyService";

import "./EmployeeHierarchy.css";

function getCurrentUser() {
  try {
    return JSON.parse(sessionStorage.getItem("user"));
  } catch {
    return null;
  }
}

function isAdminTier(user) {
  return user?.role === "admin" || ["admin", "super_admin"].includes(user?.systemAccess);
}

function initialsOf(name) {
  return (name || "?")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function countLabel(count) {
  if (!count) return "No direct reports";
  return `${count} direct report${count === 1 ? "" : "s"}`;
}

function PersonCard({ node, isYou = false, isSelected = false, onSelect, subLabel }) {
  return (
    <button
      type="button"
      className={`eh-card${isYou ? " eh-card-you" : ""}${isSelected ? " eh-card-selected" : ""}`}
      onClick={() => onSelect(node)}
    >
      <span className="eh-avatar">{initialsOf(node.full_name)}</span>
      <span className="eh-card-body">
        <span className="eh-card-name">
          {node.full_name}
          {isYou && <span className="eh-you-badge">YOU</span>}
        </span>
        <span className="eh-card-designation">{node.designation || "No designation"}</span>
        <span className="eh-card-meta">
          {node.department_name || "No department"}
          {subLabel ? ` · ${subLabel}` : ""}
        </span>
      </span>
    </button>
  );
}

function EmployeeHierarchy() {

  const navigate = useNavigate();
  const location = useLocation();
  const basePath = getPortalBasePath(location.pathname);
  const currentUser = getCurrentUser();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [selectedReports, setSelectedReports] = useState(null);
  const [loadingReports, setLoadingReports] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      setError("");
      const response = await getMyHierarchy();
      setData(response);
      setSelected(response.self);
      setSelectedReports(null);
    } catch (err) {
      const message = err.response?.data?.message || "Unable to load your hierarchy";
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSelect = (node) => {
    setSelected(node);
    setSelectedReports(null);
  };

  const handleLoadReports = async () => {
    if (!selected) return;
    try {
      setLoadingReports(true);
      const response = await getOrgChildren(selected.id);
      setSelectedReports(response.nodes || []);
    } catch (err) {
      toast.error(err.response?.data?.message || "Unable to load direct reports");
    } finally {
      setLoadingReports(false);
    }
  };

  if (loading) {
    return <div className="eh-state">Loading your position in the organization...</div>;
  }

  if (error || !data) {
    return (
      <div className="eh-state eh-state-error">
        <p>{error || "Unable to load your hierarchy."}</p>
        <button type="button" className="eh-button" onClick={loadData}>Try again</button>
      </div>
    );
  }

  const { self, managers, peers, directReports } = data;
  const directManager = managers[managers.length - 1] || null;
  const isSelectedYou = selected?.id === self.id;

  return (
    <div className="eh-page">

      <header className="eh-header">
        <div>
          <h1><FaSitemap /> Employee Hierarchy</h1>
          <p>See who you report to, who reports to you, and where you sit in the organization.</p>
        </div>
        {isAdminTier(currentUser) && (
          <button
            type="button"
            className="eh-button"
            onClick={() => navigate(`${basePath}/organization/org-chart`)}
          >
            Open full organization chart
          </button>
        )}
      </header>

      <section className="eh-section">
        <h2 className="eh-section-title">Reporting chain</h2>

        <div className="eh-chain">
          {managers.map((manager) => (
            <div className="eh-chain-step" key={manager.id}>
              <PersonCard
                node={manager}
                isSelected={selected?.id === manager.id}
                onSelect={handleSelect}
                subLabel={countLabel(manager.direct_report_count)}
              />
              <div className="eh-connector" aria-hidden="true"><FaArrowDown /></div>
            </div>
          ))}

          <div className="eh-chain-step">
            <PersonCard
              node={self}
              isYou
              isSelected={isSelectedYou}
              onSelect={handleSelect}
              subLabel={countLabel(directReports.length)}
            />
          </div>
        </div>

        {managers.length === 0 && (
          <p className="eh-empty">You are at the top of the reporting chain.</p>
        )}
      </section>

      {directManager && (
        <section className="eh-section">
          <h2 className="eh-section-title">
            <FaUsers /> Team under {directManager.full_name}
          </h2>
          <div className="eh-grid">
            <PersonCard
              node={self}
              isYou
              isSelected={isSelectedYou}
              onSelect={handleSelect}
            />
            {peers.map((peer) => (
              <PersonCard
                key={peer.id}
                node={peer}
                isSelected={selected?.id === peer.id}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </section>
      )}

      <section className="eh-section">
        <h2 className="eh-section-title"><FaArrowDown /> Direct reports</h2>
        {directReports.length === 0 ? (
          <p className="eh-empty">No direct reports</p>
        ) : (
          <div className="eh-grid">
            {directReports.map((report) => (
              <PersonCard
                key={report.id}
                node={report}
                isSelected={selected?.id === report.id}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </section>

      {selected && (
        <aside className="eh-detail" aria-live="polite">
          <div className="eh-detail-header">
            <span className="eh-avatar eh-avatar-lg">{initialsOf(selected.full_name)}</span>
            <div>
              <strong>
                {selected.full_name}
                {isSelectedYou && <span className="eh-you-badge">YOU</span>}
              </strong>
              <span className="eh-detail-sub">{selected.designation || "No designation"}</span>
            </div>
          </div>

          <dl className="eh-detail-grid">
            <div>
              <dt>Employee ID</dt>
              <dd>{selected.employee_id || "—"}</dd>
            </div>
            <div>
              <dt>Department</dt>
              <dd>{selected.department_name || "—"}</dd>
            </div>
            <div>
              <dt>Direct reports</dt>
              <dd>{selected.direct_report_count ?? 0}</dd>
            </div>
            {isSelectedYou && (
              <div>
                <dt>Reports to</dt>
                <dd>{directManager ? directManager.full_name : "No manager assigned"}</dd>
              </div>
            )}
          </dl>

          <div className="eh-detail-actions">
            {selected.direct_report_count > 0 && (
              <button
                type="button"
                className="eh-button"
                onClick={handleLoadReports}
                disabled={loadingReports}
              >
                <FaArrowDown /> {loadingReports ? "Loading..." : "View their direct reports"}
              </button>
            )}
            {!isSelectedYou && (
              <button type="button" className="eh-button eh-button-ghost" onClick={() => handleSelect(self)}>
                <FaArrowUp /> Back to my position
              </button>
            )}
          </div>

          {selectedReports && (
            <div className="eh-detail-reports">
              {selectedReports.length === 0 ? (
                <p className="eh-empty">No direct reports</p>
              ) : (
                selectedReports.map((node) => (
                  <PersonCard key={node.id} node={node} onSelect={handleSelect} />
                ))
              )}
            </div>
          )}
        </aside>
      )}

    </div>
  );
}

export default EmployeeHierarchy;
