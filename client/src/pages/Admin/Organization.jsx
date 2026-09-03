import { useEffect, useState } from "react";

import { useParams } from "react-router-dom";

import {
  FaBuilding,
  FaIdBadge,
  FaSitemap,
  FaPlus,
  FaTimes,
  FaEdit,
  FaUserTie,
  FaUsers,
  FaChevronRight,
  FaChevronDown,
  FaSearch,
} from "react-icons/fa";

import { toast } from "react-toastify";

import api from "../../services/api";

import "./Organization.css";

// ==========================================
// ORGANIZATION
//
// One admin page, three tabs — Departments,
// Designations, Org Chart. The sidebar's expandable
// "Organization" section (AdminSidebar.jsx) now
// deep-links to each tab via an optional :tab URL
// segment (/admin/organization/org-chart, /departments,
// /designations) -- read once on mount below to pick
// the initial tab; the bare /admin/organization route
// (no segment) keeps defaulting to "departments"
// exactly as before. This is the same page/component
// either way, just URL-aware now -- the internal tab
// buttons below are otherwise completely unchanged.
// ==========================================

const TAB_SLUG_TO_STATE = {
  "departments": "departments",
  "designations": "designations",
  "org-chart": "chart",
};

function Organization() {

  const { tab } = useParams();

  const [activeTab, setActiveTab] = useState(
    () => TAB_SLUG_TO_STATE[tab] || "departments"
  );

  // React Router does not remount this component when navigating
  // between /admin/organization/:tab variants (same route element) --
  // so a sidebar click while already on this page needs this effect
  // to actually switch tabs, not just the initial useState above.
  useEffect(() => {
    if (tab && TAB_SLUG_TO_STATE[tab]) {
      setActiveTab(TAB_SLUG_TO_STATE[tab]);
    }
  }, [tab]);

  return (

    <div className="organization-content">

      <div className="organization-header">
        <div>
          <h2>Organization</h2>
          <p>Departments, designations and the reporting structure.</p>
        </div>
      </div>

      <div className="organization-tabs">

        <button
          type="button"
          className={activeTab === "departments" ? "organization-tab active" : "organization-tab"}
          onClick={() => setActiveTab("departments")}
        >
          <FaBuilding /> Departments
        </button>

        <button
          type="button"
          className={activeTab === "designations" ? "organization-tab active" : "organization-tab"}
          onClick={() => setActiveTab("designations")}
        >
          <FaIdBadge /> Designations
        </button>

        <button
          type="button"
          className={activeTab === "chart" ? "organization-tab active" : "organization-tab"}
          onClick={() => setActiveTab("chart")}
        >
          <FaSitemap /> Org Chart
        </button>

      </div>

      {activeTab === "departments" && <DepartmentsTab />}
      {activeTab === "designations" && <DesignationsTab />}
      {activeTab === "chart" && <OrgChartTab />}

    </div>

  );

}

// ==========================================
// DEPARTMENTS TAB
// ==========================================

