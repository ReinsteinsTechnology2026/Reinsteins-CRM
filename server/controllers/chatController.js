const pool = require("../config/db");
const { createNotification } = require("../services/notificationService");
const { currentUserRoom, currentConversationRoom } = require("../utils/socketRooms");
const { tenantUploadUrlPath } = require("../utils/tenantUploadPath");
const { signFileUrl } = require("../utils/fileAccessToken");
const { __getCurrentCompanySlug: getCurrentCompanySlug } = require("../config/db");

// ==========================================
// GET USERS AVAILABLE FOR CHAT
// ==========================================

const getChatUsers = async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const [users] = await pool.query(
      `
      SELECT
        id,
        employee_id,
        full_name,
        email,
        role
      FROM users
      WHERE id != ?
      AND status = 'active'
      ORDER BY full_name ASC
      `,
      [currentUserId]
    );

    return res.status(200).json({
      success: true,
      users,
    });
  } catch (error) {
    console.error(
      "Get Chat Users Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to load chat users",
    });
  }
};

// ==========================================
// CREATE OR GET PRIVATE CONVERSATION
// ==========================================

const createPrivateConversation =
  async (req, res) => {
    const connection =
      await pool.getConnection();

    let transactionStarted =
      false;

    try {
      const currentUserId =
        req.user.id;

      const {
        userId,
      } = req.body;

      const targetUserId =
        Number(userId);

      if (
        !Number.isInteger(
          targetUserId
        ) ||
        targetUserId <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Valid user ID is required",
        });
      }

      if (
        Number(currentUserId) ===
        targetUserId
      ) {
        return res.status(400).json({
          success: false,
          message:
            "You cannot start a private conversation with yourself",
        });
      }

      // ======================================
      // CHECK TARGET USER
      // ======================================

      const [targetUsers] =
        await connection.query(
          `
          SELECT
            id,
            employee_id,
            full_name,
            role
          FROM users
          WHERE id = ?
          AND status = 'active'
          LIMIT 1
          `,
          [
            targetUserId,
          ]
        );

      if (
        targetUsers.length ===
        0
      ) {
        return res.status(404).json({
          success: false,
          message:
            "User not found or inactive",
        });
      }

      // ======================================
      // CHECK EXISTING PRIVATE CONVERSATION
      // ======================================

      const [existing] =
        await connection.query(
          `
          SELECT
            c.id
          FROM conversations c

          INNER JOIN conversation_members cm1
            ON
              cm1.conversation_id = c.id
              AND
              cm1.user_id = ?

          INNER JOIN conversation_members cm2
            ON
              cm2.conversation_id = c.id
              AND
              cm2.user_id = ?

          WHERE
            c.conversation_type = 'private'

          AND (
            SELECT COUNT(*)
            FROM conversation_members cm3
            WHERE
              cm3.conversation_id = c.id
          ) = 2

          LIMIT 1
          `,
          [
            currentUserId,
            targetUserId,
          ]
        );

      if (
        existing.length > 0
      ) {
        return res.status(200).json({
          success: true,

          conversationId:
            existing[0].id,

          created: false,
        });
      }

      // ======================================
      // CREATE PRIVATE CONVERSATION
      // ======================================

      await connection
        .beginTransaction();

      transactionStarted =
        true;

      const [conversationResult] =
        await connection.query(
          `
          INSERT INTO conversations
          (
            conversation_type,
            created_by
          )
          VALUES
          (
            'private',
            ?
          )
          RETURNING id
          `,
          [
            currentUserId,
          ]
        );

      const conversationId =
        conversationResult[0].id;

      await connection.query(
        `
        INSERT INTO conversation_members
        (
          conversation_id,
          user_id
        )
        VALUES
          (?, ?),
          (?, ?)
        `,
        [
          conversationId,
          currentUserId,

          conversationId,
          targetUserId,
        ]
      );

      await connection.commit();

      transactionStarted =
        false;

      // Notify target user that
      // conversation list changed.

      const io =
        req.app.get(
          "io"
        );

      if (io) {
        io
          .to(
            currentUserRoom(targetUserId)
          )
          .emit(
            "conversation:updated",
            {
              conversationId,
            }
          );
      }

      return res.status(201).json({
        success: true,

        conversationId,

        created: true,
      });

    } catch (error) {
      if (
        transactionStarted
      ) {
        try {
          await connection
            .rollback();
        } catch (
          rollbackError
        ) {
          console.error(
            "Private Chat Rollback Error:",
            rollbackError
          );
        }
      }

      console.error(
        "Create Private Conversation Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to create conversation",
      });

    } finally {
      connection.release();
    }
  };

