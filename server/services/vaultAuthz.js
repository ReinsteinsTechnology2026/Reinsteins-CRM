const { VaultError, forbidden, notFound } = require("../utils/vaultErrors");

// ==========================================
// ZIOVAULT -- the ONE place that decides what a user may do
//
// Inputs are rows the store produced from the AUTHENTICATED user id and the DATABASE clock; nothing the browser sends is a
// permission. Every function here fails closed (throws) -- there is no "allowed unless". An item the caller has no path to is
// reported as 404, exactly like one that does not exist.
//
// Paths to an item (rights are the union of the paths that exist and are not expired/revoked):
//   owner       personal item owned by the caller                      -> everything
//   collection  caller is an unexpired member of the item's collection -> that membership's rights (manager = all)
//   grant       caller has an active, unexpired grant on the item      -> that grant's rights
// "view" (the item's details) is implied by every path; "reveal" (the secret) is a separate right with a separate key.
// ==========================================

// WHO ADMINISTERS THE COMPANY VAULT -- the one rule, read from the user's FRESH database row (never from anything the browser claims):
//     role = 'admin'   OR   system_access = 'super_admin'
// A plain system_access of 'admin' (or hr, executive, ...) does NOT qualify unless the role is also 'admin'. This is a permission to START
// things and to end people's company access; it is not access to anything: a collection's creator becomes its first manager and first key
// holder (the keys are made in their browser), everyone else needs an explicit membership, and nobody -- Super Admin included -- can read
// another person's personal vault or a collection they are not a member of.
const canAdministerCompanyVault = (user) => Boolean(user) && (user.role === "admin" || user.system_access === "super_admin");
const canCreateCollections = canAdministerCompanyVault;

function resolveItemRights(row) {
    const paths = {
        owner: Boolean(row.is_owner),
        collection: row.m_user !== null && row.m_user !== undefined,
        grant: row.g_id !== null && row.g_id !== undefined,
    };
    if (!paths.owner && !paths.collection && !paths.grant) throw notFound();

    const rights = { view: true, reveal: false, copy: false, edit: false, share: false, manage: false };
    if (paths.owner) Object.assign(rights, { reveal: true, copy: true, edit: true, share: true, manage: true });
    if (paths.collection) {
        rights.reveal ||= Boolean(row.m_reveal);
        rights.copy ||= Boolean(row.m_copy);
        rights.edit ||= Boolean(row.m_edit);
        rights.share ||= Boolean(row.m_share);
        rights.manage ||= Boolean(row.m_manager);
    }
    if (paths.grant) {
        rights.reveal ||= Boolean(row.g_reveal);
        rights.copy ||= Boolean(row.g_copy);
        rights.edit ||= Boolean(row.g_edit);
        rights.share ||= Boolean(row.g_share);
    }

    const via = paths.owner ? "owner" : paths.collection ? "collection" : "grant";
    const expiresAt = via === "collection" ? row.m_expires : via === "grant" ? row.g_expires : null;
    return { rights, paths, via, expiresAt, grantId: paths.grant ? row.g_id : null, grantParent: paths.grant ? row.g_parent : null };
}

function require_(access, right) {
    if (!access.rights[right]) throw forbidden();
    return access;
}

// Deleting, restoring and rotating the keys of an item: the owner of a personal item, a manager of a collection item.
function requireOwnerOrManager(access) {
    if (!(access.paths.owner || (access.paths.collection && access.rights.manage))) throw forbidden();
    return access;
}

// What a sharer may hand on. Never more than they hold; "share" itself is only delegated by an owner or a manager (a grantee
// cannot make further sharers), which keeps the chain of who can grant bounded and revocable.
function assertGrantable(access, wanted) {
    const r = access.rights;
    if (wanted.reveal && !r.reveal) throw forbidden("You cannot give more than you have.");
    if (wanted.copy && !r.copy) throw forbidden("You cannot give more than you have.");
    if (wanted.edit && !r.edit) throw forbidden("You cannot give more than you have.");
    if (wanted.share && !(access.paths.owner || r.manage)) throw forbidden("Only an owner or manager can allow further sharing.");
}

function assertActiveUser(user) {
    const active = user && user.status === "active" && (!user.employment_status || user.employment_status === "active");
    if (!active) throw new VaultError(403, "ACCOUNT_INACTIVE", "This account is not active.");
    return user;
}

function assertAccountExists(account) {
    if (!account) throw new VaultError(409, "ACCOUNT_REQUIRED", "Set up your ZioVault first.");
    return account;
}

function memberRights(row) {
    return {
        reveal: Boolean(row.m_reveal),
        copy: Boolean(row.m_copy),
        edit: Boolean(row.m_edit),
        share: Boolean(row.m_share),
        manager: Boolean(row.m_manager),
    };
}

module.exports = { canAdministerCompanyVault, canCreateCollections, resolveItemRights, requireRight: require_, requireOwnerOrManager, assertGrantable, assertActiveUser, assertAccountExists, memberRights };
