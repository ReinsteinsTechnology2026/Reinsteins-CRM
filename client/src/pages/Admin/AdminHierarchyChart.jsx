import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  FaSearch,
  FaTimes,
  FaChevronDown,
  FaChevronRight,
  FaUsers,
  FaIdBadge,
  FaBuilding,
  FaExclamationTriangle,
  FaSitemap,
} from "react-icons/fa";

import { toast } from "react-toastify";

import { getOrgChartFullTree } from "../../services/hierarchyService";
import { API_ORIGIN } from "../../config";
import { EXECUTIVE_DASHBOARD_DESIGNATIONS } from "../../utils/executiveAccess";

import "./AdminHierarchyChart.css";

// Mirrors the server's own MAX_HIERARCHY_DEPTH=15 precedent
// (organizationController.js) -- used here only as a hard ceiling
// while walking a single node's ancestor chain (search auto-expand).
// The anti-infinite-loop guard for rendering itself is the per-path
// visited-set in buildRenderTree below, not this constant.
const MAX_DEPTH_GUARD = 30;

function buildPhotoUrl(photo) {

  if (!photo) {
    return null;
  }

  if (photo.startsWith("http")) {
    return photo;
  }

  return `${API_ORIGIN}${photo}`;

}

// ==========================================
// TREE BUILDING (data layer -- unchanged: roots =
// null or dangling reporting_manager_id, circular
// chains guarded via a per-path visited Set so
// rendering can never infinite-loop, unreachable
// cycle members surfaced separately rather than
// dropped).
// ==========================================

function useOrgTree(nodes) {

  return useMemo(() => {

    const byId = new Map();
    nodes.forEach((n) => byId.set(n.id, n));

    const childrenOf = new Map();
    const roots = [];
    const orphanIds = new Set();

    nodes.forEach((n) => {

      const parentId = n.reporting_manager_id;
      const parentExists = parentId != null && byId.has(parentId);

      if (!parentExists) {

        if (parentId != null) {
          orphanIds.add(n.id);
        }

        roots.push(n);

      } else {

        if (!childrenOf.has(parentId)) {
          childrenOf.set(parentId, []);
        }

        childrenOf.get(parentId).push(n);

      }

    });

    function buildRenderTree(node, visitedInPath) {

      if (visitedInPath.has(node.id)) {
        return null;
      }

      const nextVisited = new Set(visitedInPath);
      nextVisited.add(node.id);

      const kids = (childrenOf.get(node.id) || [])
        .map((child) => buildRenderTree(child, nextVisited))
        .filter(Boolean);

      return {
        ...node,
        children: kids,
        isOrphan: orphanIds.has(node.id),
      };
    }

    const renderRoots = roots.map((root) => buildRenderTree(root, new Set()));

    const reachedIds = new Set();

    function collectIds(node) {
      reachedIds.add(node.id);
      node.children.forEach(collectIds);
    }

    renderRoots.forEach(collectIds);

    const unreachableRoots = nodes
      .filter((n) => !reachedIds.has(n.id))
      .map((n) => ({ ...n, children: [], isCycleMember: true }));

    const mainRoots = renderRoots.filter((r) => !r.isOrphan);
    const flaggedRoots = [...renderRoots.filter((r) => r.isOrphan), ...unreachableRoots];

    return {
      roots: mainRoots,
      flaggedRoots,
      byId,
      totalCount: nodes.length,
    };

  }, [nodes]);

}

// ==========================================
// VISUAL TIER -- depth + the existing Founder/
// Chairman designation list (client/src/utils/
// executiveAccess.js), never role/system_access/
// is_system_administrator.
// ==========================================

function getTier(node, depth) {

  if (depth === 0 || EXECUTIVE_DASHBOARD_DESIGNATIONS.includes(node.designation)) {
    return "leadership";
  }

  if (depth <= 2) {
    return "manager";
  }

  return "employee";

}

// ==========================================
// EMPLOYEE CARD
// Fixed, viewport-responsive width (set in CSS,
// not JS) -- never absolutely positioned, so it can
// never be placed outside its container's bounds.
// ==========================================