// ==========================================
// CREATE GROUP CONVERSATION
// ==========================================

const createGroupConversation =
  async (req, res) => {
    const connection =
      await pool.getConnection();

    let transactionStarted =
      false;

    try {
      const currentUserId =
        Number(
          req.user.id
        );

      const {
        name,
        memberIds,
      } = req.body;

      // ======================================
      // VALIDATE GROUP NAME
      // ======================================

      const groupName =
        String(
          name || ""
        )
          .trim()
          .slice(
            0,
            150
          );

      if (
        groupName.length <
        2
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Group name must contain at least 2 characters",
        });
      }

      // ======================================
      // VALIDATE MEMBERS
      // ======================================

      if (
        !Array.isArray(
          memberIds
        )
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Please select group members",
        });
      }

      // Convert IDs to numbers,
      // remove invalid IDs,
      // remove duplicates,
      // remove current user because
      // creator is automatically included.

      const selectedMemberIds =
        [
          ...new Set(
            memberIds
              .map(
                Number
              )
              .filter(
                (
                  id
                ) =>
                  Number.isInteger(
                    id
                  ) &&
                  id > 0 &&
                  id !==
                    currentUserId
              )
          ),
        ];

      if (
        selectedMemberIds
          .length < 1
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Select at least one other member for the group",
        });
      }

      // Prevent extremely large
      // accidental group creation.

      if (
        selectedMemberIds
          .length > 1000
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Too many group members selected",
        });
      }

      // ======================================
      // VERIFY ALL SELECTED USERS
      // ======================================

      const placeholders =
        selectedMemberIds
          .map(
            () => "?"
          )
          .join(
            ","
          );

      const [validUsers] =
        await connection.query(
          `
          SELECT
            id,
            employee_id,
            full_name,
            role
          FROM users
          WHERE
            id IN (${placeholders})
            AND
            status = 'active'
          `,
          selectedMemberIds
        );

      if (
        validUsers.length !==
        selectedMemberIds.length
      ) {
        return res.status(400).json({
          success: false,

          message:
            "One or more selected users are invalid or inactive",
        });
      }

      // ======================================
      // CREATE GROUP
      // ======================================

      await connection
        .beginTransaction();

      transactionStarted =
        true;

      const [conversationResult] =
        await connection.query(
          `
          INSERT INTO conversations
          (
            conversation_type,
            name,
            created_by
          )
          VALUES
          (
            'group',
            ?,
            ?
          )
          RETURNING id
          `,
          [
            groupName,
            currentUserId,
          ]
        );

      const conversationId =
        conversationResult[0].id;

      // Creator + selected members

      const allMemberIds =
        [
          currentUserId,
          ...selectedMemberIds,
        ];

      const memberValues =
        allMemberIds.map(
          (
            userId
          ) => [
            conversationId,
            userId,
          ]
        );

      const memberValuePlaceholders =
        memberValues
          .map(() => "(?, ?)")
          .join(", ");

      await connection.query(
        `
        INSERT INTO conversation_members
        (
          conversation_id,
          user_id
        )
        VALUES ${memberValuePlaceholders}
        `,
        memberValues.flat()
      );

      await connection.commit();

      transactionStarted =
        false;

      // ======================================
      // REAL-TIME GROUP NOTIFICATION
      // ======================================

      const io =
        req.app.get(
          "io"
        );

      if (io) {
        allMemberIds.forEach(
          (
            userId
          ) => {
            io
              .to(
                currentUserRoom(userId)
              )
              .emit(
                "conversation:updated",
                {
                  conversationId,

                  conversationType:
                    "group",

                  name:
                    groupName,
                }
              );
          }
        );
      }

      return res.status(201).json({
        success: true,

        message:
          "Group created successfully",

        conversation: {
          id:
            conversationId,

          conversation_type:
            "group",

          name:
            groupName,

          created_by:
            currentUserId,

          member_count:
            allMemberIds.length,
        },
      });

    } catch (error) {
      if (
        transactionStarted
      ) {
        try {
          await connection
            .rollback();
        } catch (
          rollbackError
        ) {
          console.error(
            "Group Rollback Error:",
            rollbackError
          );
        }
      }

      console.error(
        "Create Group Conversation Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to create group",
      });

    } finally {
      connection.release();
    }
  };

