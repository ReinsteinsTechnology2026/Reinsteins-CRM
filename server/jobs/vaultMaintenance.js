const { createVaultService } = require("../services/vaultService");

// ==========================================
// ZIOVAULT -- scheduled maintenance for ONE tenant
//
// Runs inside the existing hourly per-tenant notification sweep (jobs/notificationSweep.js), inside that tenant's own database context.
// No new scheduler, no external service. Two jobs:
//   1. remove expired shares and memberships (and their key envelopes). Every request already re-checks the clock, so this is tidiness
//      and audit, never correctness;
//   2. remind the people responsible that a credential is due for rotation (an item's owner, or the managers of its collection).
//
// The reminder never sees, and never contains, a title, a name or a secret: those are encrypted and the server cannot read them. It says
// that "a credential" is due and where to look.
// ==========================================

const REPEAT_DAYS = Math.max(1, Number(process.env.VAULT_ROTATION_REMINDER_DAYS) || 7);

async function runForTenant({ io, db, companyId, createNotification = require("../services/notificationService").createNotification, featureService = require("../services/companyFeatureService") }) {
    // a database that predates the module, or a company that does not have it, is left alone
    const [exists] = await db.query("SELECT to_regclass('zv_items') AS t");
    if (!exists || !exists[0] || !exists[0].t) return { skipped: "no vault tables" };
    if (companyId !== undefined && companyId !== null && !(await featureService.isFeatureEnabled(companyId, "ziovault"))) return { skipped: "feature disabled" };

    const service = createVaultService({ pool: db });
    const swept = await service.sweepExpired();
    const reminders = await service.processRotationReminders({ repeatDays: REPEAT_DAYS });
    let notified = 0;
    for (const reminder of reminders) {
        for (const userId of reminder.userIds) {
            // eslint-disable-next-line no-await-in-loop
            await createNotification({
                io,
                userId,
                title: "Password rotation due",
                message: "A ZioVault credential you are responsible for is due for rotation. Open ZioVault, then Rotation status.",
                type: "vault_rotation",
                referenceType: "ziovault",
                referenceId: null,
            });
            notified += 1;
        }
    }
    return { grantsRevoked: swept.grantsRevoked, membersRemoved: swept.membersRemoved, due: reminders.length, notified };
}

module.exports = { runForTenant, REPEAT_DAYS };
