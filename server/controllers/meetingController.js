const meetingService = require("../services/meetingService");
const { createNotification } = require("../services/notificationService");
const { currentUserRoom, currentMeetingRoom } = require("../utils/socketRooms");
const { tenantUploadUrlPath } = require("../utils/tenantUploadPath");
const { signFileUrl } = require("../utils/fileAccessToken");
const { __getCurrentCompanySlug: getCurrentCompanySlug } = require("../config/db");

// ==========================================
// NOTIFICATION HELPER (meeting invites)
// New wiring only -- meetings previously sent
// zero notifications. Uses the same shared
// createNotification() helper as every other
// module in the app.
// ==========================================

const notifyInvitedParticipants = async (req, meeting, addedUserIds) => {

    for (const userId of addedUserIds) {

        await createNotification({
            req,
            userId,
            title: "Meeting invitation",
            message: `${meeting.host_name} invited you to "${meeting.title}"`,
            type: "meeting",
            referenceType: "meeting",
            referenceId: meeting.id,
        });

    }

};

// ==========================================
// AUTHORIZATION HELPERS
// Backend is the source of truth for every
// permission check — never trust the client.
// ==========================================

const isHost = (meeting, userId) =>
    Number(meeting.host_id) === Number(userId);

const canModerate = async (meetingId, userId, meeting) => {

    if (isHost(meeting, userId)) return true;

    const participant = await meetingService.verifyMeetingAccess(meetingId, userId);

    return Boolean(participant && participant.role === "co_host");

};

const canAccessMeeting = async (meeting, userId, role) => {

    if (role === "admin") return true;

    if (isHost(meeting, userId)) return true;

    const participant = await meetingService.verifyMeetingAccess(meeting.id, userId);

    return Boolean(participant && ["admitted", "joined", "left"].includes(participant.status));

};

// ==========================================
// CREATE MEETING
// ==========================================

const createMeeting = async (req, res) => {

    try {

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Meeting title is required"
            });
        }

        const { meeting, addedUserIds } = await meetingService.createMeeting(req.body, req.user.id);

        const io = req.app.get("io");

        if (io) {
            io.to(currentUserRoom(req.user.id)).emit("meeting:created", { meeting });
        }

        await notifyInvitedParticipants(req, meeting, addedUserIds);

        return res.status(201).json({
            success: true,
            message: "Meeting created successfully",
            meeting
        });

    } catch (error) {

        console.error("Create Meeting Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to create meeting"
        });

    }

};

// ==========================================
// LIST MEETINGS
// ==========================================

const getMeetings = async (req, res) => {

    try {

        const meetings = await meetingService.listMeetings(req.user);

        return res.json({ success: true, meetings });

    } catch (error) {

        console.error("List Meetings Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load meetings"
        });

    }

};

// ==========================================
// ADMIN STATS
// ==========================================

const getStats = async (req, res) => {

    try {

        const stats = await meetingService.getMeetingStats();

        return res.json({ success: true, stats });

    } catch (error) {

        console.error("Meeting Stats Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load meeting statistics"
        });

    }

};

// ==========================================
// GET MEETING DETAILS
// ==========================================

const getMeeting = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({
                success: false,
                message: "Meeting not found"
            });
        }

        const allowed = await canAccessMeeting(meeting, req.user.id, req.user.role);

        if (!allowed) {
            return res.status(403).json({
                success: false,
                message: "You do not have access to this meeting"
            });
        }

        return res.json({ success: true, meeting });

    } catch (error) {

        console.error("Get Meeting Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to load meeting"
        });

    }

};

// ==========================================
// JOIN MEETING (by code + optional password)
// ==========================================

const joinMeeting = async (req, res) => {

    try {

        const { meetingCode, password } = req.body;

        if (!meetingCode?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Meeting ID is required"
            });
        }

        const result = await meetingService.joinMeeting(
            meetingCode.trim().toUpperCase(),
            password,
            req.user
        );

        if (result.error) {

            const errorMap = {
                not_found: [404, "Meeting not found. Check the meeting ID and try again."],
                cancelled: [410, "This meeting has been cancelled."],
                ended: [410, "This meeting has already ended."],
                invalid_password: [401, "Incorrect meeting password."],
                removed: [403, "You have been removed from this meeting."],
                rejected: [403, "Your request to join this meeting was declined."],
                locked: [403, "This meeting is locked by the host."]
            };

            const [status, message] = errorMap[result.error] || [400, "Unable to join meeting"];

            return res.status(status).json({ success: false, message });

        }

        const io = req.app.get("io");

        if (io && result.participantStatus === "waiting") {

            io.to(currentMeetingRoom(result.meeting.id)).emit("meeting:waiting-room-update", {
                meetingId: result.meeting.id
            });

        }

        return res.json({
            success: true,
            meeting: result.meeting,
            participantStatus: result.participantStatus
        });

    } catch (error) {

        console.error("Join Meeting Error:", error);

        return res.status(500).json({
            success: false,
            message: "Unable to join meeting"
        });

    }

};