// ==========================================
// GET MY CONVERSATIONS
// SUPPORTS PRIVATE + GROUP
// ==========================================

const getMyConversations =
  async (req, res) => {
    try {
      const currentUserId =
        req.user.id;

      const [conversations] =
        await pool.query(
          `
          SELECT
            c.id,

            c.conversation_type,

            c.name,

            c.created_by,

            c.created_at,

            c.updated_at,

            CASE
              WHEN
                c.conversation_type =
                'private'
              THEN
                (
                  SELECT
                    u.id
                  FROM conversation_members cm_other

                  INNER JOIN users u
                    ON
                      u.id =
                        cm_other.user_id

                  WHERE
                    cm_other.conversation_id =
                      c.id

                    AND
                    cm_other.user_id != ?

                  LIMIT 1
                )

              ELSE NULL
            END
              AS other_user_id,

            CASE
              WHEN
                c.conversation_type =
                'private'
              THEN
                (
                  SELECT
                    u.employee_id
                  FROM conversation_members cm_other

                  INNER JOIN users u
                    ON
                      u.id =
                        cm_other.user_id

                  WHERE
                    cm_other.conversation_id =
                      c.id

                    AND
                    cm_other.user_id != ?

                  LIMIT 1
                )

              ELSE NULL
            END
              AS other_employee_id,

            CASE
              WHEN
                c.conversation_type =
                'private'
              THEN
                (
                  SELECT
                    u.full_name
                  FROM conversation_members cm_other

                  INNER JOIN users u
                    ON
                      u.id =
                        cm_other.user_id

                  WHERE
                    cm_other.conversation_id =
                      c.id

                    AND
                    cm_other.user_id != ?

                  LIMIT 1
                )

              ELSE NULL
            END
              AS other_user_name,

            CASE
              WHEN
                c.conversation_type =
                'private'
              THEN
                (
                  SELECT
                    u.role
                  FROM conversation_members cm_other

                  INNER JOIN users u
                    ON
                      u.id =
                        cm_other.user_id

                  WHERE
                    cm_other.conversation_id =
                      c.id

                    AND
                    cm_other.user_id != ?

                  LIMIT 1
                )

              ELSE NULL
            END
              AS other_user_role,

            (
              SELECT
                COUNT(*)
              FROM conversation_members cm_count
              WHERE
                cm_count.conversation_id =
                  c.id
            )
              AS member_count,

            (
              SELECT
                m.message_text
              FROM messages m
              WHERE
                m.conversation_id =
                  c.id

                AND
                m.is_deleted =
                  FALSE

              ORDER BY
                m.created_at DESC,
                m.id DESC

              LIMIT 1
            )
              AS last_message,

            (
              SELECT
                u.full_name

              FROM messages m

              INNER JOIN users u
                ON
                  u.id =
                    m.sender_id

              WHERE
                m.conversation_id =
                  c.id

                AND
                m.is_deleted =
                  FALSE

              ORDER BY
                m.created_at DESC,
                m.id DESC

              LIMIT 1
            )
              AS last_message_sender,

            (
              SELECT
                m.created_at
              FROM messages m
              WHERE
                m.conversation_id =
                  c.id

                AND
                m.is_deleted =
                  FALSE

              ORDER BY
                m.created_at DESC,
                m.id DESC

              LIMIT 1
            )
              AS last_message_at,

            (
              SELECT
                COUNT(*)

              FROM messages m

              WHERE
                m.conversation_id =
                  c.id

                AND
                m.sender_id != ?

                AND
                m.is_deleted =
                  FALSE

                AND
                (
                  my_member.last_read_at
                    IS NULL

                  OR

                  m.created_at >
                    my_member.last_read_at
                )
            )
              AS unread_count

          FROM conversations c

          INNER JOIN conversation_members my_member
            ON
              my_member.conversation_id =
                c.id

              AND
              my_member.user_id =
                ?

          ORDER BY
            COALESCE(
              last_message_at,
              c.updated_at
            ) DESC,

            c.id DESC
          `,
          [
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
            currentUserId,
          ]
        );

      // member_count/unread_count are bigint (COUNT(*)) -- pg
      // returns them as strings.
      const normalizedConversations = conversations.map((c) => ({
        ...c,
        member_count: Number(c.member_count),
        unread_count: Number(c.unread_count),
      }));

      return res.status(200).json({
        success: true,

        conversations: normalizedConversations,
      });

    } catch (error) {
      console.error(
        "Get Conversations Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to load conversations",
      });
    }
  };

