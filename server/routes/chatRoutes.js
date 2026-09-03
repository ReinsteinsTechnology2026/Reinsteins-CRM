const express =
  require("express");

const {
  getChatUsers,
  createPrivateConversation,
  createGroupConversation,
  getMyConversations,
  getConversationMembers,
  getMessages,
  sendMessage,
  markConversationRead,
  uploadChatImage,
} = require(
  "../controllers/chatController"
);

const {
  protect,
} = require(
  "../middleware/authMiddleware"
);

const chatUpload =
  require(
    "../middleware/chatUploadMiddleware"
  );

const router =
  express.Router();

// ==========================================
// ALL CHAT ROUTES REQUIRE LOGIN
// ==========================================

router.use(
  protect
);

// ==========================================
// GET USERS AVAILABLE FOR CHAT
// ==========================================

router.get(
  "/users",
  getChatUsers
);

// ==========================================
// GET MY CONVERSATIONS
// ==========================================

router.get(
  "/conversations",
  getMyConversations
);

// ==========================================
// CREATE OR OPEN PRIVATE CONVERSATION
// ==========================================

router.post(
  "/conversations/private",
  createPrivateConversation
);

// ==========================================
// CREATE GROUP CONVERSATION
// ==========================================

router.post(
  "/conversations/group",
  createGroupConversation
);

// ==========================================
// GET CONVERSATION MEMBERS
// ==========================================

router.get(
  "/conversations/:conversationId/members",
  getConversationMembers
);

// ==========================================
// GET CONVERSATION MESSAGES
// ==========================================

router.get(
  "/conversations/:conversationId/messages",
  getMessages
);

// ==========================================
// SEND NORMAL TEXT MESSAGE
// ==========================================

router.post(
  "/conversations/:conversationId/messages",
  sendMessage
);

// ==========================================
// UPLOAD IMAGE
// ==========================================

router.post(
  "/conversations/:conversationId/upload-image",
  chatUpload.single(
    "image"
  ),
  uploadChatImage
);

// ==========================================
// MARK CONVERSATION AS READ
// ==========================================

router.put(
  "/conversations/:conversationId/read",
  markConversationRead
);

// ==========================================
// EXPORT
// ==========================================

module.exports =
  router;