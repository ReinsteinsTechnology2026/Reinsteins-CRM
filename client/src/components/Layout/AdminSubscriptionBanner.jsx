import { useEffect, useState } from "react";

import api from "../../services/api";

// ==========================================
// ADMIN SUBSCRIPTION BANNER (Phase 12R)
//
// GET /api/tenant-auth/subscription-status is Admin-only server-side
// (see tenantAuthRoutes.js) -- for any other role it 403s, so this
// component fails silently (no banner, no error toast) rather than
// showing anything to an ordinary employee. It also fails silently on
// any other error (e.g. a legacy Reinsteins login token, which uses a
// different JWT secret than the company-aware tenant login this
// endpoint requires) -- this is a small, non-critical UI convenience,
// never worth surfacing an error for.
// ==========================================

const TONE_BY_STATUS = {
    trial_ending_soon: "warning",
    trial_expired: "danger",
    grace_period: "warning",
    expiring_soon: "warning",
    expired: "danger",
    cancelled: "danger",
};

function AdminSubscriptionBanner() {
    const [banner, setBanner] = useState(null);

    useEffect(() => {
        let cancelled = false;
        api.get("/tenant-auth/subscription-status")
            .then((response) => {
                if (cancelled) return;
                const { status, message } = response.data;
                if (message) setBanner({ status, message });
            })
            .catch(() => { /* silent -- see module header */ });
        return () => { cancelled = true; };
    }, []);

    if (!banner) return null;

    const tone = TONE_BY_STATUS[banner.status] || "warning";

    return (
        <div className={`admin-subscription-banner tone-${tone}`}>
            {banner.message}
        </div>
    );
}

export default AdminSubscriptionBanner;