// ==========================================
// GET CONVERSATION MEMBERS
// ==========================================

const getConversationMembers =
  async (req, res) => {
    try {
      const currentUserId =
        req.user.id;

      const conversationId =
        Number(
          req.params
            .conversationId
        );

      if (
        !Number.isInteger(
          conversationId
        ) ||
        conversationId <= 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Invalid conversation ID",
        });
      }

      // Verify requesting user
      // belongs to conversation.

      const [membership] =
        await pool.query(
          `
          SELECT id
          FROM conversation_members
          WHERE
            conversation_id = ?
            AND
            user_id = ?
          LIMIT 1
          `,
          [
            conversationId,
            currentUserId,
          ]
        );

      if (
        membership.length ===
        0
      ) {
        return res.status(403).json({
          success: false,

          message:
            "You do not have access to this conversation",
        });
      }

      const [members] =
        await pool.query(
          `
          SELECT
            u.id,
            u.employee_id,
            u.full_name,
            u.email,
            u.role,

            cm.joined_at

          FROM conversation_members cm

          INNER JOIN users u
            ON
              u.id =
                cm.user_id

          WHERE
            cm.conversation_id = ?

          ORDER BY
            u.full_name ASC
          `,
          [
            conversationId,
          ]
        );

      return res.status(200).json({
        success: true,

        members,
      });

    } catch (error) {
      console.error(
        "Get Conversation Members Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to load conversation members",
      });
    }
  };

// ==========================================
// GET CONVERSATION MESSAGES
// PAGINATED
// ==========================================

const getMessages =
  async (req, res) => {
    try {
      const currentUserId =
        req.user.id;

      const conversationId =
        Number(
          req.params
            .conversationId
        );

      let page =
        Number(
          req.query.page
        ) || 1;

      let limit =
        Number(
          req.query.limit
        ) || 30;

      if (
        !Number.isInteger(
          conversationId
        ) ||
        conversationId <= 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Invalid conversation ID",
        });
      }

      if (
        !Number.isInteger(
          page
        ) ||
        page < 1
      ) {
        page = 1;
      }

      if (
        !Number.isInteger(
          limit
        ) ||
        limit < 1
      ) {
        limit = 30;
      }

      if (
        limit > 100
      ) {
        limit = 100;
      }

      const offset =
        (page - 1) *
        limit;

      // ======================================
      // CHECK MEMBERSHIP
      // ======================================

      const [members] =
        await pool.query(
          `
          SELECT id
          FROM conversation_members
          WHERE
            conversation_id = ?
            AND
            user_id = ?
          LIMIT 1
          `,
          [
            conversationId,
            currentUserId,
          ]
        );

      if (
        members.length ===
        0
      ) {
        return res.status(403).json({
          success: false,

          message:
            "You do not have access to this conversation",
        });
      }

      // ======================================
      // LOAD MESSAGES
      // ======================================

      const [messages] =
        await pool.query(
          `
          SELECT
    m.id,

    m.conversation_id,

    m.sender_id,

    m.message_text,

    m.message_type,

    m.is_deleted,

    m.created_at,

    u.employee_id,

    u.full_name AS sender_name,

    u.role AS sender_role,

ca.original_name AS file_name,
ca.file_path AS image,
ca.file_type AS mime_type,

    ca.file_size

FROM messages m

INNER JOIN users u
    ON u.id = m.sender_id

LEFT JOIN chat_attachments ca
    ON ca.message_id = m.id

WHERE
    m.conversation_id = ?

ORDER BY
    m.created_at DESC,
    m.id DESC

LIMIT ?
OFFSET ?
          `,
          [
            conversationId,
            limit,
            offset,
          ]
        );

      messages.reverse();

      return res.status(200).json({
        success: true,

        page,

        limit,

        messages,
      });

    } catch (error) {
      console.error(
        "Get Messages Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to load messages",
      });
    }
  };

