import { PERMISSIONS } from "./access";

// Which rights a share or membership carries. "View details" is always part of it; copy and edit need reveal. `held` are the rights the
// person doing the sharing holds themselves (nobody can hand on more than they have; the server checks this too).
export function PermissionPicker({ value, onChange, held, idPrefix = "perm", manager = false }) {
  const toggle = (id, on) => {
    const next = { ...value, [id]: on };
    if (id === "reveal" && !on) Object.assign(next, { copy: false, edit: false });
    if ((id === "copy" || id === "edit") && on) next.reveal = true;
    if (id === "manager" && on) Object.assign(next, { reveal: true, copy: true, edit: true, share: true });
    onChange(next);
  };
  const locked = Boolean(value.manager);
  return (
    <fieldset className="zv-perms">
      <legend>Permissions</legend>
      <label className="zv-perm"><input type="checkbox" checked disabled readOnly /><span><strong>View details</strong><small>Name, address and username. Always included.</small></span></label>
      {PERMISSIONS.map((p) => {
        const allowed = held[p.id] !== false;
        return (
          <label className="zv-perm" key={p.id}>
            <input type="checkbox" data-testid={`${idPrefix}-${p.id}`} checked={Boolean(value[p.id])} disabled={!allowed || locked} onChange={(e) => toggle(p.id, e.target.checked)} />
            <span><strong>{p.label}</strong><small>{allowed ? p.help : "You do not hold this permission, so you cannot give it."}</small></span>
          </label>
        );
      })}
      {manager && (
        <label className="zv-perm">
          <input type="checkbox" data-testid={`${idPrefix}-manager`} checked={Boolean(value.manager)} onChange={(e) => toggle("manager", e.target.checked)} />
          <span><strong>Collection manager</strong><small>Everything above, plus adding and removing members and renaming or archiving the collection.</small></span>
        </label>
      )}
    </fieldset>
  );
}

export function ExpiryPicker({ value, onChange, idPrefix = "expiry" }) {
  return (
    <div className="zv-expiry">
      <label className="zv-field">Access ends
        <select data-testid={`${idPrefix}-choice`} value={value.choice} onChange={(e) => onChange({ ...value, choice: e.target.value })}>
          <option value="none">Never (until I remove it)</option>
          <option value="1">In 1 day</option>
          <option value="7">In 7 days</option>
          <option value="30">In 30 days</option>
          <option value="90">In 90 days</option>
          <option value="custom">On a date…</option>
        </select>
      </label>
      {value.choice === "custom" && (
        <label className="zv-field">Date
          <input type="date" data-testid={`${idPrefix}-date`} value={value.custom || ""} min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)} onChange={(e) => onChange({ ...value, custom: e.target.value })} />
        </label>
      )}
    </div>
  );
}

export function RightsChips({ rights }) {
  const chips = ["View"];
  if (rights.reveal) chips.push("Reveal");
  if (rights.copy) chips.push("Copy");
  if (rights.edit) chips.push("Edit");
  if (rights.manage || rights.manager) chips.push("Manager");
  else if (rights.share) chips.push("Manage access");
  return <span className="zv-chips">{chips.map((c) => <span className="zv-chip" key={c}>{c}</span>)}</span>;
}
