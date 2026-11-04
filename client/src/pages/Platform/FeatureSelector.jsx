import { useState } from "react";

import { deselectAll, selectAll, toggleFeature } from "../../utils/featureSelection";

import "./FeatureSelector.css";

// ==========================================
// FEATURE SELECTOR (Owner Portal)
//
// The "Feature Configuration" checklist used when creating a company and when managing an existing one. Controlled:
// `value` is the list of enabled feature ids, `onChange` receives the new list.
//
// Dependencies are never resolved silently (see utils/featureSelection.js): choosing a module that needs another one, or
// turning off one that others need, shows what is affected and asks the Owner to confirm with one explicit button.
// ==========================================

function FeatureSelector({ catalog, value, onChange, disabled = false }) {
  const [notice, setNotice] = useState(null);
  const nameById = Object.fromEntries(catalog.map((feature) => [feature.id, feature.name]));

  const apply = (result) => {
    setNotice(result.notice);
    if (!result.notice) onChange(result.selected);
  };

  return (
    <div className="feature-selector" data-testid="feature-selector">

      <div className="feature-selector-toolbar">
        <span className="feature-selector-count" data-testid="feature-selected-count">
          {value.length} of {catalog.length} features selected
        </span>
        <div className="feature-selector-toolbar-actions">
          <button
            type="button"
            className="platform-btn platform-btn-outline platform-btn-sm"
            disabled={disabled || value.length === catalog.length}
            onClick={() => { setNotice(null); onChange(selectAll(catalog)); }}
          >
            Select All
          </button>
          <button
            type="button"
            className="platform-btn platform-btn-outline platform-btn-sm"
            disabled={disabled || value.length === 0}
            onClick={() => { setNotice(null); onChange(deselectAll()); }}
          >
            Deselect All
          </button>
        </div>
      </div>

      {notice && (
        <div className="platform-alert platform-alert-danger feature-selector-notice" role="alert" data-testid="feature-notice">
          <span>{notice.message}</span>
          <span className="feature-selector-notice-actions">
            <button
              type="button"
              className="platform-btn platform-btn-primary platform-btn-sm"
              onClick={() => { onChange(notice.action.selected); setNotice(null); }}
            >
              {notice.action.label}
            </button>
            <button type="button" className="platform-btn platform-btn-outline platform-btn-sm" onClick={() => setNotice(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}

      <div className="feature-selector-grid">
        {catalog.map((feature) => {
          const enabled = value.includes(feature.id);
          return (
            <label
              key={feature.id}
              className={`feature-card ${enabled ? "is-enabled" : "is-disabled"}`}
              data-testid={`feature-card-${feature.id}`}
            >
              <input
                type="checkbox"
                checked={enabled}
                disabled={disabled}
                onChange={() => apply(toggleFeature(catalog, value, feature.id))}
                aria-label={feature.name}
              />
              <span className="feature-card-body">
                <span className="feature-card-title">
                  {feature.name}
                  <span className={`feature-card-state ${enabled ? "on" : "off"}`}>{enabled ? "Enabled" : "Disabled"}</span>
                </span>
                <span className="feature-card-description">{feature.description}</span>
                {feature.requires.length > 0 && (
                  <span className="feature-card-requires">Requires {feature.requires.map((id) => nameById[id] || id).join(", ")}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>

    </div>
  );
}

export default FeatureSelector;