// ==========================================
// CHAT MESSAGE NOTIFICATIONS
//
// Called once per saved message (text or
// attachment) from both sendMessage and
// uploadChatImage below — one shared place so
// the two flows can never drift or double-fire.
//
// Recipients come ONLY from conversation_members
// (never trusted from the client). The sender is
// always excluded. A member whose socket is
// currently in the conversation:<id> room (i.e.
// they already have that conversation open — the
// same room conversation:join/leave in app.js
// already maintains) is also excluded, since the
// message is already visible to them live.
//
// Applies to BOTH group and private (1-to-1)
// conversations — the membership query below is
// generic, so a private conversation's two
// members minus the sender naturally resolves to
// exactly the other participant.
//
// Reuses the existing notifications table and the
// existing notification:new socket convention
// (see taskActivityService.js's task-mention
// notifications) rather than inventing a second
// notification system.
// ==========================================

const sendChatMessageNotifications = async ({
  io,
  conversationId,
  senderId,
  senderName,
  message,
}) => {

  if (!io) return;

  try {

    const [conversationRows] = await pool.query(
      `SELECT conversation_type, name FROM conversations WHERE id = ? LIMIT 1`,
      [conversationId]
    );

    const conversation = conversationRows[0];

    if (!conversation) return;

    // conversationName is only meaningful for a group (private
    // conversations aren't named) — this alone is what the frontend
    // toast/notification uses to tell the two apart (see
    // ChatNotificationListener.jsx), no separate "is this a group"
    // flag needed in the payload.

    const conversationName =
      conversation.conversation_type === "group"
        ? conversation.name
        : null;

    // Recipients: every OTHER member of this exact conversation,
    // straight from conversation_members — never trusted from the
    // client. This is intentionally generic across both conversation
    // types: for a group that's every other member (N-1 recipients);
    // for a private conversation it's exactly the one other
    // participant (2 members - the sender = 1 recipient). No
    // type-specific branching is needed here.

    const [members] = await pool.query(
      `SELECT user_id FROM conversation_members WHERE conversation_id = ?`,
      [conversationId]
    );

    let preview;

    if (message.message_type === "image") {

      preview = "📷 Sent an image";

    } else if (message.message_type === "file") {

      const mimeType = message.mime_type || "";

      preview =
        mimeType === "application/pdf"
          ? "📄 Sent a PDF"
          : mimeType.startsWith("video/")
            ? "🎥 Sent a video"
            : "📎 Sent an attachment";

    } else {

      const text = (message.message_text || "").trim();

      preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;

    }

    const title = conversationName
      ? `${senderName} in ${conversationName}`
      : senderName;

    // Who currently has this exact conversation open right now,
    // across any of their tabs/devices — read live from the
    // Socket.IO room adapter, same technique already used for
    // meeting room presence (getMeetingRoomParticipants).

    const viewerSocketIds = io.sockets.adapter.rooms.get(currentConversationRoom(conversationId));

    const viewingUserIds = new Set();

    if (viewerSocketIds) {

      viewerSocketIds.forEach((socketId) => {

        const viewerSocket = io.sockets.sockets.get(socketId);

        if (viewerSocket?.user) {
          viewingUserIds.add(Number(viewerSocket.user.id));
        }

      });

    }

    for (const member of members) {

      const memberId = Number(member.user_id);

      if (memberId === Number(senderId)) continue;

      if (viewingUserIds.has(memberId)) continue;

      await createNotification({
        io,
        userId: memberId,
        title,
        message: preview,
        type: "chat_message",
        referenceType: "conversation",
        referenceId: conversationId,
        extraSocketFields: { senderName, conversationName, preview },
      });

    }

  } catch (error) {
    console.error("Chat Notification Error:", error);
  }

};

// ==========================================
// SEND MESSAGE
// PRIVATE + GROUP
// ==========================================

