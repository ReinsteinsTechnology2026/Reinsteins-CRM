const express = require("express");

const { getDefaultController } = require("../controllers/vaultController");
const { createVaultLimiters } = require("../middleware/vaultRateLimiters");
const { ATTACHMENT_JSON_LIMIT, ROTATION_JSON_LIMIT } = require("../utils/vaultUpload");

// ==========================================
// ZIOVAULT ROUTES   (mounted at /api/ziovault, behind the tenant feature gate for "ziovault")
//
// `authenticate` is [protect, requireActiveUser] in production: the existing legacy/tenant JWT chain, which resolves the tenant database
// from the SIGNED token. Every handler then re-checks the user (active), their vault account and their right to the specific item or
// collection (services/vaultAuthz.js). Dependencies are injectable so the behaviour can be tested with any authentication.
// ==========================================

function createVaultRouter({ controller = getDefaultController(), authenticate, limiters = createVaultLimiters() } = {}) {
    const router = express.Router();
    router.use(...authenticate);

    // account / keys
    router.get("/account/status", controller.accountStatus);
    router.post("/account", limiters.recovery, controller.registerAccount);
    router.get("/account/unlock", limiters.unlock, controller.unlockMaterial);
    router.get("/account/recovery", limiters.recovery, controller.recoveryMaterial);
    router.post("/account/recovery-confirmation", limiters.write, controller.confirmRecovery);
    router.put("/account/envelope", limiters.recovery, controller.replaceEnvelope);
    router.put("/account/recovery-envelope", limiters.recovery, controller.replaceRecoveryEnvelope);
    router.get("/account/envelope-history", limiters.recovery, controller.envelopeHistory);
    router.post("/account/envelope-history/:id/restore", limiters.recovery, controller.restoreEnvelope);
    router.get("/directory", limiters.write, controller.directory);

    // folders (personal)
    router.get("/folders", controller.listFolders);
    router.post("/folders", limiters.write, controller.createFolder);
    router.patch("/folders/:uid", limiters.write, controller.renameFolder);
    router.delete("/folders/:uid", limiters.write, controller.deleteFolder);

    // items (personal; items in collections are created under /collections/:uid/items)
    router.get("/items", controller.listItems);
    router.get("/items/trash", controller.listTrash);
    router.post("/items", limiters.write, controller.createItem);
    router.get("/items/:uid", controller.getItem);
    router.post("/items/:uid/secret", limiters.secret, controller.getSecret);
    router.post("/items/:uid/access-reports", limiters.secret, controller.reportAccess);
    router.patch("/items/:uid", limiters.write, controller.updateItem);
    router.delete("/items/:uid", limiters.write, controller.deleteItem);
    router.post("/items/:uid/restore", limiters.write, controller.restoreItem);
    router.post("/items/:uid/rotate", limiters.share, controller.rotateItem);

    // sharing one item
    router.get("/items/:uid/grants", controller.listGrants);
    router.post("/items/:uid/grants", limiters.share, controller.createGrant);
    router.patch("/items/:uid/grants/:userId", limiters.share, controller.updateGrant);
    router.delete("/items/:uid/grants/:userId", limiters.share, controller.revokeGrant);

    // company collections
    router.get("/collections", controller.listCollections);
    router.post("/collections", limiters.share, controller.createCollection);
    router.get("/collections/:uid", controller.getCollection);
    router.patch("/collections/:uid", limiters.share, controller.renameCollection);
    router.post("/collections/:uid/archive", limiters.share, controller.archiveCollection);
    router.get("/shares/outgoing", controller.outgoingShares);
    router.post("/collections/:uid/items", limiters.write, controller.createCompanyItem);
    router.post("/collections/:uid/members", limiters.share, controller.addMember);
    router.patch("/collections/:uid/members/:userId", limiters.share, controller.updateMember);
    router.delete("/collections/:uid/members/:userId", limiters.share, controller.removeMember);
    router.post("/collections/:uid/rotate", limiters.share, express.json({ limit: ROTATION_JSON_LIMIT }), controller.rotateCollection);

    router.get("/audit", controller.audit);
    router.get("/audit/company", limiters.write, controller.companyAudit);

    // attachments (encrypted files)
    router.get("/attachments", limiters.write, controller.listAllAttachments);
    router.get("/items/:uid/attachments", limiters.write, controller.listItemAttachments);
    router.post("/items/:uid/attachments", limiters.upload, express.json({ limit: ATTACHMENT_JSON_LIMIT }), controller.addAttachment);
    router.post("/items/:uid/attachments/:attachmentUid/content", limiters.secret, controller.downloadAttachment);
    router.delete("/items/:uid/attachments/:attachmentUid", limiters.write, controller.deleteAttachment);

    // rotation: "I changed this password"
    router.post("/items/:uid/rotation-complete", limiters.write, controller.completeRotation);

    // offboarding: end a person's company vault access (administrators)
    router.get("/offboarding/people", limiters.write, controller.offboardingPeople);
    router.post("/offboarding/:userId/revoke-access", limiters.share, controller.revokeCompanyAccess);

    return router;
}

function createDefaultVaultRouter() {
    const { protect } = require("../middleware/authMiddleware");
    const { requireActiveUser } = require("../middleware/accessMiddleware");
    return createVaultRouter({ authenticate: [protect, requireActiveUser] });
}

module.exports = { createVaultRouter, createDefaultVaultRouter };