function HierarchyCard({ node, depth, isCollapsed, onToggleCollapse, onSelect, isSearchMatch, cardRef }) {

  const tier = getTier(node, depth);
  const photoUrl = buildPhotoUrl(node.profile_photo);
  const initial = node.full_name?.charAt(0)?.toUpperCase() || "?";
  const childCount = node.children?.length || 0;

  return (
    <div
      ref={cardRef}
      className={`hchart-card tier-${tier}${isSearchMatch ? " search-match" : ""}${node.isOrphan ? " is-orphan" : ""}${node.isCycleMember ? " is-cycle" : ""}`}
      onClick={() => onSelect(node)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(node);
      }}
    >

      <div className="hchart-card-main">

        <div className="hchart-avatar">
          {photoUrl ? (
            <img
              src={photoUrl}
              alt={node.full_name}
              onError={(e) => {
                e.currentTarget.style.display = "none";
                e.currentTarget.nextSibling.style.display = "flex";
              }}
            />
          ) : null}
          <span className="hchart-avatar-fallback" style={{ display: photoUrl ? "none" : "flex" }}>
            {initial}
          </span>
        </div>

        <div className="hchart-card-text">
          <strong className="hchart-name">{node.full_name}</strong>
          <span className="hchart-designation">{node.designation || "No designation set"}</span>
        </div>

      </div>

      <div className="hchart-card-meta-row">
        <span className="hchart-meta">
          <FaIdBadge /> {node.employee_id}
        </span>
        {node.department_name && (
          <span className="hchart-meta">
            <FaBuilding /> {node.department_name}
          </span>
        )}
      </div>

      {(node.isOrphan || node.isCycleMember) && (
        <div className="hchart-warning" title={
          node.isCycleMember
            ? "This employee's reporting chain loops back on itself and could not be placed in the tree normally."
            : "This employee's reporting manager is no longer active -- shown as a root until reassigned."
        }>
          <FaExclamationTriangle />
          {node.isCycleMember ? "Circular reference" : "Manager inactive"}
        </div>
      )}

      {childCount > 0 && (
        <button
          type="button"
          className="hchart-toggle"
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapse(node.id);
          }}
          aria-expanded={!isCollapsed}
          title={isCollapsed ? "Expand reports" : "Collapse reports"}
        >
          {isCollapsed ? <FaChevronRight /> : <FaChevronDown />}
          <FaUsers /> {childCount}
        </button>
      )}

    </div>
  );

}

// ==========================================
// TREE BRANCH -- vertical-first, wrap-based layout.
// A manager's direct reports render in a flex-wrap
// grid BELOW them, bounded to the available width;
// when there are many reports they wrap onto extra
// rows instead of pushing the chart wider. Each
// child is its own recursive branch, so the whole
// tree only ever grows DOWN, never sideways beyond
// its container -- there is no absolute positioning
// and nothing can be placed outside the viewport.
// ==========================================

function HierarchyBranch({ node, depth, collapsed, onToggleCollapse, onSelect, searchMatchIds, nodeRefs }) {

  const isCollapsed = collapsed.has(node.id);
  const children = node.children || [];
  const showChildren = !isCollapsed && children.length > 0;

  return (
    <div className="hchart-node-block">

      <HierarchyCard
        node={node}
        depth={depth}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        onSelect={onSelect}
        isSearchMatch={searchMatchIds.has(node.id)}
        cardRef={(el) => { nodeRefs.current[node.id] = el; }}
      />

      {showChildren && (
        <div className="hchart-branch-group">
          <div className="hchart-branch-stem" />
          <div className={`hchart-children-grid depth-${Math.min(depth + 1, 4)}`}>
            {children.map((child) => (
              <HierarchyBranch
                key={child.id}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleCollapse={onToggleCollapse}
                onSelect={onSelect}
                searchMatchIds={searchMatchIds}
                nodeRefs={nodeRefs}
              />
            ))}
          </div>
        </div>
      )}

    </div>
  );

}

// ==========================================
// PAGE
// ==========================================