const sendMessage =
  async (req, res) => {
    try {
      const currentUserId =
        req.user.id;

      const conversationId =
        Number(
          req.params
            .conversationId
        );

      const {
        message,
      } = req.body;

      if (
        !Number.isInteger(
          conversationId
        ) ||
        conversationId <= 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Invalid conversation ID",
        });
      }

      if (
        typeof message !==
          "string" ||
        !message.trim()
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Message cannot be empty",
        });
      }

      const cleanMessage =
        message
          .trim()
          .slice(
            0,
            5000
          );

      // ======================================
      // CHECK MEMBERSHIP
      // ======================================

      const [members] =
        await pool.query(
          `
          SELECT id
          FROM conversation_members
          WHERE
            conversation_id = ?
            AND
            user_id = ?
          LIMIT 1
          `,
          [
            conversationId,
            currentUserId,
          ]
        );

      if (
        members.length ===
        0
      ) {
        return res.status(403).json({
          success: false,

          message:
            "You do not have access to this conversation",
        });
      }

      // ======================================
      // SAVE MESSAGE
      // ======================================

      const [result] =
        await pool.query(
          `
          INSERT INTO messages
          (
            conversation_id,
            sender_id,
            message_text,
            message_type
          )
          VALUES
          (
            ?,
            ?,
            ?,
            'text'
          )
          RETURNING id
          `,
          [
            conversationId,
            currentUserId,
            cleanMessage,
          ]
        );

      await pool.query(
        `
        UPDATE conversations
        SET
          updated_at =
            CURRENT_TIMESTAMP
        WHERE
          id = ?
        `,
        [
          conversationId,
        ]
      );

      // ======================================
      // GET SAVED MESSAGE
      // ======================================

      const [savedMessages] =
        await pool.query(
          `
          SELECT
            m.id,

            m.conversation_id,

            m.sender_id,

            m.message_text,

            m.message_type,

            m.is_deleted,

            m.created_at,

            u.employee_id,

            u.full_name
              AS sender_name,

            u.role
              AS sender_role

          FROM messages m

          INNER JOIN users u
            ON
              u.id =
                m.sender_id

          WHERE
            m.id = ?

          LIMIT 1
          `,
          [
            result[0].id,
          ]
        );

      const savedMessage =
        savedMessages[0];

      // ======================================
      // REAL-TIME DELIVERY
      // ======================================

      const io =
        req.app.get(
          "io"
        );

      if (io) {
        // Users actively viewing this
        // conversation receive message.

        io
          .to(
            currentConversationRoom(conversationId)
          )
          .emit(
            "message:new",
            savedMessage
          );

        // Notify every other member,
        // including all group members.

        const [conversationMembers] =
          await pool.query(
            `
            SELECT
              user_id
            FROM conversation_members
            WHERE
              conversation_id = ?
            `,
            [
              conversationId,
            ]
          );

        conversationMembers.forEach(
          (
            member
          ) => {
            if (
              Number(
                member.user_id
              ) !==
              Number(
                currentUserId
              )
            ) {
              io
                .to(
                  currentUserRoom(member.user_id)
                )
                .emit(
                  "conversation:updated",
                  {
                    conversationId,

                    message:
                      savedMessage,
                  }
                );
            }
          }
        );

        await sendChatMessageNotifications({
          io,
          conversationId,
          senderId: currentUserId,
          senderName: savedMessage.sender_name,
          message: savedMessage,
        });

      }

      return res.status(201).json({
        success: true,

        message:
          savedMessage,
      });

    } catch (error) {
      console.error(
        "Send Message Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to send message",
      });
    }
  };
// ==========================================
// UPLOAD CHAT IMAGE
// ==========================================

const uploadChatImage = async (req, res) => {
  try {
    const currentUserId = req.user.id;

    const conversationId = Number(
      req.params.conversationId
    );

    if (
      !Number.isInteger(conversationId) ||
      conversationId <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid conversation ID",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
       message: "Please select a file.",
      });
    }

    // Check membership
    const [members] = await pool.query(
      `
      SELECT id
      FROM conversation_members
      WHERE
        conversation_id = ?
        AND
        user_id = ?
      LIMIT 1
      `,
      [
        conversationId,
        currentUserId,
      ]
    );

    if (members.length === 0) {
      return res.status(403).json({
        success: false,
        message:
          "You do not have access to this conversation",
      });
    }

const isImage =
  req.file.mimetype.startsWith("image/");

const filePath = isImage
  ? tenantUploadUrlPath("chat/images", req.file.filename)
  : tenantUploadUrlPath("chat/files", req.file.filename);

