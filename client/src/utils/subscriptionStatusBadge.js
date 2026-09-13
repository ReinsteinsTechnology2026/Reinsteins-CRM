// Phase 12P -- a small, PURELY DISPLAY computation layered on top of
// the real stored subscription_status. It never writes anything back
// and never influences access enforcement (that's
// platformCompanyService.isCompanyAccessAllowed, server-side) --
// "Expiring Soon"/"Grace Period" here are just a friendlier label for
// specific date ranges within the real, unchanged 'trial'/'active'
// statuses, mirroring the backend's own computed attentionRequired
// signals (getExpiringSoonCompanies/getGracePeriodCompanies).
//
// className reuses the existing .platform-badge.status-* palette
// (status-trial's amber/warning tone fits "needs attention soon"
// without needing new CSS).

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function computeSubscriptionBadge(subscription) {
  if (!subscription) return { label: "—", className: "status-inactive" };

  const now = new Date();
  const { subscriptionStatus, trialEndsAt, subscriptionExpiresAt, gracePeriodEndsAt } = subscription;

  if (subscriptionStatus === "trial") {
    if (trialEndsAt) {
      const daysLeft = Math.ceil((new Date(trialEndsAt) - now) / ONE_DAY_MS);
      if (daysLeft <= 0) return { label: "Trial Expired", className: "status-expired" };
      if (daysLeft <= 3) return { label: "Trial Ending Soon", className: "status-trial" };
    }
    return { label: "Trial", className: "status-trial" };
  }

  if (subscriptionStatus === "active") {
    if (subscriptionExpiresAt) {
      const expiresAt = new Date(subscriptionExpiresAt);
      if (expiresAt <= now) {
        if (gracePeriodEndsAt && new Date(gracePeriodEndsAt) >= now) {
          return { label: "Grace Period", className: "status-trial" };
        }
        return { label: "Expired", className: "status-expired" };
      }
      const daysLeft = Math.ceil((expiresAt - now) / ONE_DAY_MS);
      if (daysLeft <= 7) return { label: "Expiring Soon", className: "status-trial" };
    }
    return { label: "Active", className: "status-active" };
  }

  if (subscriptionStatus === "expired") return { label: "Expired", className: "status-expired" };
  if (subscriptionStatus === "cancelled") return { label: "Cancelled", className: "status-cancelled" };

  return { label: subscriptionStatus || "—", className: "status-inactive" };
}

export default computeSubscriptionBadge;
