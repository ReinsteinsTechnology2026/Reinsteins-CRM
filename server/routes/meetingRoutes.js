const express = require("express");

const router = express.Router();

const {
    createMeeting,
    getMeetings,
    getStats,
    getMeeting,
    joinMeeting,
    startMeeting,
    endMeeting,
    resumeMeeting,
    cancelMeeting,
    updateMeeting,
    leaveMeeting,
    getParticipants,
    admitParticipant,
    rejectParticipant,
    removeParticipant,
    changeParticipantRole,
    setLock,
    getMessages,
    sendMessage,
    uploadMeetingAttachment,
    searchParticipants,
    getAvailability
} = require("../controllers/meetingController");

const {
    protect,
    adminOnly
} = require("../middleware/authMiddleware");

const meetingUpload = require("../middleware/meetingUploadMiddleware");

// All meeting routes require a logged-in user.
// Individual endpoints add finer-grained
// host/co-host/admin checks in the controller.

router.use(protect);

// ==========================================
// ADMIN STATS
// Must come before "/:id" so "stats" is not
// parsed as a meeting id.
// ==========================================

router.get("/stats", adminOnly, getStats);

// ==========================================
// JOIN MEETING (by code + optional password)
// Must come before "/:id" for the same reason.
// ==========================================

router.post("/join", joinMeeting);

// ==========================================
// PARTICIPANT PICKER + AVAILABILITY
// Must come before "/:id" for the same reason.
// New, additive: no existing meeting data/system,
// pure read-only lookups backing the Calendar's
// invite UI.
// ==========================================

router.get("/participants/search", searchParticipants);

router.get("/availability", getAvailability);

// ==========================================
// CORE MEETING CRUD
// ==========================================

router.get("/", getMeetings);

router.post("/", createMeeting);

router.get("/:id", getMeeting);

router.put("/:id", updateMeeting);

router.post("/:id/start", startMeeting);

router.post("/:id/end", endMeeting);

router.post("/:id/resume", resumeMeeting);

router.post("/:id/cancel", cancelMeeting);

router.post("/:id/leave", leaveMeeting);

router.put("/:id/lock", setLock);

// ==========================================
// PARTICIPANTS
// ==========================================

router.get("/:id/participants", getParticipants);

router.put("/:id/participants/:participantUserId/admit", admitParticipant);

router.put("/:id/participants/:participantUserId/reject", rejectParticipant);

router.put("/:id/participants/:participantUserId/remove", removeParticipant);

router.put("/:id/participants/:participantUserId/role", changeParticipantRole);

// ==========================================
// MEETING CHAT
// ==========================================

router.get("/:id/messages", getMessages);

router.post("/:id/messages", sendMessage);

// Wraps multer so a rejected/oversized file returns a clean JSON
// error instead of an unhandled exception (a gap the equivalent
// normal-chat upload route has today — not fixed there, since that
// would mean touching working chat code, but not worth repeating
// here for a brand new route).

router.post("/:id/messages/attachment", (req, res, next) => {

    meetingUpload.single("file")(req, res, (err) => {

        if (err) {

            if (err.code === "LIMIT_FILE_SIZE") {
                return res.status(400).json({ success: false, message: "File is too large. Maximum size is 50MB." });
            }

            return res.status(400).json({ success: false, message: err.message || "Unable to upload file." });

        }

        next();

    });

}, uploadMeetingAttachment);

module.exports = router;
