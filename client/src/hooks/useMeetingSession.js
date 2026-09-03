import { useSyncExternalStore } from "react";

import * as meetingSessionManager from "../services/meetingSessionManager";

// ==========================================
// USE MEETING SESSION
//
// Reads the live snapshot from the module-level
// meetingSessionManager singleton. Components call
// actions directly from meetingSessionManager (same
// convention as importing connectSocket/disconnectSocket
// from services/socket.js) -- this hook only exposes
// the reactive snapshot.
// ==========================================

export default function useMeetingSession() {

    return useSyncExternalStore(
        meetingSessionManager.subscribe,
        meetingSessionManager.getSnapshot,
        meetingSessionManager.getSnapshot
    );

}