// ==========================================
// START MEETING (host only)
// ==========================================

const startMeeting = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        if (!isHost(meeting, req.user.id) && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Only the host can start this meeting" });
        }

        const updated = await meetingService.startMeeting(req.params.id);

        const io = req.app.get("io");

        if (io) {
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:started", { meetingId: Number(req.params.id) });
        }

        return res.json({ success: true, message: "Meeting started", meeting: updated });

    } catch (error) {

        console.error("Start Meeting Error:", error);

        return res.status(500).json({ success: false, message: "Unable to start meeting" });

    }

};

// ==========================================
// END MEETING (host only)
// ==========================================

const endMeeting = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        if (!isHost(meeting, req.user.id) && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Only the host can end this meeting" });
        }

        const updated = await meetingService.endMeeting(req.params.id);

        const io = req.app.get("io");

        if (io) {
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:ended", { meetingId: Number(req.params.id) });
        }

        return res.json({ success: true, message: "Meeting ended", meeting: updated });

    } catch (error) {

        console.error("End Meeting Error:", error);

        return res.status(500).json({ success: false, message: "Unable to end meeting" });

    }

};

// ==========================================
// RESUME MEETING (host/admin only)
//
// Same authorization shape as startMeeting/
// endMeeting — resuming is a lifecycle
// transition, not a moderation action, so
// co-hosts do not get this (matching the
// existing rule that only start/end/cancel/
// update are host-or-admin-only).
// ==========================================

const resumeMeeting = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        if (!isHost(meeting, req.user.id) && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Only the host can resume this meeting" });
        }

        if (meeting.status !== "ended") {
            return res.status(400).json({ success: false, message: "Only ended meetings can be resumed" });
        }

        const updated = await meetingService.resumeMeeting(req.params.id);

        if (!updated) {
            return res.status(400).json({ success: false, message: "Unable to resume this meeting" });
        }

        const io = req.app.get("io");

        if (io) {
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:started", { meetingId: Number(req.params.id) });
        }

        return res.json({ success: true, message: "Meeting resumed", meeting: updated });

    } catch (error) {

        console.error("Resume Meeting Error:", error);

        return res.status(500).json({ success: false, message: "Unable to resume meeting" });

    }

};

// ==========================================
// CANCEL MEETING (host only)
// ==========================================

const cancelMeeting = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        if (!isHost(meeting, req.user.id) && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Only the host can cancel this meeting" });
        }

        if (meeting.status !== "scheduled") {
            return res.status(400).json({ success: false, message: "Only scheduled meetings can be cancelled" });
        }

        const updated = await meetingService.cancelMeeting(req.params.id);

        return res.json({ success: true, message: "Meeting cancelled", meeting: updated });

    } catch (error) {

        console.error("Cancel Meeting Error:", error);

        return res.status(500).json({ success: false, message: "Unable to cancel meeting" });

    }

};

// ==========================================
// UPDATE MEETING (host only)
// ==========================================

const updateMeeting = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        if (!isHost(meeting, req.user.id) && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Only the host can edit this meeting" });
        }

        if (meeting.status !== "scheduled") {
            return res.status(400).json({ success: false, message: "Only scheduled meetings can be edited" });
        }

        const { title } = req.body;

        if (!title?.trim()) {
            return res.status(400).json({ success: false, message: "Meeting title is required" });
        }

        const { meeting: updated, addedUserIds } = await meetingService.updateMeeting(req.params.id, req.body, req.user.id);

        await notifyInvitedParticipants(req, updated, addedUserIds);

        return res.json({ success: true, message: "Meeting updated", meeting: updated });

    } catch (error) {

        console.error("Update Meeting Error:", error);

        return res.status(500).json({ success: false, message: "Unable to update meeting" });

    }

};

// ==========================================
// LEAVE MEETING
// ==========================================

const leaveMeeting = async (req, res) => {

    try {

        await meetingService.leaveMeeting(req.params.id, req.user.id);

        const io = req.app.get("io");

        if (io) {
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:participant-left", {
                userId: req.user.id
            });
        }

        return res.json({ success: true, message: "Left meeting" });

    } catch (error) {

        console.error("Leave Meeting Error:", error);

        return res.status(500).json({ success: false, message: "Unable to leave meeting" });

    }

};