function AdminHierarchyChart() {

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [nodes, setNodes] = useState([]);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedNode, setSelectedNode] = useState(null);

  const nodeRefs = useRef({});

  const loadTree = async () => {

    try {
      setLoading(true);
      setLoadError(false);

      const data = await getOrgChartFullTree();

      setNodes(Array.isArray(data.nodes) ? data.nodes : []);

    } catch (error) {

      console.error("Org chart load error:", error);
      setLoadError(true);

      toast.error(
        error.response?.data?.message ||
        "Unable to load organization chart"
      );

    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTree();
  }, []);

  const { roots, flaggedRoots, byId, totalCount } = useOrgTree(nodes);

  // ==========================================
  // SEARCH
  // Auto-expands every ancestor of a match, then
  // scrolls the match into view with the page's own
  // native vertical scroll -- never horizontal, since
  // the chart can never be wider than its container.
  // ==========================================

  const searchMatchIds = useMemo(() => {

    const term = searchTerm.trim().toLowerCase();
    if (!term) return new Set();

    const matches = new Set();

    nodes.forEach((n) => {
      const haystack = `${n.full_name || ""} ${n.employee_id || ""} ${n.designation || ""}`.toLowerCase();
      if (haystack.includes(term)) {
        matches.add(n.id);
      }
    });

    return matches;

  }, [searchTerm, nodes]);

  useEffect(() => {

    if (searchMatchIds.size === 0) return;

    setCollapsed((prev) => {
      const next = new Set(prev);

      searchMatchIds.forEach((id) => {
        let current = byId.get(id);
        let steps = 0;
        while (current && current.reporting_manager_id != null && steps < MAX_DEPTH_GUARD) {
          next.delete(current.reporting_manager_id);
          current = byId.get(current.reporting_manager_id);
          steps++;
        }
      });

      return next;
    });

    const firstId = [...searchMatchIds][0];

    requestAnimationFrame(() => {
      nodeRefs.current[firstId]?.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchMatchIds]);

  const toggleCollapse = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ==========================================
  // RENDER
  // ==========================================

  return (
    <div className="employee-page-content hchart-page">

      <section className="hchart-page-header">

        <div className="hchart-header-title-row">
          <span className="hchart-header-icon"><FaSitemap /></span>
          <div>
            <h2>Organization Hierarchy</h2>
            <p>Live reporting structure, built from each employee's assigned manager.</p>
          </div>
        </div>

        <div className="hchart-search-box">
          <FaSearch />
          <input
            type="text"
            placeholder="Search by name, employee ID or designation..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm("")} aria-label="Clear search">
              <FaTimes />
            </button>
          )}
        </div>

      </section>

      {searchTerm && (
        <div className="hchart-search-status">
          {searchMatchIds.size === 0
            ? "No employees match your search."
            : `${searchMatchIds.size} match${searchMatchIds.size === 1 ? "" : "es"} found.`}
        </div>
      )}

      <div className="hchart-toolbar">
        <span className="hchart-total-count">{totalCount} active employee{totalCount === 1 ? "" : "s"}</span>
      </div>

      {loading ? (

        <div className="hchart-state-message">Loading organization chart...</div>

      ) : loadError ? (

        <div className="hchart-state-message hchart-error">
          <FaExclamationTriangle />
          <h3>Unable to load the organization chart</h3>
          <p>Something went wrong while loading the hierarchy.</p>
          <button type="button" className="hchart-retry-button" onClick={loadTree}>Retry</button>
        </div>

      ) : roots.length === 0 && flaggedRoots.length === 0 ? (

        <div className="hchart-state-message">
          <FaSitemap />
          <h3>No reporting structure configured yet</h3>
          <p>Assign a reporting manager to your employees in Employee Management to build the chart.</p>
        </div>

      ) : (

        <div className="hchart-viewport">

          {roots.length > 0 && (
            <div className="hchart-tree-canvas">
              {roots.map((root) => (
                <HierarchyBranch
                  key={root.id}
                  node={root}
                  depth={0}
                  collapsed={collapsed}
                  onToggleCollapse={toggleCollapse}
                  onSelect={setSelectedNode}
                  searchMatchIds={searchMatchIds}
                  nodeRefs={nodeRefs}
                />
              ))}
            </div>
          )}

          {flaggedRoots.length > 0 && (
            <div className="hchart-flagged-section">
              <div className="hchart-flagged-heading">
                <FaExclamationTriangle /> Needs attention -- not placeable under a manager
              </div>
              <div className="hchart-flagged-row">
                {flaggedRoots.map((node) => (
                  <HierarchyCard
                    key={node.id}
                    node={node}
                    depth={0}
                    isCollapsed={false}
                    onToggleCollapse={toggleCollapse}
                    onSelect={setSelectedNode}
                    isSearchMatch={searchMatchIds.has(node.id)}
                    cardRef={(el) => { nodeRefs.current[node.id] = el; }}
                  />
                ))}
              </div>
            </div>
          )}

        </div>

      )}

      {selectedNode && (

        <>
          <div className="hchart-detail-backdrop" onClick={() => setSelectedNode(null)} />

          <aside className="hchart-detail-panel">

            <button type="button" className="hchart-detail-close" onClick={() => setSelectedNode(null)} aria-label="Close">
              <FaTimes />
            </button>

            <div className="hchart-detail-banner">
              <div className="hchart-detail-avatar">
                {buildPhotoUrl(selectedNode.profile_photo) ? (
                  <img src={buildPhotoUrl(selectedNode.profile_photo)} alt={selectedNode.full_name} />
                ) : (
                  <span>{selectedNode.full_name?.charAt(0)?.toUpperCase() || "?"}</span>
                )}
              </div>
            </div>

            <div className="hchart-detail-body">

              <h3>{selectedNode.full_name}</h3>
              <p className="hchart-detail-designation">{selectedNode.designation || "No designation set"}</p>

              <div className="hchart-detail-row">
                <span>Employee ID</span>
                <strong>{selectedNode.employee_id}</strong>
              </div>

              {selectedNode.department_name && (
                <div className="hchart-detail-row">
                  <span>Department</span>
                  <strong>{selectedNode.department_name}</strong>
                </div>
              )}

              <div className="hchart-detail-row">
                <span>Direct Reports</span>
                <strong>{selectedNode.children?.length || 0}</strong>
              </div>

              {byId.get(selectedNode.reporting_manager_id) && (
                <div className="hchart-detail-row">
                  <span>Reports To</span>
                  <strong>{byId.get(selectedNode.reporting_manager_id).full_name}</strong>
                </div>
              )}

              {selectedNode.isOrphan && (
                <div className="hchart-detail-note">
                  Their assigned reporting manager is no longer active. Reassign a manager in Employee Management to move them back under a branch.
                </div>
              )}

            </div>

          </aside>
        </>

      )}

    </div>
  );

}

export default AdminHierarchyChart;
