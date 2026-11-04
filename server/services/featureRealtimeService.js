const { presenceRoom } = require("../utils/socketRooms");
const { FEATURE_IDS, SOCKET_ROOM_MARKERS } = require("../config/tenantFeatures");

// ==========================================
// LIVE REVALIDATION when the Owner changes a company's features
//
// The API gate and the per-event socket gate already refuse a disabled module on the very next request/event. This closes
// the rest of the loop for users who have the module OPEN right now:
//   1. every connected socket of that company is told the new list ("tenant:features-changed"), so the browser hides the
//      module and shows "This feature is not enabled for your organization." instead of a half-working page;
//   2. every socket is removed from the live rooms of the modules that were switched off (chat conversations, meetings,
//      spreadsheets), so no further module traffic is delivered to it.
//
// Scope = the company slug: only tenant sockets get here (legacy sockets use the "legacy-db" scope and are never affected).
// ==========================================

function leaveRoomsOf(io, companySlug, featureId) {
    const markers = SOCKET_ROOM_MARKERS[featureId] || [];
    const prefix = `tenant:${companySlug}:`;
    let left = 0;
    for (const room of [...io.sockets.adapter.rooms.keys()]) {
        if (!room.startsWith(prefix)) continue;
        const rest = room.slice(prefix.length - 1); // keeps the leading ":" so a marker like ":meeting:" matches
        if (markers.some((marker) => rest.startsWith(marker))) {
            io.in(room).socketsLeave(room);
            left += 1;
        }
    }
    return left;
}

function applyFeatureChange(io, companySlug, { before, after }) {
    if (!io || !companySlug) return { notified: false, roomsLeft: 0 };
    const nowDisabled = FEATURE_IDS.filter((id) => before.includes(id) && !after.includes(id));
    let roomsLeft = 0;
    for (const featureId of nowDisabled) roomsLeft += leaveRoomsOf(io, companySlug, featureId);
    io.to(presenceRoom(companySlug)).emit("tenant:features-changed", { features: after });
    return { notified: true, roomsLeft };
}

module.exports = { applyFeatureChange };
