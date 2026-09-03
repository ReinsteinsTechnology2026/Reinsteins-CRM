import { useEffect, useState } from "react";

import { FaPlus, FaTrash, FaSearch } from "react-icons/fa";

import { toast } from "react-toastify";

import {
  getProjectMembers,
  addProjectMembers,
  changeProjectMemberGroup,
  removeProjectMember,
  getProjectSecurityGroups,
  getProjectPermissionMatrix,
  updateProjectPermission,
  getProjectActivityLog,
} from "../../services/projectMemberService";

import { getTransferTargets } from "../../services/taskManagementService";

import "./ProjectSettings.css";

// ==========================================
// PROJECT SETTINGS (Phase 1)
//
// General | Members | Groups | Permissions | Activity
// — all gated on the backend independently of what
// this UI shows (PROJECT_MANAGE_MEMBERS/
// PROJECT_MANAGE_SECURITY). This component is only
// rendered at all when the caller already has one of
// those permissions (see ProjectWorkspace.jsx), but
// every write here still hits a permission-checked
// endpoint regardless.
// ==========================================

const PERMISSION_LABELS = {
  PROJECT_VIEW: "View Project",
  PROJECT_EDIT: "Edit Project",
  PROJECT_DELETE: "Delete Project",
  PROJECT_MANAGE_MEMBERS: "Manage Members",
  PROJECT_MANAGE_SECURITY: "Manage Security",
  USER_STORY_CREATE: "Create User Story",
  USER_STORY_EDIT: "Edit User Story",
  USER_STORY_DELETE: "Delete User Story",
  TASK_CREATE: "Create Task",
  TASK_EDIT: "Edit Task",
  TASK_DELETE: "Delete Task",
  TASK_ASSIGN: "Assign Task",
  TASK_TRANSFER: "Transfer Task",
  TASK_CHANGE_STATUS: "Change Task Status",
  BOARD_VIEW: "View Board",
  BACKLOG_VIEW: "View Backlog",
};

function formatDateTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function ProjectSettings({ project, projectId, myPermissions, canDeleteProject, onDeleteProject }) {

  const [activeSection, setActiveSection] = useState("general");

  const canManageMembers = Boolean(myPermissions?.PROJECT_MANAGE_MEMBERS);
  const canManageSecurity = Boolean(myPermissions?.PROJECT_MANAGE_SECURITY);

  return (
    <section className="my-team-card ps-section">

      <div className="ps-nav">
        <button type="button" className={activeSection === "general" ? "ps-nav-item active" : "ps-nav-item"} onClick={() => setActiveSection("general")}>General</button>
        {canManageMembers && (
          <button type="button" className={activeSection === "members" ? "ps-nav-item active" : "ps-nav-item"} onClick={() => setActiveSection("members")}>Members</button>
        )}
        {canManageMembers && (
          <button type="button" className={activeSection === "groups" ? "ps-nav-item active" : "ps-nav-item"} onClick={() => setActiveSection("groups")}>Groups</button>
        )}
        {canManageSecurity && (
          <button type="button" className={activeSection === "permissions" ? "ps-nav-item active" : "ps-nav-item"} onClick={() => setActiveSection("permissions")}>Permissions</button>
        )}
        {canManageMembers && (
          <button type="button" className={activeSection === "activity" ? "ps-nav-item active" : "ps-nav-item"} onClick={() => setActiveSection("activity")}>Activity</button>
        )}
      </div>

      {activeSection === "general" && (
        <GeneralPanel project={project} canDeleteProject={canDeleteProject} onDeleteProject={onDeleteProject} />
      )}
      {activeSection === "members" && canManageMembers && <MembersPanel projectId={projectId} />}
      {activeSection === "groups" && canManageMembers && <GroupsPanel projectId={projectId} />}
      {activeSection === "permissions" && canManageSecurity && <PermissionsPanel projectId={projectId} />}
      {activeSection === "activity" && canManageMembers && <ActivityPanel projectId={projectId} />}

    </section>
  );

}

// ==========================================
// GENERAL
// ==========================================