function DepartmentsTab() {

  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [employees, setEmployees] = useState([]);

  const [showForm, setShowForm] = useState(false);
  const [editingDepartment, setEditingDepartment] = useState(null);
  const [formData, setFormData] = useState({ name: "", code: "", description: "" });
  const [saving, setSaving] = useState(false);

  const [headTarget, setHeadTarget] = useState(null);
  const [headSelection, setHeadSelection] = useState("");

  const [membersTarget, setMembersTarget] = useState(null);
  const [members, setMembers] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);

  const loadDepartments = async () => {
    try {
      setLoading(true);
      const response = await api.get("/departments");
      setDepartments(response.data.departments || []);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load departments");
    } finally {
      setLoading(false);
    }
  };

  const loadEmployees = async () => {
    try {
      const response = await api.get("/employees");
      setEmployees((response.data.employees || []).filter((e) => e.employment_status === "active"));
    } catch (error) {
      console.error("Load employees for department head picker error:", error);
    }
  };

  useEffect(() => {
    loadDepartments();
    loadEmployees();
  }, []);

  const openCreate = () => {
    setEditingDepartment(null);
    setFormData({ name: "", code: "", description: "" });
    setShowForm(true);
  };

  const openEdit = (department) => {
    setEditingDepartment(department);
    setFormData({
      name: department.name,
      code: department.code,
      description: department.description || "",
    });
    setShowForm(true);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!formData.name.trim() || !formData.code.trim()) {
      toast.error("Department name and code are required");
      return;
    }

    try {
      setSaving(true);

      if (editingDepartment) {
        await api.put(`/departments/${editingDepartment.id}`, formData);
        toast.success("Department updated successfully");
      } else {
        await api.post("/departments", formData);
        toast.success("Department created successfully");
      }

      setShowForm(false);
      await loadDepartments();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to save department");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (department) => {
    const nextStatus = department.status === "active" ? "inactive" : "active";

    try {
      await api.patch(`/departments/${department.id}/status`, { status: nextStatus });
      toast.success(`Department ${nextStatus === "active" ? "activated" : "deactivated"}`);
      await loadDepartments();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to update department status");
    }
  };

  const openHeadModal = (department) => {
    setHeadTarget(department);
    setHeadSelection(department.department_head_id || "");
  };

  const handleSetHead = async (event) => {
    event.preventDefault();

    try {
      await api.put(`/departments/${headTarget.id}/head`, {
        departmentHeadId: headSelection || null,
      });
      toast.success("Department head updated");
      setHeadTarget(null);
      await loadDepartments();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to update department head");
    }
  };

  const openMembers = async (department) => {
    setMembersTarget(department);
    setMembersLoading(true);

    try {
      const response = await api.get(`/departments/${department.id}/members`, {
        params: { limit: 100 },
      });
      setMembers(response.data.members || []);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load department members");
    } finally {
      setMembersLoading(false);
    }
  };

  return (
    <div className="organization-panel">

      <div className="organization-panel-header">
        <div>
          <h3>Departments</h3>
          <span>{departments.length} department{departments.length !== 1 ? "s" : ""}</span>
        </div>

        <button type="button" className="organization-add-button" onClick={openCreate}>
          <FaPlus /> Add Department
        </button>
      </div>

      {loading ? (
        <div className="organization-empty">Loading departments...</div>
      ) : departments.length === 0 ? (
        <div className="organization-empty">No departments yet. Create your first one.</div>
      ) : (
        <div className="department-cards">
          {departments.map((department) => (
            <div className="department-card" key={department.id}>

              <div className="department-card-top">
                <div>
                  <h4>{department.name}</h4>
                  <span className="department-code">{department.code}</span>
                </div>
                <span className={`department-status-badge ${department.status}`}>
                  {department.status}
                </span>
              </div>

              {department.description && (
                <p className="department-description">{department.description}</p>
              )}

              <div className="department-card-row">
                <FaUserTie />
                <span>
                  {department.department_head_name
                    ? `${department.department_head_name} (${department.department_head_employee_id})`
                    : "No department head assigned"}
                </span>
              </div>

              <div className="department-card-row">
                <FaUsers />
                <span>{department.member_count} active member{department.member_count !== 1 ? "s" : ""}</span>
              </div>

              <div className="department-card-actions">
                <button type="button" onClick={() => openMembers(department)}>View Members</button>
                <button type="button" onClick={() => openHeadModal(department)}>Set Head</button>
                <button type="button" onClick={() => openEdit(department)}><FaEdit /> Edit</button>
                <button
                  type="button"
                  className={department.status === "active" ? "department-deactivate" : "department-activate"}
                  onClick={() => handleToggleStatus(department)}
                >
                  {department.status === "active" ? "Deactivate" : "Activate"}
                </button>
              </div>

            </div>
          ))}
        </div>
      )}

      {/* CREATE / EDIT MODAL */}

      {showForm && (
        <div className="employee-modal-overlay">
          <div className="employee-modal">

            <div className="employee-modal-header">
              <div>
                <h2>{editingDepartment ? "Edit Department" : "Add Department"}</h2>
                <p>Departments are configurable — nothing is hard-coded.</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowForm(false)}>
                <FaTimes />
              </button>
            </div>

            <form onSubmit={handleSubmit}>

              <div className="employee-form-group">
                <label>Department Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData((p) => ({ ...p, name: e.target.value }))}
                  placeholder="Example: Technology"
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>Department Code</label>
                <input
                  type="text"
                  value={formData.code}
                  onChange={(e) => setFormData((p) => ({ ...p, code: e.target.value }))}
                  placeholder="Example: TECH"
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>Description</label>
                <textarea
                  rows="3"
                  value={formData.description}
                  onChange={(e) => setFormData((p) => ({ ...p, description: e.target.value }))}
                  placeholder="Optional"
                />
              </div>

              <div className="employee-modal-actions">
                <button type="button" className="cancel-employee-button" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="save-employee-button" disabled={saving}>
                  {saving ? "Saving..." : editingDepartment ? "Save Changes" : "Create Department"}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

      {/* SET HEAD MODAL */}

      {headTarget && (
        <div className="employee-modal-overlay">
          <div className="employee-modal">

            <div className="employee-modal-header">
              <div>
                <h2>Set Department Head</h2>
                <p>{headTarget.name}</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setHeadTarget(null)}>
                <FaTimes />
              </button>
            </div>

            <form onSubmit={handleSetHead}>

              <div className="employee-form-group">
                <label>Department Head</label>
                <select
                  value={headSelection}
                  onChange={(e) => setHeadSelection(e.target.value)}
                >
                  <option value="">Not assigned</option>
                  {employees.map((employee) => (
                    <option key={employee.id} value={employee.id}>
                      {employee.full_name} ({employee.employee_id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="employee-modal-actions">
                <button type="button" className="cancel-employee-button" onClick={() => setHeadTarget(null)}>
                  Cancel
                </button>
                <button type="submit" className="save-employee-button">Save</button>
              </div>

            </form>

          </div>
        </div>
      )}

      {/* MEMBERS MODAL */}

      {membersTarget && (
        <div className="employee-modal-overlay">
          <div className="employee-modal employee-details-modal">

            <div className="employee-modal-header">
              <div>
                <h2>{membersTarget.name} — Members</h2>
                <p>Active employees and interns in this department.</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setMembersTarget(null)}>
                <FaTimes />
              </button>
            </div>

            <div className="organization-members-list">
              {membersLoading ? (
                <div className="organization-empty">Loading members...</div>
              ) : members.length === 0 ? (
                <div className="organization-empty">No members in this department.</div>
              ) : (
                members.map((member) => (
                  <div className="organization-member-row" key={member.id}>
                    <div>
                      <strong>{member.full_name}</strong>
                      <span>{member.employee_id} · {member.designation || "No designation"}</span>
                    </div>
                    <span className={`employment-type-badge ${member.employment_type}`}>
                      {member.employment_type}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="employee-modal-actions">
              <button type="button" className="cancel-employee-button" onClick={() => setMembersTarget(null)}>
                Close
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );

}

// ==========================================
// DESIGNATIONS TAB
// ==========================================

function DesignationsTab() {

  const [designations, setDesignations] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [editingDesignation, setEditingDesignation] = useState(null);
  const [formData, setFormData] = useState({ title: "", departmentId: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [designationsResponse, departmentsResponse] = await Promise.all([
        api.get("/designations"),
        api.get("/departments"),
      ]);
      setDesignations(designationsResponse.data.designations || []);
      setDepartments(departmentsResponse.data.departments || []);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load designations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreate = () => {
    setEditingDesignation(null);
    setFormData({ title: "", departmentId: "" });
    setShowForm(true);
  };

  const openEdit = (designation) => {
    setEditingDesignation(designation);
    setFormData({ title: designation.title, departmentId: designation.department_id || "" });
    setShowForm(true);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!formData.title.trim()) {
      toast.error("Designation title is required");
      return;
    }

    try {
      setSaving(true);

      if (editingDesignation) {
        await api.put(`/designations/${editingDesignation.id}`, formData);
        toast.success("Designation updated successfully");
      } else {
        await api.post("/designations", formData);
        toast.success("Designation created successfully");
      }

      setShowForm(false);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to save designation");
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (designation) => {
    const nextStatus = designation.status === "active" ? "inactive" : "active";

    try {
      await api.patch(`/designations/${designation.id}/status`, { status: nextStatus });
      toast.success(`Designation ${nextStatus === "active" ? "activated" : "deactivated"}`);
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to update designation status");
    }
  };

  return (
    <div className="organization-panel">

      <div className="organization-panel-header">
        <div>
          <h3>Designations</h3>
          <span>{designations.length} designation{designations.length !== 1 ? "s" : ""}</span>
        </div>

        <button type="button" className="organization-add-button" onClick={openCreate}>
          <FaPlus /> Add Designation
        </button>
      </div>

      {loading ? (
        <div className="organization-empty">Loading designations...</div>
      ) : designations.length === 0 ? (
        <div className="organization-empty">No designations yet.</div>
      ) : (
        <div className="organization-table-wrapper">
          <table className="organization-table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Department</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {designations.map((designation) => (
                <tr key={designation.id}>
                  <td>{designation.title}</td>
                  <td>{designation.department_name || "Any department"}</td>
                  <td>
                    <span className={`department-status-badge ${designation.status}`}>
                      {designation.status}
                    </span>
                  </td>
                  <td>
                    <div className="employee-actions">
                      <button type="button" className="edit-employee-action" onClick={() => openEdit(designation)}>
                        <FaEdit />
                      </button>
                      <button
                        type="button"
                        className={designation.status === "active" ? "deactivate-employee-action" : "activate-employee-action"}
                        onClick={() => handleToggleStatus(designation)}
                      >
                        {designation.status === "active" ? "Deactivate" : "Activate"}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="employee-modal-overlay">
          <div className="employee-modal">

            <div className="employee-modal-header">
              <div>
                <h2>{editingDesignation ? "Edit Designation" : "Add Designation"}</h2>
                <p>Used as the catalog for Designation dropdowns across WorkHub.</p>
              </div>
              <button type="button" className="modal-close" onClick={() => setShowForm(false)}>
                <FaTimes />
              </button>
            </div>

            <form onSubmit={handleSubmit}>

              <div className="employee-form-group">
                <label>Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData((p) => ({ ...p, title: e.target.value }))}
                  placeholder="Example: Software Engineer"
                  required
                />
              </div>

              <div className="employee-form-group">
                <label>Department (optional)</label>
                <select
                  value={formData.departmentId}
                  onChange={(e) => setFormData((p) => ({ ...p, departmentId: e.target.value }))}
                >
                  <option value="">Any department</option>
                  {departments.map((department) => (
                    <option key={department.id} value={department.id}>{department.name}</option>
                  ))}
                </select>
              </div>

              <div className="employee-modal-actions">
                <button type="button" className="cancel-employee-button" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
                <button type="submit" className="save-employee-button" disabled={saving}>
                  {saving ? "Saving..." : editingDesignation ? "Save Changes" : "Create Designation"}
                </button>
              </div>

            </form>

          </div>
        </div>
      )}

    </div>
  );

}

// ==========================================
// ORG CHART TAB
// Lazy/expandable — never loads the whole
// organization at once. Roots load first;
// each node's children are fetched only when
// that node is expanded.
// ==========================================

function OrgChartTab() {

  const [departments, setDepartments] = useState([]);
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);

  const [searchTerm, setSearchTerm] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  useEffect(() => {
    api.get("/departments").then((res) => setDepartments(res.data.departments || [])).catch(() => {});
  }, []);

  const loadRoots = async (deptId) => {
    try {
      setLoading(true);
      const response = await api.get("/organization/chart/roots", {
        params: deptId ? { departmentId: deptId } : {},
      });
      setRoots((response.data.nodes || []).map((n) => ({ ...n, expanded: false, children: null })));
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load organization chart");
    } finally {
      setLoading(false);
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
    <div className="organization-panel">

      <div className="organization-panel-header">
        <div>
          <h3>Organization Chart</h3>
          <span>Built dynamically from reporting relationships.</span>
        </div>

        <div className="org-chart-controls">
          <select value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>{department.name}</option>
            ))}
          </select>
        </div>
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

      {loading ? (
        <div className="organization-empty">Loading organization chart...</div>
      ) : roots.length === 0 ? (
        <div className="organization-empty">No one is currently at the top of this reporting structure.</div>
      ) : (
        <div className="org-chart-tree">
          {roots.map((node) => (
            <OrgChartNode key={node.id} node={node} onUpdate={(updated) => {
              setRoots((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
            }} />
          ))}
        </div>
      )}

    </div>
  );

}

function OrgChartNode({ node, onUpdate }) {

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
            <OrgChartNode
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

export default Organization;
