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
  FaSearchPlus,
  FaSearchMinus,
  FaCompress,
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
// while walking a single node's ancestor chain to pick a visual
// tier; the actual anti-infinite-loop guard for rendering is the
// per-path visited-set in buildRenderTree below, not this constant.
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
// TREE BUILDING
// Pure function of the flat node list -- rebuilt
// (useMemo) whenever the data reloads, never
// mutated in place.
//
// Roots = reporting_manager_id is null, OR points
// at a manager id that isn't in the active set
// (resigned/terminated/missing manager -- handled
// safely by treating them as a root rather than
// dropping them or crashing).
//
// Circular relationships: guarded at RENDER-TREE
// construction time via a per-path visited Set
// (buildRenderTree), which makes infinite recursion
// structurally impossible regardless of how a cycle
// is shaped. Any node never reached from a real root
// this way (i.e. exists only inside a pure cycle with
// no external root pointing into it) is surfaced
// afterward as its own flagged "Unreachable" root, so
// nothing from the underlying data is ever silently
// dropped.
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
          // Reporting manager was set, but isn't in the active set
          // (resigned/terminated/deleted) -- keep the employee
          // visible as a root instead of hiding them.
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
        // Would re-enter a node already on this exact path --
        // circular reporting chain. Stop descending here instead
        // of recursing forever; the card itself gets flagged.
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

    // Anything never reached above exists only inside a pure cycle
    // (every member has a valid parent pointer, so none of them
    // qualified as a root) -- surface those too, flagged, rather
    // than silently losing them from the chart.
    const reachedIds = new Set();

    function collectIds(node) {
      reachedIds.add(node.id);
      node.children.forEach(collectIds);
    }

    renderRoots.forEach(collectIds);

    const unreachableRoots = nodes
      .filter((n) => !reachedIds.has(n.id))
      .map((n) => ({ ...n, children: [], isCycleMember: true }));

    // Kept visually separate from the main tree (own section below)
    // rather than mixed into the same centered row -- otherwise an
    // orphan/cycle card sitting beside a large legitimate branch
    // throws off that branch's own centering, and "needs attention"
    // items read more clearly grouped together anyway.
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
// VISUAL TIER
// Derived from tree depth + the same Founder/
// Chairman designation list already used elsewhere
// in the app (client/src/utils/executiveAccess.js)
// -- never from role/system_access/
// is_system_administrator. A depth-0 root or a
// Founder/Chairman anywhere gets the premium
// leadership treatment; depth 1-2 reads as
// department-head/manager level; deeper levels are
// compact individual-contributor cards.
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
          <span className="hchart-meta">
            <FaIdBadge /> {node.employee_id}
          </span>
          {node.department_name && (
            <span className="hchart-meta">
              <FaBuilding /> {node.department_name}
            </span>
          )}
        </div>

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
// RECURSIVE BRANCH
// ==========================================

function HierarchyBranch({ node, depth, collapsed, onToggleCollapse, onSelect, searchMatchIds, nodeRefs }) {

  const isCollapsed = collapsed.has(node.id);
  const hasChildren = node.children && node.children.length > 0;

  const setRef = (el) => {
    nodeRefs.current[node.id] = el;
  };

  return (
    <li className="hchart-node">

      <HierarchyCard
        node={node}
        depth={depth}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
        onSelect={onSelect}
        isSearchMatch={searchMatchIds.has(node.id)}
        cardRef={setRef}
      />

      {hasChildren && !isCollapsed && (
        <ul className="hchart-children">
          {node.children.map((child) => (
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
        </ul>
      )}

    </li>
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

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragState = useRef(null);
  const viewportRef = useRef(null);
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

  // Center the first real root in the viewport once the tree first
  // renders, instead of leaving the user at whatever the browser's
  // default (top-left) scroll position happens to be for a canvas
  // wider than the viewport.
  useEffect(() => {

    if (loading || roots.length === 0) return;

    requestAnimationFrame(() => {
      const el = nodeRefs.current[roots[0].id];
      if (el) {
        el.scrollIntoView({ behavior: "auto", block: "start", inline: "center" });
      }
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, roots.length]);

  // ==========================================
  // SEARCH
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

  // Auto-expand every ancestor of a match so it's actually visible,
  // and scroll/center the first match into view.
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
      const el = nodeRefs.current[firstId];
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }
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
  // PAN + ZOOM
  // Plain CSS transform + pointer-drag -- no new
  // dependency (see implementation report: nothing
  // tree/chart-related was already installed, and a
  // scrollable+scalable container covers panning,
  // zooming and fit-to-screen without one).
  // ==========================================

  const handleResetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const handleZoom = (delta) => {
    setZoom((z) => Math.min(1.4, Math.max(0.4, Math.round((z + delta) * 100) / 100)));
  };

  const handlePointerDown = (e) => {
    if (e.target.closest(".hchart-card")) return;
    dragState.current = { startX: e.clientX, startY: e.clientY, originX: pan.x, originY: pan.y };
  };

  const handlePointerMove = (e) => {
    if (!dragState.current) return;
    const dx = e.clientX - dragState.current.startX;
    const dy = e.clientY - dragState.current.startY;
    setPan({ x: dragState.current.originX + dx, y: dragState.current.originY + dy });
  };

  const handlePointerUp = () => {
    dragState.current = null;
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
        <div className="hchart-toolbar-actions">
          <button type="button" onClick={() => handleZoom(-0.1)} title="Zoom out"><FaSearchMinus /></button>
          <span className="hchart-zoom-level">{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => handleZoom(0.1)} title="Zoom in"><FaSearchPlus /></button>
          <button type="button" onClick={handleResetView} title="Fit to screen / reset view"><FaCompress /> Reset View</button>
        </div>
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

        <div
          className="hchart-viewport"
          ref={viewportRef}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerUp}
        >
          <div
            className="hchart-canvas"
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
          >
            {roots.length > 0 && (
              <ul className="hchart-tree hchart-roots">
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
              </ul>
            )}

            {flaggedRoots.length > 0 && (
              <div className="hchart-flagged-section">
                <div className="hchart-flagged-heading">
                  <FaExclamationTriangle /> Needs attention -- not placeable under a manager
                </div>
                <ul className="hchart-tree hchart-flagged-roots">
                  {flaggedRoots.map((root) => (
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
                </ul>
              </div>
            )}
          </div>
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