function GeneralPanel({ project, canDeleteProject, onDeleteProject }) {
  return (
    <div className="ps-panel">
      <div className="ps-detail-row"><span>Project Name</span><strong>{project.name}</strong></div>
      <div className="ps-detail-row"><span>Status</span><strong>{project.status}</strong></div>
      <div className="ps-detail-row"><span>Priority</span><strong>{project.priority || "--"}</strong></div>
      <div className="ps-detail-row"><span>Owner</span><strong>{project.owner_name || "No owner assigned"}</strong></div>
      <div className="ps-detail-row"><span>Created By</span><strong>{project.created_by_name || "--"}</strong></div>
      <div className="ps-detail-row"><span>Description</span><strong>{project.description || "--"}</strong></div>
      <p className="ps-hint">Use the Edit button on the project header to change these details.</p>

      {canDeleteProject && (
        <div className="ps-danger-zone">
          <div>
            <h3>Delete Project</h3>
            <p>Permanently delete this project and everything in it — Epics, Features, User Stories, Tasks, Sprints, Members, and Activity. This cannot be undone.</p>
          </div>
          <button type="button" className="ps-danger-button" onClick={onDeleteProject}>
            <FaTrash /> Delete Project
          </button>
        </div>
      )}
    </div>
  );
}

// ==========================================
// MEMBERS
// ==========================================

function MembersPanel({ projectId }) {

  const [members, setMembers] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      const [membersRes, groupsRes] = await Promise.all([
        getProjectMembers(projectId),
        getProjectSecurityGroups(projectId),
      ]);
      setMembers(membersRes.members || []);
      setGroups(groupsRes.groups || []);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load project members");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleGroupChange = async (userId, securityGroupId) => {
    try {
      await changeProjectMemberGroup(projectId, userId, securityGroupId);
      toast.success("Member group updated");
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to change member group");
    }
  };

  const handleRemove = async (userId, name) => {
    if (!window.confirm(`Remove ${name} from this project?`)) return;
    try {
      await removeProjectMember(projectId, userId);
      toast.success("Member removed");
      await load();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to remove member");
    }
  };

  return (
    <div className="ps-panel">

      <div className="ps-panel-header">
        <h3>Project Members</h3>
        <button type="button" className="exec-new-project-button" onClick={() => setShowAddModal(true)}>
          <FaPlus /> Add Member
        </button>
      </div>

      {loading ? (
        <div className="pw-empty-cell">Loading members...</div>
      ) : members.length === 0 ? (
        <div className="pw-empty-cell">No members yet.</div>
      ) : (
        <table className="pw-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Employee ID</th>
              <th>Email</th>
              <th>Group</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => (
              <tr key={member.id}>
                <td className="pw-task-title-cell">{member.full_name}</td>
                <td>{member.employee_id}</td>
                <td>{member.email || "--"}</td>
                <td>
                  <select
                    className="ps-group-select"
                    value={member.security_group_id}
                    onChange={(event) => handleGroupChange(member.user_id, Number(event.target.value))}
                  >
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>{group.name}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <button type="button" className="ps-icon-button ps-danger" onClick={() => handleRemove(member.user_id, member.full_name)} title="Remove">
                    <FaTrash />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showAddModal && (
        <AddMemberModal
          projectId={projectId}
          groups={groups}
          existingMemberIds={members.map((m) => m.user_id)}
          onClose={() => setShowAddModal(false)}
          onAdded={() => {
            setShowAddModal(false);
            load();
          }}
        />
      )}

    </div>
  );

}

function AddMemberModal({ projectId, groups, existingMemberIds, onClose, onAdded }) {

  const [candidates, setCandidates] = useState([]);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);
  const [securityGroupId, setSecurityGroupId] = useState(groups[0]?.id || "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getTransferTargets()
      .then((res) => setCandidates(res.employees || []))
      .catch(() => {});
  }, []);

  const filtered = candidates.filter(
    (user) =>
      !existingMemberIds.includes(user.id) &&
      user.full_name.toLowerCase().includes(search.trim().toLowerCase())
  );

  const toggleSelect = (userId) => {
    setSelectedIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  const handleSubmit = async () => {

    if (selectedIds.length === 0) {
      toast.error("Select at least one user");
      return;
    }

    if (!securityGroupId) {
      toast.error("Select a security group");
      return;
    }

    try {
      setSaving(true);
      const response = await addProjectMembers(projectId, selectedIds, Number(securityGroupId));
      toast.success(response.message || "Members added");
      onAdded();
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to add members");
    } finally {
      setSaving(false);
    }

  };

  return (
    <div className="employee-modal-overlay">
      <div className="employee-modal ps-add-member-modal">

        <div className="employee-modal-header">
          <div>
            <h2>Add Member</h2>
            <p>Search active users and choose their security group.</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="ps-search-box">
          <FaSearch />
          <input
            type="text"
            placeholder="Search active users..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="ps-candidate-list">
          {filtered.length === 0 ? (
            <div className="pw-empty-cell">No matching active users.</div>
          ) : filtered.map((user) => (
            <label className="ps-candidate-row" key={user.id}>
              <input
                type="checkbox"
                checked={selectedIds.includes(user.id)}
                onChange={() => toggleSelect(user.id)}
              />
              <span>{user.full_name} ({user.employee_id})</span>
            </label>
          ))}
        </div>

        <div className="employee-form-group">
          <label>Security Group</label>
          <select value={securityGroupId} onChange={(event) => setSecurityGroupId(event.target.value)}>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>{group.name}</option>
            ))}
          </select>
        </div>

        <div className="employee-modal-actions">
          <button type="button" className="cancel-employee-button" onClick={onClose}>Cancel</button>
          <button type="button" className="save-employee-button" disabled={saving} onClick={handleSubmit}>
            {saving ? "Adding..." : `Add ${selectedIds.length || ""} Member${selectedIds.length === 1 ? "" : "s"}`}
          </button>
        </div>

      </div>
    </div>
  );

}

