import "./EmptyState.css";

// Shared EmptyState (Batch 1). `icon` accepts any node (e.g. a
// react-icons element), so it doesn't impose a new icon dependency.

function EmptyState({ icon, title, description, action, className = "" }) {

  return (

    <div className={["ui-empty-state", className].filter(Boolean).join(" ")}>

      {icon && <div className="ui-empty-state-icon">{icon}</div>}

      {title && <p className="ui-empty-state-title">{title}</p>}

      {description && <p className="ui-empty-state-description">{description}</p>}

      {action && <div className="ui-empty-state-action">{action}</div>}

    </div>

  );

}

export default EmptyState;
