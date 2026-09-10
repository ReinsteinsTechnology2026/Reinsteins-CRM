const pool = require("../config/db");
const bcrypt = require("bcrypt");
const crypto = require("crypto");

// ==========================================
// GENERATE SECURE MEETING CODE
// Format: WH-XXX-XXX-XXX (matches how real
// meeting platforms use large numeric IDs;
// the real access boundary is the optional
// password + waiting room / host approval,
// not code secrecy alone).
// ==========================================

const generateMeetingCode = async () => {

    for (let attempt = 0; attempt < 10; attempt++) {

        const segment = () =>
            String(crypto.randomInt(100, 1000));

        const code = `WH-${segment()}-${segment()}-${segment()}`;

        const [existing] = await pool.query(`
            SELECT id FROM meetings WHERE meeting_code = ? LIMIT 1
        `, [code]);

        if (existing.length === 0) {
            return code;
        }

    }

    throw new Error("Unable to generate a unique meeting code");

};

// ==========================================
// ADD PARTICIPANTS (additive, invite-only)
// Inserts new meeting_participants rows as
// 'admitted' (matches how the host row is
// already inserted). INSERT IGNORE is safe
// against the UNIQUE(meeting_id, user_id)
// constraint -- never updates an existing
// row, so it can't disturb someone who is
// already 'waiting'/'left'/'removed'/'rejected'.
// ==========================================

const addParticipants = async (meetingId, actingUserId, participantUserIds) => {

    if (!Array.isArray(participantUserIds) || participantUserIds.length === 0) {
        return [];
    }

    const ids = [...new Set(
        participantUserIds
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0 && id !== Number(actingUserId))
    )];

    if (ids.length === 0) {
        return [];
    }

    const addedUserIds = [];

    for (const userId of ids) {

        const [result] = await pool.query(`
            INSERT IGNORE INTO meeting_participants(
                meeting_id, user_id, role, status, invited_by
            )
            VALUES(?,?,'participant','admitted',?)
        `, [meetingId, userId, actingUserId]);

        if (result.affectedRows > 0) {
            addedUserIds.push(userId);
        }

    }

    return addedUserIds;

};

// ==========================================
// CREATE MEETING
// ==========================================