const messageType = isImage
  ? "image"
  : "file";
    // Save image message
    const [messageResult] =
      await pool.query(
        `
        INSERT INTO messages
        (
          conversation_id,
          sender_id,
          message_text,
          message_type
        )
        VALUES
        (
          ?,
          ?,
        '',
?
        )
        RETURNING id
        `,
[
  conversationId,
  currentUserId,
  messageType,
]
      );

    // Save attachment
await pool.query(`
INSERT INTO chat_attachments
(
    message_id,
    original_name,
    stored_name,
    file_type,
    file_size,
    file_path,
    uploaded_by
)
VALUES (?, ?, ?, ?, ?, ?, ?)
`, [
    messageResult[0].id,
    req.file.originalname,
    req.file.filename,
    req.file.mimetype,
    req.file.size,
    filePath,
    currentUserId
]);

    // Update conversation
    await pool.query(
      `
      UPDATE conversations
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      `,
      [conversationId]
    );

    // Load saved message
    const [savedMessages] =
      await pool.query(
        `
        SELECT
          m.id,
          m.conversation_id,
          m.sender_id,
          m.message_text,
          m.message_type,
          m.created_at,
          u.employee_id,
          u.full_name AS sender_name,
          u.role AS sender_role
        FROM messages m
        INNER JOIN users u
          ON u.id = m.sender_id
        WHERE m.id = ?
        LIMIT 1
        `,
        [
          messageResult[0].id,
        ]
      );

    const message =
      savedMessages[0];

if (isImage) {
  message.image = filePath;
} if (isImage) {
  message.image = filePath;
} else {
  message.image = filePath;
  message.file_name = req.file.originalname;
  message.mime_type = req.file.mimetype;
  message.file_size = req.file.size;
}

    const io =
      req.app.get("io");

    if (io) {

      // Socket.IO emits bypass res.json (and therefore
      // signFileUrlsMiddleware entirely) -- this is the one path
      // that must sign its own file URL explicitly, using the same
      // signFileUrl() the middleware uses internally. The `message`
      // object returned via res.json(...) below is deliberately left
      // with the PLAIN path -- the middleware signs that copy on its
      // way out, so signing is never done twice for the same value.
      const signedMessageForSocket = message.image
        ? { ...message, image: signFileUrl(message.image, getCurrentCompanySlug()) }
        : message;

      io.to(
        currentConversationRoom(conversationId)
      ).emit(
        "message:new",
        signedMessageForSocket
      );

      await sendChatMessageNotifications({
        io,
        conversationId,
        senderId: currentUserId,
        senderName: message.sender_name,
        message: signedMessageForSocket,
      });

    }

    return res.status(201).json({
      success: true,
      message,
    });

  } catch (error) {
    console.error(
      "Upload Image Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Unable to upload image",
    });
  }
};
// ==========================================
// MARK CONVERSATION AS READ
// ==========================================

const markConversationRead =
  async (req, res) => {
    try {
      const currentUserId =
        req.user.id;

      const conversationId =
        Number(
          req.params
            .conversationId
        );

      if (
        !Number.isInteger(
          conversationId
        ) ||
        conversationId <= 0
      ) {
        return res.status(400).json({
          success: false,

          message:
            "Invalid conversation ID",
        });
      }

      const [result] =
        await pool.query(
          `
          UPDATE conversation_members

          SET
            last_read_at =
              CURRENT_TIMESTAMP

          WHERE
            conversation_id = ?
            AND
            user_id = ?
          `,
          [
            conversationId,
            currentUserId,
          ]
        );

      if (
        result.affectedRows ===
        0
      ) {
        return res.status(403).json({
          success: false,

          message:
            "You do not have access to this conversation",
        });
      }

      return res.status(200).json({
        success: true,

        message:
          "Conversation marked as read",
      });

    } catch (error) {
      console.error(
        "Mark Conversation Read Error:",
        error
      );

      return res.status(500).json({
        success: false,

        message:
          "Unable to update conversation",
      });
    }
  };

// ==========================================
// EXPORTS
// ==========================================

module.exports = {
  getChatUsers,

  createPrivateConversation,
  uploadChatImage,
  createGroupConversation,

  getMyConversations,

  getConversationMembers,

  getMessages,

  sendMessage,

  markConversationRead,
};