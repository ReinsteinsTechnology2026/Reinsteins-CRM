const { __LEGACY_COMPANY_SLUG: LEGACY_COMPANY_SLUG, __getCurrentCompanySlug: getCurrentCompanySlug } = require("../config/db");

// ==========================================
// SOCKET.IO ROOM NAMING (Socket.IO Multi-Tenant Isolation Phase)
//
// The ONLY place in the codebase that builds a Socket.IO room name.
// Every join/emit call site -- in app.js's socket handlers AND in
// every REST controller/service that emits via req.app.get("io") --
// must go through these functions instead of hand-building a
// template string.
//
// WHY THIS EXISTS: room names were previously bare
// (`user:${userId}`, `meeting:${meetingId}`, `conversation:${id}`),
// with no tenant component at all. Since every tenant database's
// auto-increment IDs independently restart at 1, Tenant A's user #3
// and Tenant B's user #3 (or meeting #1, or conversation #1) would
// resolve to the EXACT SAME Socket.IO room -- a real cross-tenant
// signaling/data leak, not a theoretical one. Namespacing every room
// by company slug makes that collision structurally impossible: two
// different companies can never produce the same room string.
//
// getCurrentCompanySlug() reads the ambient AsyncLocalStorage
// context (see config/db.js) -- the same context that already
// determines which tenant database `pool.query()` resolves to. This
// keeps "which tenant's data" and "which tenant's room" tied to the
// exact same source of truth, rather than two independently-tracked
// values that could drift apart. It defaults to the real Reinsteins
// company slug when no tenant context is active (an ordinary legacy
// request or a legacy-authenticated socket), so Reinsteins' rooms
// are simply `tenant:reinsteins:...` -- namespaced the same as every
// other company, not a special case.
// ==========================================

function userRoom(companySlug, userId) {
    return `tenant:${companySlug}:user:${userId}`;
}

function meetingRoom(companySlug, meetingId) {
    return `tenant:${companySlug}:meeting:${meetingId}`;
}

function conversationRoom(companySlug, conversationId) {
    return `tenant:${companySlug}:conversation:${conversationId}`;
}

// The room every socket for a given company joins on connect, used
// ONLY for tenant-scoped presence broadcast (user:online/offline) --
// never for anything containing another user's private data.
function presenceRoom(companySlug) {
    return `tenant:${companySlug}:presence`;
}

// Convenience for REST controllers/services: builds a room using
// whatever company the CURRENT request/context belongs to, without
// the caller needing to look up the slug itself.
function currentUserRoom(userId) {
    return userRoom(getCurrentCompanySlug(), userId);
}
function currentMeetingRoom(meetingId) {
    return meetingRoom(getCurrentCompanySlug(), meetingId);
}
function currentConversationRoom(conversationId) {
    return conversationRoom(getCurrentCompanySlug(), conversationId);
}

module.exports = {
    LEGACY_COMPANY_SLUG,
    getCurrentCompanySlug,
    userRoom,
    meetingRoom,
    conversationRoom,
    presenceRoom,
    currentUserRoom,
    currentMeetingRoom,
    currentConversationRoom,
};
