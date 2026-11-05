const { createVaultService } = require("../services/vaultService");
const { VaultError } = require("../utils/vaultErrors");

// ==========================================
// ZIOVAULT controller -- thin: the authenticated user id goes to the service, the service answers with ciphertext/envelopes and
// metadata. Nothing here reads a tenant id from the request (the tenant is the database the context resolves to), nothing logs a
// request body, and every response is `no-store`.
// ==========================================

function createVaultController(service = createVaultService({ pool: require("../config/db") })) {
    const send = (res, data, status = 200) => res.status(status).set("Cache-Control", "no-store").json({ success: true, ...data });

    const handle = (work, status = 200) => async (req, res) => {
        try {
            const result = await work(req, res);
            if (result !== undefined) send(res, { data: result }, status);
        } catch (error) {
            if (error instanceof VaultError) {
                return res.status(error.status).set("Cache-Control", "no-store").json({ success: false, code: error.code, message: error.message });
            }
            // Never print the request (it carries ciphertext and key envelopes); the error object of a database failure can carry values.
            console.error("[ziovault] request failed:", error && error.code ? `code=${error.code}` : error && error.name);
            return res.status(500).set("Cache-Control", "no-store").json({ success: false, code: "SERVER_ERROR", message: "Something went wrong." });
        }
    };

    const uid = (req) => req.user.id;
    const body = (req) => (req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {});

    return {
        service,
        accountStatus: handle((req) => service.accountStatus(uid(req))),
        registerAccount: handle((req) => service.registerAccount(uid(req), body(req)), 201),
        unlockMaterial: handle((req) => service.unlockMaterial(uid(req))),
        recoveryMaterial: handle((req) => service.recoveryMaterial(uid(req))),
        confirmRecovery: handle((req) => service.confirmRecovery(uid(req))),
        replaceEnvelope: handle((req) => service.replaceEnvelope(uid(req), body(req))),
        replaceRecoveryEnvelope: handle((req) => service.replaceRecoveryEnvelope(uid(req), body(req))),
        envelopeHistory: handle((req) => service.envelopeHistory(uid(req))),
        restoreEnvelope: handle((req) => service.restoreEnvelope(uid(req), req.params.id, body(req))),
        directory: handle((req) => service.directory(uid(req))),

        listItems: handle((req) => service.listItems(uid(req))),
        listTrash: handle((req) => service.listTrash(uid(req))),
        createItem: handle((req) => service.createPersonalItem(uid(req), body(req)), 201),
        getItem: handle((req) => service.getItem(uid(req), req.params.uid)),
        getSecret: handle((req) => service.getSecret(uid(req), req.params.uid)),
        reportAccess: handle((req) => service.reportAccess(uid(req), req.params.uid, body(req).kind)),
        updateItem: handle((req) => service.updateItem(uid(req), req.params.uid, body(req))),
        deleteItem: handle((req) => service.deleteItem(uid(req), req.params.uid)),
        restoreItem: handle((req) => service.restoreItem(uid(req), req.params.uid)),
        rotateItem: handle((req) => service.rotateItem(uid(req), req.params.uid, body(req))),

        listGrants: handle((req) => service.listGrants(uid(req), req.params.uid)),
        createGrant: handle((req) => service.createGrant(uid(req), req.params.uid, body(req)), 201),
        updateGrant: handle((req) => service.updateGrant(uid(req), req.params.uid, req.params.userId, body(req))),
        revokeGrant: handle((req) => service.revokeGrant(uid(req), req.params.uid, req.params.userId)),

        listCollections: handle((req) => service.listCollections(uid(req))),
        createCollection: handle((req) => service.createCollection(uid(req), body(req)), 201),
        getCollection: handle((req) => service.getCollection(uid(req), req.params.uid)),
        createCompanyItem: handle((req) => service.createCompanyItem(uid(req), req.params.uid, body(req)), 201),
        addMember: handle((req) => service.addMember(uid(req), req.params.uid, body(req)), 201),
        updateMember: handle((req) => service.updateMember(uid(req), req.params.uid, req.params.userId, body(req))),
        removeMember: handle((req) => service.removeMember(uid(req), req.params.uid, req.params.userId)),
        rotateCollection: handle((req) => service.rotateCollection(uid(req), req.params.uid, body(req))),

        audit: handle((req) => service.auditTrail(uid(req), { itemUid: req.query.itemUid, collectionUid: req.query.collectionUid })),
    };
}

let defaultController = null;
const getDefaultController = () => (defaultController = defaultController || createVaultController());

module.exports = { createVaultController, getDefaultController };