// ==========================================
// GET PARTICIPANTS
// ==========================================

const getParticipants = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        const allowed = await canAccessMeeting(meeting, req.user.id, req.user.role);

        if (!allowed) {
            return res.status(403).json({ success: false, message: "You do not have access to this meeting" });
        }

        const participants = await meetingService.getParticipants(req.params.id);

        return res.json({ success: true, participants });

    } catch (error) {

        console.error("Get Participants Error:", error);

        return res.status(500).json({ success: false, message: "Unable to load participants" });

    }

};

// ==========================================
// ADMIT / REJECT / REMOVE / ROLE (host/co-host only)
// ==========================================

const moderateParticipant = (action) => async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        const allowed = req.user.role === "admin" || await canModerate(req.params.id, req.user.id, meeting);

        if (!allowed) {
            return res.status(403).json({ success: false, message: "Only the host or co-host can do this" });
        }

        const participantUserId = req.params.participantUserId;

        if (action === "admit") {
            await meetingService.admitParticipant(req.params.id, participantUserId);
        } else if (action === "reject") {
            await meetingService.rejectParticipant(req.params.id, participantUserId);
        } else if (action === "remove") {
            await meetingService.removeParticipant(req.params.id, participantUserId);
        } else if (action === "role") {

            const { role } = req.body;

            await meetingService.changeParticipantRole(req.params.id, participantUserId, role);

        }

        const io = req.app.get("io");

        if (io) {

            io.to(currentMeetingRoom(req.params.id)).emit("meeting:participant-updated", {
                meetingId: Number(req.params.id),
                participantUserId: Number(participantUserId),
                action
            });

            if (action === "admit") {
                io.to(currentUserRoom(participantUserId)).emit("meeting:admitted", {
                    meetingId: Number(req.params.id)
                });
            }

            if (action === "reject") {
                io.to(currentUserRoom(participantUserId)).emit("meeting:rejected", {
                    meetingId: Number(req.params.id)
                });
            }

            if (action === "remove") {
                io.to(currentUserRoom(participantUserId)).emit("meeting:removed", {
                    meetingId: Number(req.params.id)
                });
            }

        }

        return res.json({ success: true, message: "Updated successfully" });

    } catch (error) {

        console.error("Moderate Participant Error:", error);

        return res.status(500).json({ success: false, message: "Unable to update participant" });

    }

};

// ==========================================
// LOCK / UNLOCK MEETING (host/co-host only)
// ==========================================

const setLock = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        const allowed = req.user.role === "admin" || await canModerate(req.params.id, req.user.id, meeting);

        if (!allowed) {
            return res.status(403).json({ success: false, message: "Only the host or co-host can do this" });
        }

        await meetingService.setMeetingLock(req.params.id, req.body.isLocked);

        const io = req.app.get("io");

        if (io) {
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:lock-changed", {
                isLocked: Boolean(req.body.isLocked)
            });
        }

        return res.json({ success: true, message: "Meeting lock updated" });

    } catch (error) {

        console.error("Set Meeting Lock Error:", error);

        return res.status(500).json({ success: false, message: "Unable to update meeting lock" });

    }

};

// ==========================================
// MEETING CHAT
// ==========================================

const getMessages = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        const allowed = await canAccessMeeting(meeting, req.user.id, req.user.role);

        if (!allowed) {
            return res.status(403).json({ success: false, message: "You do not have access to this meeting" });
        }

        const messages = await meetingService.getMeetingMessages(req.params.id);

        return res.json({ success: true, messages });

    } catch (error) {

        console.error("Get Meeting Messages Error:", error);

        return res.status(500).json({ success: false, message: "Unable to load messages" });

    }

};

const sendMessage = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        const allowed = await canAccessMeeting(meeting, req.user.id, req.user.role);

        if (!allowed) {
            return res.status(403).json({ success: false, message: "You do not have access to this meeting" });
        }

        const text = req.body.message?.trim();

        if (!text) {
            return res.status(400).json({ success: false, message: "Message cannot be empty" });
        }

        const message = await meetingService.sendMeetingMessage(
            req.params.id,
            req.user.id,
            text.slice(0, 2000)
        );

        const io = req.app.get("io");

        if (io) {
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:chat-message", message);
        }

        return res.status(201).json({ success: true, message: "Message sent", data: message });

    } catch (error) {

        console.error("Send Meeting Message Error:", error);

        return res.status(500).json({ success: false, message: "Unable to send message" });

    }

};

