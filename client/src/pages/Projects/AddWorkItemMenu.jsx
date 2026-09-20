import { useEffect, useLayoutEffect, useRef, useState } from "react";

import {
  FaPlus,
  FaChevronDown,
  FaLayerGroup,
  FaPuzzlePiece,
  FaClipboardList,
  FaCheckSquare,
} from "react-icons/fa";

import "./AddWorkItemMenu.css";

// ==========================================
// ADD WORK ITEM MENU
//
// Single entry point replacing the previous four separate "Add Epic"
// / "Add Feature" / "Add User Story" / "Add Task" toolbar buttons.
// Purely presentational -- every option calls straight through to the
// exact same handlers ProjectWorkspace.jsx already wires to those
// four buttons (onAddEpic/onAddFeature/onAddUserStory/onAddTask), so
// no creation logic, modal, or backend behavior changes here.
// ==========================================

const ITEMS = [
  {
    key: "epic",
    label: "Add Epic",
    description: "High-level container for features",
    Icon: FaLayerGroup,
  },
  {
    key: "feature",
    label: "Add Feature",
    description: "Group of user stories",
    Icon: FaPuzzlePiece,
  },
  {
    key: "userStory",
    label: "Add User Story",
    description: "End-user requirement",
    Icon: FaClipboardList,
  },
  {
    key: "task",
    label: "Add Task",
    description: "Specific actionable item",
    Icon: FaCheckSquare,
  },
];

function AddWorkItemMenu({
  onAddEpic,
  onAddFeature,
  onAddUserStory,
  onAddTask,
  canCreateEpic = true,
  canCreateFeature = true,
  canCreateUserStory = true,
  canCreateTask = true,
  label = "Add New Work Item",
  className = "",
}) {

  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const panelRef = useRef(null);

  const handlers = {
    epic: onAddEpic,
    feature: onAddFeature,
    userStory: onAddUserStory,
    task: onAddTask,
  };

  const allowed = {
    epic: canCreateEpic,
    feature: canCreateFeature,
    userStory: canCreateUserStory,
    task: canCreateTask,
  };

  const visibleItems = ITEMS.filter((item) => allowed[item.key] && handlers[item.key]);

  useEffect(() => {
    if (!open) return undefined;

    const handleClickOutside = (event) => {
      if (containerRef.current && !containerRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  // The panel defaults to right-aligned under the trigger (CSS
  // `right: 0`), which overflows the left edge of the viewport when
  // the trigger itself sits close to the left/center of a narrow
  // screen (confirmed at 390px width). Clamp back on-screen with an
  // 8px margin after paint, regardless of trigger position or
  // viewport size, rather than a fixed breakpoint guess.
  useLayoutEffect(() => {
    if (!open || !panelRef.current) return;

    const panel = panelRef.current;
    panel.style.left = "";
    panel.style.right = "0";

    const rect = panel.getBoundingClientRect();
    const margin = 8;

    if (rect.left < margin) {
      panel.style.right = "auto";
      panel.style.left = `${margin - (containerRef.current?.getBoundingClientRect().left || 0)}px`;
    } else if (rect.right > window.innerWidth - margin) {
      const overflow = rect.right - (window.innerWidth - margin);
      panel.style.right = `${-overflow}px`;
    }
  }, [open]);

  if (visibleItems.length === 0) {
    return null;
  }

  const select = (key) => {
    setOpen(false);
    handlers[key]();
  };

  return (
    <div className={`awi-menu ${className}`} ref={containerRef}>

      <button
        type="button"
        className="exec-new-project-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <FaPlus /> {label} <FaChevronDown className={`awi-menu-caret ${open ? "awi-menu-caret-open" : ""}`} />
      </button>

      {open && (
        <div className="awi-menu-panel" role="menu" ref={panelRef}>
          {visibleItems.map(({ key, label: itemLabel, description, Icon }) => (
            <button
              key={key}
              type="button"
              role="menuitem"
              className="awi-menu-item"
              onClick={() => select(key)}
            >
              <Icon className="awi-menu-item-icon" />
              <span className="awi-menu-item-text">
                <span className="awi-menu-item-label">{itemLabel}</span>
                <span className="awi-menu-item-description">{description}</span>
              </span>
            </button>
          ))}
        </div>
      )}

    </div>
  );

}

export default AddWorkItemMenu;