// ==========================================
// GROUPS
// ==========================================

function GroupsPanel({ projectId }) {

  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjectSecurityGroups(projectId)
      .then((res) => setGroups(res.groups || []))
      .catch((error) => toast.error(error.response?.data?.message || "Unable to load groups"))
      .finally(() => setLoading(false));
  }, [projectId]);

  return (
    <div className="ps-panel">
      <h3>Security Groups</h3>
      <p className="ps-hint">Custom groups aren't available yet — Phase 1 ships with these four.</p>

      {loading ? (
        <div className="pw-empty-cell">Loading groups...</div>
      ) : (
        <div className="ps-group-grid">
          {groups.map((group) => (
            <div className="ps-group-card" key={group.id}>
              <strong>{group.name}</strong>
              <p>{group.description}</p>
              <span className="ps-group-count">{group.member_count} member{group.member_count === 1 ? "" : "s"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

}

// ==========================================
// PERMISSIONS
// ==========================================

function PermissionsPanel({ projectId }) {

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      setLoading(true);
      const response = await getProjectPermissionMatrix(projectId);
      setData(response);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to load permissions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleChange = async (securityGroupId, permissionKey, value) => {

    // Optimistic update
    setData((prev) => ({
      ...prev,
      matrix: {
        ...prev.matrix,
        [permissionKey]: { ...prev.matrix[permissionKey], [securityGroupId]: value },
      },
    }));

    try {
      await updateProjectPermission(projectId, securityGroupId, permissionKey, value);
    } catch (error) {
      toast.error(error.response?.data?.message || "Unable to update permission");
      load();
    }

  };

  if (loading || !data) {
    return <div className="ps-panel"><div className="pw-empty-cell">Loading permissions...</div></div>;
  }

  return (
    <div className="ps-panel">
      <h3>Permission Matrix</h3>
      <p className="ps-hint">Changes apply to this project only.</p>

      <div className="ps-matrix-scroll">
        <table className="pw-table ps-matrix-table">
          <thead>
            <tr>
              <th>Permission</th>
              {data.groups.map((group) => (
                <th key={group.id}>{group.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.permissionKeys.map((key) => (
              <tr key={key}>
                <td className="pw-task-title-cell">{PERMISSION_LABELS[key] || key}</td>
                {data.groups.map((group) => (
                  <td key={group.id}>
                    <select
                      className={`ps-permission-select ps-permission-${data.matrix[key][group.id]}`}
                      value={data.matrix[key][group.id]}
                      onChange={(event) => handleChange(group.id, key, event.target.value)}
                    >
                      <option value="allow">Allow</option>
                      <option value="deny">Deny</option>
                      <option value="not_set">Not Set</option>
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

}

// ==========================================
// ACTIVITY
// ==========================================

function ActivityPanel({ projectId }) {

  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getProjectActivityLog(projectId)
      .then((res) => setActivity(res.activity || []))
      .catch((error) => toast.error(error.response?.data?.message || "Unable to load activity"))
      .finally(() => setLoading(false));
  }, [projectId]);

  return (
    <div className="ps-panel">
      <h3>Project Activity</h3>

      {loading ? (
        <div className="pw-empty-cell">Loading activity...</div>
      ) : activity.length === 0 ? (
        <div className="pw-empty-cell">No membership or permission changes yet.</div>
      ) : (
        <div className="ps-activity-list">
          {activity.map((entry) => (
            <div className="ps-activity-row" key={entry.id}>
              <span className="ps-activity-type">{entry.activity_type.replace(/_/g, " ")}</span>
              <span>
                {entry.actor_name}
                {entry.target_name ? ` → ${entry.target_name}` : ""}
                {entry.details ? ` — ${entry.details}` : ""}
              </span>
              <span className="ps-activity-time">{formatDateTime(entry.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

}

export default ProjectSettings;