// ==========================================
// UPLOAD MEETING CHAT ATTACHMENT
//
// Same authorization boundary as sendMessage/
// getMessages (canAccessMeeting — host, admin,
// or an admitted/joined/left participant) — an
// unauthorized user can neither read nor post
// meeting chat, attachments included. Reuses
// the existing meeting:chat-message broadcast
// so both text and attachment messages update
// every participant's chat panel identically —
// no second Socket.IO event.
// ==========================================

const uploadMeetingAttachment = async (req, res) => {

    try {

        const meeting = await meetingService.getMeetingById(req.params.id);

        if (!meeting) {
            return res.status(404).json({ success: false, message: "Meeting not found" });
        }

        const allowed = await canAccessMeeting(meeting, req.user.id, req.user.role);

        if (!allowed) {
            return res.status(403).json({ success: false, message: "You do not have access to this meeting" });
        }

        if (!req.file) {
            return res.status(400).json({ success: false, message: "Please select a file." });
        }

        const isImage = req.file.mimetype.startsWith("image/");

        const filePath = isImage
            ? tenantUploadUrlPath("meetings/images", req.file.filename)
            : tenantUploadUrlPath("meetings/files", req.file.filename);

        const messageType = isImage ? "image" : "file";

        const message = await meetingService.sendMeetingMessage(
            req.params.id,
            req.user.id,
            "",
            messageType
        );

        await meetingService.saveMeetingMessageAttachment(message.id, {
            originalName: req.file.originalname,
            storedName: req.file.filename,
            fileType: req.file.mimetype,
            fileSize: req.file.size,
            filePath,
            uploadedBy: req.user.id,
        });

        message.image = filePath;
        message.file_name = req.file.originalname;
        message.mime_type = req.file.mimetype;
        message.file_size = req.file.size;

        const io = req.app.get("io");

        if (io) {
            // Socket emits bypass res.json (and signFileUrlsMiddleware
            // entirely) -- sign a separate copy explicitly here, same
            // reasoning as chatController.js's uploadChatImage. The
            // `message` object returned via res.json below keeps the
            // plain path for the middleware to sign on its way out.
            const signedMessageForSocket = {
                ...message,
                image: signFileUrl(message.image, getCurrentCompanySlug()),
            };
            io.to(currentMeetingRoom(req.params.id)).emit("meeting:chat-message", signedMessageForSocket);
        }

        return res.status(201).json({ success: true, message: "Attachment sent", data: message });

    } catch (error) {

        console.error("Upload Meeting Attachment Error:", error);

        return res.status(500).json({ success: false, message: "Unable to upload attachment" });

    }

};

// ==========================================
// SEARCH PARTICIPANTS (invite picker)
// Any authenticated user -- least-privilege,
// minimal safe field set only.
// ==========================================

const searchParticipants = async (req, res) => {

    try {

        const results = await meetingService.searchParticipants(req.query.q, req.user.id);

        return res.json({ success: true, participants: results });

    } catch (error) {

        console.error("Search Participants Error:", error);

        return res.status(500).json({ success: false, message: "Unable to search participants" });

    }

};

// ==========================================
// PARTICIPANT AVAILABILITY (advisory only --
// never blocks meeting create/update)
// ==========================================

const getAvailability = async (req, res) => {

    try {

        const userIds = (req.query.userIds || "")
            .split(",")
            .map((id) => Number(id.trim()))
            .filter((id) => Number.isInteger(id) && id > 0)
            .slice(0, 50);

        const { date, startTime, endTime } = req.query;

        const availability = {};

        for (const userId of userIds) {
            availability[userId] = { busy: false, conflicts: [] };
        }

        if (userIds.length > 0 && date && startTime && endTime) {

            const conflicts = await meetingService.getParticipantAvailability(userIds, date, startTime, endTime);

            for (const row of conflicts) {
                availability[row.user_id].busy = true;
                availability[row.user_id].conflicts.push({
                    meeting_id: row.meeting_id,
                    title: row.title,
                    start_time: row.start_time,
                    end_time: row.end_time,
                });
            }

        }

        return res.json({ success: true, availability });

    } catch (error) {

        console.error("Get Availability Error:", error);

        return res.status(500).json({ success: false, message: "Unable to check availability" });

    }

};

module.exports = {

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
    admitParticipant: moderateParticipant("admit"),
    rejectParticipant: moderateParticipant("reject"),
    removeParticipant: moderateParticipant("remove"),
    changeParticipantRole: moderateParticipant("role"),
    setLock,
    getMessages,
    sendMessage,
    uploadMeetingAttachment,
    searchParticipants,
    getAvailability,

    // Exported for the Socket.IO layer in app.js
    // (same authorization helpers, no duplicated logic)
    _internal: {
        isHost,
        canModerate,
        canAccessMeeting
    }

};
