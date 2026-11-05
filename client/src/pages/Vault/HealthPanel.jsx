// Password health: computed in this tab from the decrypted vault. Nothing is sent anywhere; the report holds titles and counts, never a password.
export default function HealthPanel({ session, state, onOpen }) {
  const health = state.health;
  const report = health && health.report;

  return (
    <section className="zv-panel" data-testid="vault-health">
      <h2>Password health</h2>
      <p className="zv-lead">Checks every login in this vault for weak, reused and old passwords. It runs on this device only. To check, ZioVault opens each password, and each one is recorded in your vault's activity log as an access by you.</p>
      <button type="button" className="zv-btn zv-btn-primary" data-testid="vault-health-run" onClick={() => session.runHealth()} disabled={Boolean(health && health.running)}>
        {health && health.running ? `Checking… ${health.progress.done}/${health.progress.total}` : report ? "Check again" : "Check my passwords"}
      </button>

      {report && (
        <div data-testid="vault-health-summary">
          <div className="zv-stats">
            <div className="zv-stat"><strong>{report.summary.total}</strong><span>checked</span></div>
            <div className="zv-stat bad"><strong>{report.summary.weak}</strong><span>weak</span></div>
            <div className="zv-stat bad"><strong>{report.summary.reused}</strong><span>reused</span></div>
            <div className="zv-stat warn"><strong>{report.summary.old}</strong><span>old</span></div>
            <div className="zv-stat good"><strong>{report.summary.healthyPercent}%</strong><span>healthy</span></div>
          </div>
          <h3>Recommendations</h3>
          <ul className="zv-reco">{report.recommendations.map((text) => <li key={text}>{text}</li>)}</ul>

          {report.findings.weak.length > 0 && (
            <>
              <h3>Weak passwords</h3>
              <ul className="zv-findings">{report.findings.weak.map((f) => <li key={f.uid}><button type="button" className="zv-link" onClick={() => onOpen(f.uid)}>{f.title}</button><span>{f.label}, about {Math.round(f.bits)} bits</span></li>)}</ul>
            </>
          )}
          {report.findings.reused.length > 0 && (
            <>
              <h3>Reused passwords</h3>
              {report.findings.reused.map((group, index) => (
                <ul className="zv-findings" key={index}>{group.items.map((f) => <li key={f.uid}><button type="button" className="zv-link" onClick={() => onOpen(f.uid)}>{f.title}</button><span>shares a password with {group.items.length - 1} other</span></li>)}</ul>
              ))}
            </>
          )}
          {report.findings.old.length > 0 && (
            <>
              <h3>Not changed for {report.oldDays}+ days</h3>
              <ul className="zv-findings">{report.findings.old.map((f) => <li key={f.uid}><button type="button" className="zv-link" onClick={() => onOpen(f.uid)}>{f.title}</button><span>{f.ageDays} days</span></li>)}</ul>
            </>
          )}
          {report.findings.missing.length > 0 && (
            <>
              <h3>No password stored</h3>
              <ul className="zv-findings">{report.findings.missing.map((f) => <li key={f.uid}><button type="button" className="zv-link" onClick={() => onOpen(f.uid)}>{f.title}</button></li>)}</ul>
            </>
          )}
          <p className="zv-hint">Not checked: whether a password appeared in a public breach. That needs an online service, and ZioVault never sends your passwords to one.</p>
        </div>
      )}
    </section>
  );
}
