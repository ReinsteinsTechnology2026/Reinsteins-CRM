import { useState } from "react";
import { FaSyncAlt } from "react-icons/fa";

import { describeRotation, rotationStatus, STATUS_LABELS } from "../../vault/rotation";
import { formatDate } from "./access";

const INTERVALS = [
  { value: "", label: "No schedule" }, { value: "30", label: "Every 30 days" }, { value: "60", label: "Every 60 days" }, { value: "90", label: "Every 90 days" },
  { value: "180", label: "Every 180 days" }, { value: "365", label: "Every year" },
];

export function RotationBadge({ item, warnDays }) {
  const result = rotationStatus(item, { warnDays });
  if (result.status === "none") return null;
  return <span className={`zv-rot zv-rot-${result.status}`} data-testid="vault-rotation-badge" data-status={result.status}>{STATUS_LABELS[result.status]}</span>;
}

// When this password should be changed, and the buttons to schedule it (owner or manager) and to record that it was changed (anyone who may edit).
// Recording a rotation does not read or change the password: it records that a person changed it elsewhere, and clears the reminder.
export default function RotationPanel({ session, item, prefs, onChanged }) {
  const rights = item.rights || { edit: true, manage: true };
  const owned = item.via === "owner" || item.via === undefined;
  const canSchedule = owned || Boolean(rights.manage);
  const canComplete = owned || Boolean(rights.manage) || Boolean(rights.edit);
  const status = rotationStatus(item, { warnDays: prefs.rotationWarnDays });
  const [interval, setInterval] = useState(item.rotationIntervalDays ? String(item.rotationIntervalDays) : "");
  const [dueDate, setDueDate] = useState(item.rotationDueAt ? item.rotationDueAt.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const run = async (work, done) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(done);
      if (onChanged) onChanged();
    } catch (e) {
      setError(session.describe(e));
    } finally {
      setBusy(false);
    }
  };

  const save = (event) => {
    event.preventDefault();
    return run(() => session.setRotationSchedule(item.uid, { intervalDays: interval ? Number(interval) : null, dueAt: dueDate ? new Date(`${dueDate}T09:00:00`).toISOString() : null }), "Schedule saved.");
  };

  return (
    <section className="zv-rotation" data-testid="vault-rotation" aria-label="Password rotation">
      <h3><FaSyncAlt aria-hidden="true" /> Rotation</h3>
      <p data-testid="vault-rotation-status" data-status={status.status}>
        <span className={`zv-rot zv-rot-${status.status}`}>{STATUS_LABELS[status.status]}</span> {describeRotation(status)}
        {status.dueAt && <small> · due {formatDate(status.dueAt)}</small>}
      </p>
      <p className="zv-hint">Password last changed {formatDate(item.lastRotatedAt)}.</p>
      {error && <p className="zv-error" role="alert" data-testid="vault-rotation-error">{error}</p>}
      {notice && <p className="zv-notice" role="status" data-testid="vault-rotation-notice">{notice}</p>}
      {canComplete && (
        <div className="zv-row">
          <button type="button" className="zv-btn" data-testid="vault-rotation-complete" disabled={busy} onClick={() => run(() => session.completeRotation(item.uid), "Recorded: the password was changed. The reminder is cleared.")}>I changed this password</button>
        </div>
      )}
      {canSchedule && (
        <form className="zv-form" onSubmit={save}>
          <label className="zv-field">Change it
            <select data-testid="vault-rotation-interval" value={interval} onChange={(e) => setInterval(e.target.value)}>
              {INTERVALS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="zv-field">Or on a specific date (optional, overrides the interval)
            <input type="date" data-testid="vault-rotation-due" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
          <div className="zv-row"><button type="submit" className="zv-btn" data-testid="vault-rotation-save" disabled={busy}>Save schedule</button></div>
        </form>
      )}
      <p className="zv-hint">Reminders go to the item's owner or to the managers of its collection. They say that a credential is due, never which one or what it contains.</p>
    </section>
  );
}
