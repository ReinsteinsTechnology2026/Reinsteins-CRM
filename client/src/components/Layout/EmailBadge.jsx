import "./EmailBadge.css";

// The unread-mail count (and a red dot-count when an account needs to be reconnected) beside the Email menu entry.
function EmailBadge({ unread = 0, attention = 0 }) {
  if (unread <= 0 && attention <= 0) return null;
  const showAttention = unread <= 0 && attention > 0;
  const text = showAttention ? "!" : unread > 99 ? "99+" : String(unread);
  const label = showAttention ? `${attention} email account${attention === 1 ? "" : "s"} need to be reconnected` : `${unread} unread email${unread === 1 ? "" : "s"}`;
  return (
    <span className={`zv-email-badge ${showAttention ? "zv-email-badge-attention" : ""}`} role="status" aria-label={label} title={label}>
      {text}
    </span>
  );
}

export default EmailBadge;