const createMeeting = async (data, hostId) => {

    const {

        title,
        description,
        meetingType,
        scheduledDate,
        startTime,
        endTime,
        password,
        allowGuestJoin,
        waitingRoomEnabled,
        requireHostApproval,
        settings

    } = data;

    const meetingCode = await generateMeetingCode();

    const passwordHash = password?.trim()
        ? await bcrypt.hash(password.trim(), 12)
        : null;

    const [result] = await pool.query(`
        INSERT INTO meetings(
            meeting_code,
            title,
            description,
            host_id,
            meeting_type,
            scheduled_date,
            start_time,
            end_time,
            password_hash,
            allow_guest_join,
            waiting_room_enabled,
            require_host_approval,
            settings,
            status
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [

        meetingCode,
        title,
        description || null,
        hostId,
        meetingType === "instant" ? "instant" : "scheduled",
        scheduledDate || null,
        startTime || null,
        endTime || null,
        passwordHash,
        allowGuestJoin === false ? 0 : 1,
        waitingRoomEnabled ? 1 : 0,
        requireHostApproval ? 1 : 0,
        settings ? JSON.stringify(settings) : null,
        meetingType === "instant" ? "live" : "scheduled"

    ]);

    const meetingId = result.insertId;

    if (meetingType === "instant") {

        await pool.query(`
            UPDATE meetings SET actual_start_time = NOW() WHERE id = ?
        `, [meetingId]);

    }

    // Host is always an admitted participant of their own meeting.

    await pool.query(`
        INSERT INTO meeting_participants(
            meeting_id, user_id, role, status
        )
        VALUES(?,?,'host','admitted')
    `, [meetingId, hostId]);

    const addedUserIds = await addParticipants(meetingId, hostId, data.participantUserIds);

    return { meeting: await getMeetingById(meetingId), addedUserIds };

};

// ==========================================
// GET MEETING BY ID (with host name + counts)
// ==========================================

const getMeetingById = async (id) => {

    const [meetings] = await pool.query(`
        SELECT
            m.*,
            u.full_name AS host_name,
            (
                SELECT COUNT(*)
                FROM meeting_participants mp
                WHERE mp.meeting_id = m.id
                AND mp.status IN ('admitted','joined')
            ) AS participant_count
        FROM meetings m
        INNER JOIN users u ON u.id = m.host_id
        WHERE m.id = ?
        LIMIT 1
    `, [id]);

    if (meetings.length === 0) return null;

    const meeting = meetings[0];

    delete meeting.password_hash;

    meeting.has_password = Boolean(meetings[0].password_hash);

    return meeting;

};

// ==========================================
// GET MEETING BY CODE (internal use — join flow)
// Keeps password_hash, since joinMeeting() needs
// it. Never return this row directly to the client.
// ==========================================

const getMeetingByCode = async (meetingCode) => {

    const [meetings] = await pool.query(`
        SELECT m.*, u.full_name AS host_name
        FROM meetings m
        INNER JOIN users u ON u.id = m.host_id
        WHERE m.meeting_code = ?
        LIMIT 1
    `, [meetingCode]);

    return meetings[0] || null;

};

// ==========================================
// LIST MEETINGS
// Admin sees every meeting. Employees see
// meetings they host or already participate in.
// ==========================================

const listMeetings = async (user) => {

    if (user.role === "admin") {

        const [meetings] = await pool.query(`
            SELECT
                m.*,
                u.full_name AS host_name,
                (
                    SELECT COUNT(*)
                    FROM meeting_participants mp
                    WHERE mp.meeting_id = m.id
                    AND mp.status IN ('admitted','joined')
                ) AS participant_count
            FROM meetings m
            INNER JOIN users u ON u.id = m.host_id
            ORDER BY m.scheduled_date DESC, m.created_at DESC
        `);

        meetings.forEach((meeting) => {
            meeting.has_password = Boolean(meeting.password_hash);
            delete meeting.password_hash;
        });

        return meetings;

    }

    const [meetings] = await pool.query(`
        SELECT DISTINCT
            m.*,
            u.full_name AS host_name,
            (
                SELECT COUNT(*)
                FROM meeting_participants mp2
                WHERE mp2.meeting_id = m.id
                AND mp2.status IN ('admitted','joined')
            ) AS participant_count
        FROM meetings m
        INNER JOIN users u ON u.id = m.host_id
        LEFT JOIN meeting_participants mp
            ON mp.meeting_id = m.id AND mp.user_id = ?
        WHERE
            m.host_id = ?
            OR mp.user_id IS NOT NULL
        ORDER BY m.scheduled_date DESC, m.created_at DESC
    `, [user.id, user.id]);

    meetings.forEach((meeting) => {
        meeting.has_password = Boolean(meeting.password_hash);
        delete meeting.password_hash;
    });

    return meetings;

};

// ==========================================
// ADMIN STATS
// ==========================================

const getMeetingStats = async () => {

    const [rows] = await pool.query(`
        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS live,
            SUM(CASE WHEN status = 'scheduled' THEN 1 ELSE 0 END) AS upcoming,
            SUM(CASE WHEN status = 'ended' THEN 1 ELSE 0 END) AS completed
        FROM meetings
    `);

    return rows[0];

};

// ==========================================
// VERIFY MEETING ACCESS
// Host, or a participant who has been
// admitted/joined at some point.
// ==========================================

const verifyMeetingAccess = async (meetingId, userId) => {

    const [rows] = await pool.query(`
        SELECT mp.role, mp.status
        FROM meeting_participants mp
        WHERE mp.meeting_id = ? AND mp.user_id = ?
        LIMIT 1
    `, [meetingId, userId]);

    return rows[0] || null;

};

// ==========================================
// JOIN MEETING (by code + optional password)
// ==========================================

const joinMeeting = async (meetingCode, password, user) => {

    const meeting = await getMeetingByCode(meetingCode);

    if (!meeting) {
        return { error: "not_found" };
    }

    if (meeting.status === "cancelled") {
        return { error: "cancelled" };
    }

    if (meeting.status === "ended") {
        return { error: "ended" };
    }

    const isHost = Number(meeting.host_id) === Number(user.id);

    if (meeting.password_hash && !isHost) {

        const providedPassword = password?.trim() || "";

        const matches = providedPassword
            ? await bcrypt.compare(providedPassword, meeting.password_hash)
            : false;

        if (!matches) {
            return { error: "invalid_password" };
        }

    }

    const [existingRows] = await pool.query(`
        SELECT id, role, status
        FROM meeting_participants
        WHERE meeting_id = ? AND user_id = ?
        LIMIT 1
    `, [meeting.id, user.id]);

    const existing = existingRows[0];

    if (existing?.status === "removed") {
        return { error: "removed" };
    }

    if (existing?.status === "rejected") {
        return { error: "rejected" };
    }

    if (meeting.is_locked && !existing) {
        return { error: "locked" };
    }

    const needsApproval =
        !isHost &&
        !existing &&
        (meeting.waiting_room_enabled || meeting.require_host_approval);

    const nextStatus = isHost
        ? "joined"
        : needsApproval
            ? "waiting"
            : "joined";

    if (existing) {

        await pool.query(`
            UPDATE meeting_participants
            SET status = ?, joined_at = IF(? = 'joined', NOW(), joined_at)
            WHERE id = ?
        `, [
            existing.status === "admitted" ? "joined" : (needsApproval ? existing.status : nextStatus),
            existing.status === "admitted" ? "joined" : (needsApproval ? existing.status : nextStatus),
            existing.id
        ]);

    } else {

        await pool.query(`
            INSERT INTO meeting_participants(
                meeting_id, user_id, role, status, joined_at
            )
            VALUES(?,?,'participant',?, IF(? = 'joined', NOW(), NULL))
        `, [meeting.id, user.id, nextStatus, nextStatus]);

    }

    const finalMeeting = await getMeetingById(meeting.id);

    return {
        meeting: finalMeeting,
        participantStatus: existing?.status === "admitted" ? "joined" : nextStatus
    };

};

// ==========================================
// START MEETING (host only — enforced by controller)
// ==========================================

const startMeeting = async (meetingId) => {

    await pool.query(`
        UPDATE meetings
        SET status = 'live', actual_start_time = NOW()
        WHERE id = ?
    `, [meetingId]);

    return getMeetingById(meetingId);

};

// ==========================================
// END MEETING (host only — enforced by controller)
// ==========================================

const endMeeting = async (meetingId) => {

    await pool.query(`
        UPDATE meetings
        SET status = 'ended', actual_end_time = NOW()
        WHERE id = ?
    `, [meetingId]);

    await pool.query(`
        UPDATE meeting_participants
        SET status = 'left', left_at = NOW()
        WHERE meeting_id = ? AND status IN ('admitted','joined')
    `, [meetingId]);

    return getMeetingById(meetingId);

};

// ==========================================
// RESUME MEETING (host/admin only — enforced
// by controller; ended meetings only, enforced
// here too via the WHERE guard so a race
// between two concurrent resume attempts can
// only ever succeed once).
//
// Deliberately reuses the exact same
// status/timestamp shape startMeeting already
// writes — a resumed meeting is a live meeting
// in every way that matters downstream (join
// flow, meeting link, Socket.IO room, chat).
// actual_end_time is cleared back to NULL since
// the meeting is no longer ended; nothing else
// about the meeting row changes, and no other
// table is touched — meeting_messages keeps its
// full history, and meeting_participants is left
// to the existing joinMeeting logic, which
// already updates a returning participant's
// row (status 'left' -> 'joined') instead of
// inserting a duplicate.
// ==========================================

const resumeMeeting = async (meetingId) => {

    const [result] = await pool.query(`
        UPDATE meetings
        SET status = 'live', actual_start_time = NOW(), actual_end_time = NULL
        WHERE id = ? AND status = 'ended'
    `, [meetingId]);

    if (result.affectedRows === 0) {
        return null;
    }

    return getMeetingById(meetingId);

};

// ==========================================
// CANCEL MEETING (host only, scheduled only)
// ==========================================

const cancelMeeting = async (meetingId) => {

    await pool.query(`
        UPDATE meetings
        SET status = 'cancelled'
        WHERE id = ? AND status = 'scheduled'
    `, [meetingId]);

    return getMeetingById(meetingId);

};

// ==========================================
// UPDATE MEETING (host only, scheduled only)
// ==========================================

const updateMeeting = async (meetingId, data, actingUserId) => {

    const {
        title,
        description,
        scheduledDate,
        startTime,
        endTime,
        password,
        allowGuestJoin,
        waitingRoomEnabled,
        requireHostApproval
    } = data;

    const passwordHash = password?.trim()
        ? await bcrypt.hash(password.trim(), 12)
        : password === ""
            ? null
            : undefined;

    if (passwordHash !== undefined) {

        await pool.query(`
            UPDATE meetings
            SET
                title = ?, description = ?, scheduled_date = ?,
                start_time = ?, end_time = ?, password_hash = ?,
                allow_guest_join = ?, waiting_room_enabled = ?,
                require_host_approval = ?
            WHERE id = ? AND status = 'scheduled'
        `, [
            title, description || null, scheduledDate || null,
            startTime || null, endTime || null, passwordHash,
            allowGuestJoin === false ? 0 : 1, waitingRoomEnabled ? 1 : 0,
            requireHostApproval ? 1 : 0, meetingId
        ]);

    } else {

        await pool.query(`
            UPDATE meetings
            SET
                title = ?, description = ?, scheduled_date = ?,
                start_time = ?, end_time = ?,
                allow_guest_join = ?, waiting_room_enabled = ?,
                require_host_approval = ?
            WHERE id = ? AND status = 'scheduled'
        `, [
            title, description || null, scheduledDate || null,
            startTime || null, endTime || null,
            allowGuestJoin === false ? 0 : 1, waitingRoomEnabled ? 1 : 0,
            requireHostApproval ? 1 : 0, meetingId
        ]);

    }

    const addedUserIds = await addParticipants(meetingId, actingUserId, data.participantUserIds);

    return { meeting: await getMeetingById(meetingId), addedUserIds };

};

// ==========================================
// LEAVE MEETING
// ==========================================

const leaveMeeting = async (meetingId, userId) => {

    await pool.query(`
        UPDATE meeting_participants
        SET status = 'left', left_at = NOW()
        WHERE meeting_id = ? AND user_id = ?
        AND status IN ('admitted','joined')
    `, [meetingId, userId]);

};

// ==========================================
// GET PARTICIPANTS
// ==========================================

const getParticipants = async (meetingId) => {

    const [participants] = await pool.query(`
        SELECT
            mp.id,
            mp.user_id,
            mp.role,
            mp.status,
            mp.joined_at,
            mp.left_at,
            u.full_name,
            u.employee_id,
            u.profile_photo
        FROM meeting_participants mp
        INNER JOIN users u ON u.id = mp.user_id
        WHERE mp.meeting_id = ?
        ORDER BY
            FIELD(mp.role, 'host', 'co_host', 'presenter', 'participant'),
            mp.created_at ASC
    `, [meetingId]);

    return participants;

};

// ==========================================
// ADMIT / REJECT / REMOVE PARTICIPANT
// ==========================================

const admitParticipant = async (meetingId, participantUserId) => {

    await pool.query(`
        UPDATE meeting_participants
        SET status = 'admitted'
        WHERE meeting_id = ? AND user_id = ? AND status = 'waiting'
    `, [meetingId, participantUserId]);

};

const rejectParticipant = async (meetingId, participantUserId) => {

    await pool.query(`
        UPDATE meeting_participants
        SET status = 'rejected'
        WHERE meeting_id = ? AND user_id = ? AND status = 'waiting'
    `, [meetingId, participantUserId]);

};

const removeParticipant = async (meetingId, participantUserId) => {

    await pool.query(`
        UPDATE meeting_participants
        SET status = 'removed', left_at = NOW()
        WHERE meeting_id = ? AND user_id = ?
        AND status IN ('admitted','joined','waiting')
    `, [meetingId, participantUserId]);

};

const changeParticipantRole = async (meetingId, participantUserId, role) => {

    if (!["co_host", "presenter", "participant"].includes(role)) {
        throw new Error("Invalid role");
    }

    await pool.query(`
        UPDATE meeting_participants
        SET role = ?
        WHERE meeting_id = ? AND user_id = ? AND role != 'host'
    `, [role, meetingId, participantUserId]);

};

const setMeetingLock = async (meetingId, isLocked) => {

    await pool.query(`
        UPDATE meetings SET is_locked = ? WHERE id = ?
    `, [isLocked ? 1 : 0, meetingId]);

};

// ==========================================
// MEETING CHAT
// ==========================================

// messageType defaults to "text" so the existing plain-text call
// site (meetingController.js's sendMessage) works completely
// unchanged — attachment messages pass "image"/"file" explicitly
// and an empty messageText, mirroring the normal chat convention
// (messages.message_type / '' text for attachment-only messages).

const sendMeetingMessage = async (meetingId, senderId, messageText, messageType = "text") => {

    const [result] = await pool.query(`
        INSERT INTO meeting_messages(meeting_id, sender_id, message_text, message_type)
        VALUES(?,?,?,?)
    `, [meetingId, senderId, messageText || "", messageType]);

    const [saved] = await pool.query(`
        SELECT mm.*, u.full_name AS sender_name
        FROM meeting_messages mm
        INNER JOIN users u ON u.id = mm.sender_id
        WHERE mm.id = ?
    `, [result.insertId]);

    return saved[0];

};

// Records the uploaded file for a meeting message that was just
// created with messageType "image"/"file". Kept in its own table
// (meeting_message_attachments) rather than the existing
// chat_attachments table, because chat_attachments.message_id
// references messages.id — a completely different table with its
// own separate auto-increment sequence than meeting_messages.id —
// so reusing it would create ambiguous, unsafe foreign-key
// semantics. This mirrors chat_attachments' column shape exactly,
// just correctly scoped to meeting_messages.

const saveMeetingMessageAttachment = async (messageId, attachment) => {

    await pool.query(`
        INSERT INTO meeting_message_attachments(
            message_id, original_name, stored_name, file_type, file_size, file_path, uploaded_by
        )
        VALUES(?,?,?,?,?,?,?)
    `, [
        messageId,
        attachment.originalName,
        attachment.storedName,
        attachment.fileType,
        attachment.fileSize,
        attachment.filePath,
        attachment.uploadedBy,
    ]);

};

const getMeetingMessages = async (meetingId) => {

    const [messages] = await pool.query(`
        SELECT
            mm.id,
            mm.meeting_id,
            mm.sender_id,
            mm.message_text,
            mm.message_type,
            mm.created_at,
            u.full_name AS sender_name,
            mma.original_name AS file_name,
            mma.file_path AS image,
            mma.file_type AS mime_type,
            mma.file_size
        FROM meeting_messages mm
        INNER JOIN users u ON u.id = mm.sender_id
        LEFT JOIN meeting_message_attachments mma ON mma.message_id = mm.id
        WHERE mm.meeting_id = ?
        ORDER BY mm.created_at ASC
    `, [meetingId]);

    return messages;

};

// ==========================================
// SEARCH PARTICIPANTS (for the invite picker)
// Deliberately minimal, safe field set --
// no HR/sensitive columns returned.
// ==========================================

const searchParticipants = async (query, excludeUserId) => {

    const like = `%${query || ""}%`;

    const [rows] = await pool.query(`
        SELECT
            u.id,
            u.full_name,
            u.email,
            u.employee_id,
            u.designation,
            d.name AS department_name
        FROM users u
        LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.employment_status = 'active'
          AND u.role IN ('employee','admin')
          AND u.id != ?
          AND (u.full_name LIKE ? OR u.email LIKE ? OR u.employee_id LIKE ?)
        ORDER BY u.full_name
        LIMIT 20
    `, [excludeUserId, like, like, like]);

    return rows;

};

// ==========================================
// PARTICIPANT AVAILABILITY (advisory only --
// never blocks create/update; overlap check
// against a user's existing meetings on a
// given date/time window)
// ==========================================

const getParticipantAvailability = async (userIds, date, startTime, endTime) => {

    if (!Array.isArray(userIds) || userIds.length === 0 || !date || !startTime || !endTime) {
        return [];
    }

    const [rows] = await pool.query(`
        SELECT mp.user_id, m.id AS meeting_id, m.title, m.start_time, m.end_time
        FROM meeting_participants mp
        INNER JOIN meetings m ON m.id = mp.meeting_id
        WHERE mp.user_id IN (?)
          AND mp.status NOT IN ('rejected','removed')
          AND m.status != 'cancelled'
          AND m.scheduled_date = ?
          AND m.start_time < ?
          AND m.end_time > ?
    `, [userIds, date, endTime, startTime]);

    return rows;

};

module.exports = {

    createMeeting,
    searchParticipants,
    getParticipantAvailability,
    getMeetingById,
    getMeetingByCode,
    listMeetings,
    getMeetingStats,
    verifyMeetingAccess,
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
    setMeetingLock,
    sendMeetingMessage,
    saveMeetingMessageAttachment,
    getMeetingMessages

};
