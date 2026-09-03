import { useEffect, useState } from "react";

import { FaSearch, FaChevronDown, FaChevronRight, FaBuilding, FaIdBadge } from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "../Admin/Organization.css";
import "./MyTeam.css";

// ==========================================
// EXECUTIVE ORGANIZATION VIEW
//
// Read-only view of the same organization data
// the Admin portal's Organization page manages —
// no create/edit/deactivate controls here, since
// Founder/Chairman need visibility, not the
// management UI (that stays Admin/HR-only,
// enforced server-side on the write endpoints
// this page never calls). Reuses the exact same
// GET endpoints (/departments, /designations,
// /organization/chart/roots|:id/children,
// /organization/search) — no new backend routes,
// no duplicated data logic.
// ==========================================

function ExecutiveOrganization() {

  const [departments, setDepartments] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [loadingLists, setLoadingLists] = useState(true);

  const [departmentFilter, setDepartmentFilter] = useState("");
  const [roots, setRoots] = useState([]);
  const [loadingChart, setLoadingChart] = useState(true);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    const loadLists = async () => {
      try {
        setLoadingLists(true);
        const [deptRes, desRes] = await Promise.all([
          api.get("/departments"),
          api.get("/designations"),
        ]);
        setDepartments(deptRes.data.departments || []);
        setDesignations(desRes.data.designations || []);
      } catch (error) {
        toast.error(error.response?.data?.message || "Unable to load organization data");
      } finally {
        setLoadingLists(false);
      }
    };

    loadLists();
  }, []);

  const loadRoots = async (deptId) => {
    try {
      setLoadingChart(true);
      const response = await api.get("/organization/chart/roots", {
        params: deptId ? { departmentId: deptId } : {},
      });
      setRoots((response.data.nodes || []).map((n) => ({ ...n, expanded: false, children: null })));
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load organization chart");
    } finally {
      setLoadingChart(false);
    }
  };

  useEffect(() => {
    loadRoots(departmentFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departmentFilter]);

  const handleSearch = async (event) => {
    event.preventDefault();

    if (!searchTerm.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const response = await api.get("/organization/search", { params: { q: searchTerm.trim() } });
      setSearchResults(response.data.results || []);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to search");
    }
  };

  return (

    <div className="employee-page-content">

      {/* DEPARTMENTS + DESIGNATIONS */}

      <section className="my-team-card">

        <div className="my-team-header">
          <h2><FaBuilding /> Departments</h2>
          <p>Active departments across the company.</p>
        </div>

        {loadingLists ? (
          <div className="my-team-empty">Loading...</div>
        ) : departments.filter((d) => d.status === "active").length === 0 ? (
          <div className="my-team-empty">No active departments yet.</div>
        ) : (
          <div className="my-team-list">
            {departments.filter((d) => d.status === "active").map((department) => (
              <div className="my-team-member-row" key={department.id}>
                <div className="my-team-member-info">
                  <strong>{department.name}</strong>
                  <span>{department.code} · {department.member_count ?? 0} member(s)</span>
                </div>
                {department.head_name && (
                  <span className="my-team-pending-leave">Head: {department.head_name}</span>
                )}
              </div>
            ))}
          </div>
        )}

      </section>

      <section className="my-team-card">

        <div className="my-team-header">
          <h2><FaIdBadge /> Designations</h2>
          <p>Active job designations in the catalog.</p>
        </div>

        {loadingLists ? (
          <div className="my-team-empty">Loading...</div>
        ) : designations.filter((d) => d.status === "active").length === 0 ? (
          <div className="my-team-empty">No active designations yet.</div>
        ) : (
          <div className="my-team-list">
            {designations.filter((d) => d.status === "active").map((designation) => (
              <div className="my-team-member-row" key={designation.id}>
                <div className="my-team-member-info">
                  <strong>{designation.title}</strong>
                </div>
              </div>
            ))}
          </div>
        )}

      </section>

      {/* ORGANIZATION CHART */}

      <section className="my-team-card">

        <div className="my-team-header">
          <h2>Organization Chart</h2>
          <p>Built dynamically from reporting relationships.</p>
        </div>

        <div className="org-chart-controls">
          <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>{department.name}</option>
            ))}
          </select>
        </div>

        <form className="org-chart-search" onSubmit={handleSearch}>
          <FaSearch />
          <input
            type="text"
            placeholder="Search by name or Employee/Intern ID..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </form>

        {searchResults.length > 0 && (
          <div className="org-chart-search-results">
            {searchResults.map((result) => (
              <div className="org-chart-search-result" key={result.id}>
                <strong>{result.full_name}</strong>
                <span>{result.employee_id} · {result.designation || "No designation"} · {result.department_name || "No department"}</span>
                <span className={`employment-type-badge ${result.employment_type}`}>{result.employment_type}</span>
              </div>
            ))}
          </div>
        )}

        {loadingChart ? (
          <div className="organization-empty">Loading organization chart...</div>
        ) : roots.length === 0 ? (
          <div className="organization-empty">No one is currently at the top of this reporting structure.</div>
        ) : (
          <div className="org-chart-tree">
            {roots.map((node) => (
              <ExecutiveOrgChartNode key={node.id} node={node} onUpdate={(updated) => {
                setRoots((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
              }} />
            ))}
          </div>
        )}

      </section>

    </div>

  );

}

function ExecutiveOrgChartNode({ node, onUpdate }) {

  const [loadingChildren, setLoadingChildren] = useState(false);

  const toggleExpand = async () => {

    if (node.expanded) {
      onUpdate({ ...node, expanded: false });
      return;
    }

    if (node.children) {
      onUpdate({ ...node, expanded: true });
      return;
    }

    try {
      setLoadingChildren(true);
      const response = await api.get(`/organization/chart/${node.id}/children`);
      const children = (response.data.nodes || []).map((n) => ({ ...n, expanded: false, children: null }));
      onUpdate({ ...node, expanded: true, children });
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load reporting chain");
    } finally {
      setLoadingChildren(false);
    }

  };

  return (
    <div className="org-chart-node">

      <div className="org-chart-node-card">

        {node.direct_report_count > 0 ? (
          <button type="button" className="org-chart-expand-button" onClick={toggleExpand} disabled={loadingChildren}>
            {node.expanded ? <FaChevronDown /> : <FaChevronRight />}
          </button>
        ) : (
          <span className="org-chart-expand-spacer" />
        )}

        <div className="org-chart-node-info">
          <strong>{node.full_name}</strong>
          <span>{node.employee_id} · {node.designation || "No designation"}</span>
          <span className="org-chart-node-meta">
            {node.department_name || "No department"}
            {" · "}
            <span className={`employment-type-badge ${node.employment_type}`}>{node.employment_type}</span>
          </span>
        </div>

        {node.direct_report_count > 0 && (
          <span className="org-chart-report-count">{node.direct_report_count}</span>
        )}

      </div>

      {node.expanded && node.children && node.children.length > 0 && (
        <div className="org-chart-children">
          {node.children.map((child) => (
            <ExecutiveOrgChartNode
              key={child.id}
              node={child}
              onUpdate={(updated) => {
                const newChildren = node.children.map((c) => (c.id === updated.id ? updated : c));
                onUpdate({ ...node, children: newChildren });
              }}
            />
          ))}
        </div>
      )}

    </div>
  );

}

export default ExecutiveOrganization;
