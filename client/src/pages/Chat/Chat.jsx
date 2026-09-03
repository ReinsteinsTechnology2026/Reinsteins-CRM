import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  FaSearch,
  FaPaperPlane,
  FaComments,
  FaCircle,
  FaUserPlus,
  FaUsers,
  FaPlus,
  FaTimes,
  FaCheck,
  FaPhone,
  FaVideo,
    FaMusic,
  FaPhoneSlash,
  FaMicrophone,
  FaMicrophoneSlash,
  FaVideoSlash,
   FaMagic,
   FaGlobe,
  FaFileAlt, 
  FaImage,
  FaExpand,
  FaRegImage,
  FaRegFileAlt,
} from "react-icons/fa";
import api from "../../services/api";

import socket, {
  connectSocket,
} from "../../services/socket";

import {
  createPeerConnection,
  getLocalStream,
  addLocalStream,
  createOffer,
  handleOffer,
  handleAnswer,
  handleIceCandidate,
  toggleMicrophone,
  toggleCamera,
  cleanupCall,
} from "../../services/callService";




import FileUpload from "./Features/FileUpload/FileUpload";

import "./Chat.css";
import ImageViewer from "./Features/ImageViewer";
import useImagePaste from "./Features/ImagePaste";
import DragDrop from "./Features/DragDrop";
import AttachmentPreview from "./Features/AttachmentPreview";


function Chat() {

  const location = useLocation();

  const navigate = useNavigate();

  // ==========================================
  // LOGGED-IN USER
  // ==========================================

  const storedUser =
    sessionStorage.getItem(
      "user"
    );

  const currentUser =
    useMemo(() => {
      try {
        return storedUser
          ? JSON.parse(
              storedUser
            )
          : null;
      } catch {
        return null;
      }
    }, [storedUser]);

  const isAdmin =
    currentUser?.role ===
    "admin";

  // ==========================================
  // CHAT STATE
  // ==========================================

  const [
    users,
    setUsers,
  ] = useState([]);

  const [
    conversations,
    setConversations,
  ] = useState([]);

  const [
    selectedConversation,
    setSelectedConversation,
  ] = useState(null);

  const [
    messages,
    setMessages,
  ] = useState([]);

  const [
    messageText,
    setMessageText,
  ] = useState("");

  const [
    search,
    setSearch,
  ] = useState("");

  const [
    onlineUsers,
    setOnlineUsers,
  ] = useState([]);

  const [
    loadingConversations,
    setLoadingConversations,
  ] = useState(true);

  const [
    loadingMessages,
    setLoadingMessages,
  ] = useState(false);

  const [
    sending,
    setSending,
  ] = useState(false);
  const [
  uploadingImage,
  setUploadingImage,
] = useState(false);

const [
  previewImage,
  setPreviewImage,
] = useState(null);
const [attachments, setAttachments] = useState([]);



  const imageInputRef = useRef(null);
  const documentInputRef = useRef(null);

const uploadImage = async (event) => {
  try {
    const file = event.target.files?.[0];

    if (!file || !selectedConversation) {
      return;
    }

    const formData = new FormData();
    formData.append("image", file);

    setUploadingImage(true);

    const response = await api.post(
      `/chat/conversations/${selectedConversation.id}/upload-image`,
      formData,
      {
        headers: {
          "Content-Type": "multipart/form-data",
        },
      }
    );

    const uploadedMessage = response.data?.message;

    if (uploadedMessage) {
      setMessages((current) => {
        const exists = current.some(
          (msg) => Number(msg.id) === Number(uploadedMessage.id)
        );

        if (exists) return current;

        return [...current, uploadedMessage];
      });

      scrollToBottom();
    }

    await loadConversations();

  } catch (error) {
    console.error("Upload Image Error:", error);

  } finally {
    setUploadingImage(false);

    event.target.value = "";
  }
};



const removeAttachment = (id) => {
  setAttachments((current) =>
    current.filter((attachment) => attachment.id !== id)
  );
};



const addAttachments = (files) => {
  console.log("Selected files:", files);

  const newAttachments = Array.from(files).map((file) => {
    const isImage = file.type.startsWith("image/");

    return {
      id: crypto.randomUUID(),
      file,
      preview: isImage
        ? URL.createObjectURL(file)
        : null,
      isImage,
    };
  });

  console.log("Attachments:", newAttachments);

  setAttachments((current) => [
    ...current,
    ...newAttachments,
  ]);
};
useImagePaste(addAttachments);

// ==========================================
// GROUP CREATION STATE
// ==========================================
  // ==========================================
  // GROUP CREATION STATE
  // ==========================================

  const [
    showGroupModal,
    setShowGroupModal,
  ] = useState(false);
const [showAttachmentMenu, setShowAttachmentMenu] = useState(false);
  const [
    groupName,
    setGroupName,
  ] = useState("");

  const [
    groupSearch,
    setGroupSearch,
  ] = useState("");

  const [
    selectedMembers,
    setSelectedMembers,
  ] = useState([]);

  const [
    creatingGroup,
    setCreatingGroup,
  ] = useState(false);

  const [
    groupError,
    setGroupError,
  ] = useState("");

  // ==========================================
  // CALL STATE
  // ==========================================

  const [
    incomingCall,
    setIncomingCall,
  ] = useState(null);

  const [
    activeCall,
    setActiveCall,
  ] = useState(null);

  const [
    callStatus,
    setCallStatus,
  ] = useState("idle");

  const [
    localMediaStream,
    setLocalMediaStream,
  ] = useState(null);

  const [
    remoteMediaStream,
    setRemoteMediaStream,
  ] = useState(null);

  const [
    microphoneEnabled,
    setMicrophoneEnabled,
  ] = useState(true);

  const [
    cameraEnabled,
    setCameraEnabled,
  ] = useState(true);

  const [
    callError,
    setCallError,
  ] = useState("");

  // ==========================================
  // REFS
  // ==========================================

  const messagesEndRef =
    useRef(null);

  const selectedConversationRef =
    useRef(null);

  const localVideoRef =
    useRef(null);

  const remoteVideoRef =
    useRef(null);

  const activeCallRef =
    useRef(null);

  const incomingCallRef =
    useRef(null);

  // ==========================================
  // KEEP REFS UPDATED
  // ==========================================

  useEffect(() => {
    selectedConversationRef.current =
      selectedConversation;
  }, [selectedConversation]);

  useEffect(() => {
    activeCallRef.current =
      activeCall;
  }, [activeCall]);

  useEffect(() => {
    incomingCallRef.current =
      incomingCall;
  }, [incomingCall]);

  // ==========================================
  // ATTACH LOCAL STREAM TO VIDEO
  // ==========================================

  useEffect(() => {
    if (
      localVideoRef.current &&
      localMediaStream
    ) {
      localVideoRef.current.srcObject =
        localMediaStream;
    }
  }, [
    localMediaStream,
    callStatus,
  ]);

  // ==========================================
  // ATTACH REMOTE STREAM TO VIDEO / AUDIO
  // ==========================================

  useEffect(() => {
    if (
      remoteVideoRef.current &&
      remoteMediaStream
    ) {
      remoteVideoRef.current.srcObject =
        remoteMediaStream;

      remoteVideoRef.current
        .play()
        .catch(
          () => {}
        );
    }
  }, [
    remoteMediaStream,
    callStatus,
  ]);

  // ==========================================
  // HELPERS
  // ==========================================

  const isGroupConversation =
    (conversation) =>
      conversation
        ?.conversation_type ===
      "group";

  const getConversationName =
    (conversation) => {
      if (
        !conversation
      ) {
        return "Conversation";
      }

      if (
        isGroupConversation(
          conversation
        )
      ) {
        return (
          conversation.name ||
          "Group"
        );
      }

      return (
        conversation
          .other_user_name ||
        "User"
      );
    };

  const getConversationInitial =
    (conversation) => {
      const name =
        getConversationName(
          conversation
        );

      return (
        name
          ?.charAt(0)
          ?.toUpperCase() ||
        "C"
      );
    };

  // ==========================================
  // SCROLL TO BOTTOM
  // ==========================================

  const scrollToBottom =
    () => {
      setTimeout(() => {
        messagesEndRef.current
          ?.scrollIntoView({
            behavior:
              "smooth",
          });
      }, 50);
    };

  // ==========================================
  // LOAD CHAT USERS
  // ==========================================

  const loadUsers =
    async () => {
      try {
        const response =
          await api.get(
            "/chat/users"
          );

        setUsers(
          response.data
            ?.users ||
            []
        );
      } catch (error) {
        console.error(
          "Load Chat Users Error:",
          error
        );
      }
    };

  // ==========================================
  // LOAD CONVERSATIONS
  // ==========================================

  const loadConversations =
    async () => {
      try {
        setLoadingConversations(
          true
        );

        const response =
          await api.get(
            "/chat/conversations"
          );

        const conversationList =
          response.data
            ?.conversations ||
          [];

        setConversations(
          conversationList
        );

        return conversationList;

      } catch (error) {
        console.error(
          "Load Conversations Error:",
          error
        );

        return [];

      } finally {
        setLoadingConversations(
          false
        );
      }
    };

  // ==========================================
  // LOAD MESSAGES
  // ==========================================

  const loadMessages =
    async (
      conversation
    ) => {
      try {
        setLoadingMessages(
          true
        );

        const response =
          await api.get(
            `/chat/conversations/${conversation.id}/messages?limit=50`
          );

        setMessages(
          response.data
            ?.messages ||
            []
        );

        await api.put(
          `/chat/conversations/${conversation.id}/read`
        );

        setConversations(
          (current) =>
            current.map(
              (item) =>
                Number(
                  item.id
                ) ===
                Number(
                  conversation.id
                )
                  ? {
                      ...item,
                      unread_count:
                        0,
                    }
                  : item
            )
        );

        scrollToBottom();

      } catch (error) {
        console.error(
          "Load Messages Error:",
          error
        );

      } finally {
        setLoadingMessages(
          false
        );
      }
    };

  // ==========================================
  // SELECT CONVERSATION
  // ==========================================

  const selectConversation =
    async (
      conversation
    ) => {
      const previous =
        selectedConversationRef
          .current;

      if (
        previous?.id
      ) {
        socket.emit(
          "conversation:leave",
          previous.id
        );
      }

      setSelectedConversation(
        conversation
      );

      selectedConversationRef.current =
        conversation;

      setMessages([]);

      socket.emit(
        "conversation:join",
        conversation.id
      );

      await loadMessages(
        conversation
      );
    };

  // ==========================================
  // START PRIVATE CHAT
  // ==========================================

  const startPrivateChat =
    async (
      user
    ) => {
      try {
        const response =
          await api.post(
            "/chat/conversations/private",
            {
              userId:
                user.id,
            }
          );

        const conversationId =
          response.data
            .conversationId;

        const updatedConversations =
          await loadConversations();

        const existingConversation =
          updatedConversations.find(
            (conversation) =>
              Number(
                conversation.id
              ) ===
              Number(
                conversationId
              )
          );

        const conversation =
          existingConversation ||
          {
            id:
              conversationId,

            conversation_type:
              "private",

            other_user_id:
              user.id,

            other_employee_id:
              user.employee_id,

            other_user_name:
              user.full_name,

            other_user_role:
              user.role,

            unread_count:
              0,
          };

        await selectConversation(
          conversation
        );

      } catch (error) {
        console.error(
          "Start Chat Error:",
          error
        );
      }
    };

  // ==========================================
  // OPEN GROUP MODAL
  // ==========================================

  const openGroupModal =
    () => {
      setGroupName("");
      setGroupSearch("");
      setSelectedMembers([]);
      setGroupError("");
      setShowGroupModal(
        true
      );
    };

  // ==========================================
  // CLOSE GROUP MODAL
  // ==========================================

  const closeGroupModal =
    () => {
      if (
        creatingGroup
      ) {
        return;
      }

      setShowGroupModal(
        false
      );

      setGroupName("");
      setGroupSearch("");
      setSelectedMembers([]);
      setGroupError("");
    };

  // ==========================================
  // TOGGLE GROUP MEMBER
  // ==========================================

  const toggleGroupMember =
    (userId) => {
      const numericId =
        Number(userId);

      setSelectedMembers(
        (current) => {
          if (
            current.includes(
              numericId
            )
          ) {
            return current.filter(
              (id) =>
                id !==
                numericId
            );
          }

          return [
            ...current,
            numericId,
          ];
        }
      );

      setGroupError("");
    };

  // ==========================================
  // CREATE GROUP
  // ==========================================

  const createGroup =
    async (
      event
    ) => {
      event.preventDefault();

      const cleanName =
        groupName.trim();

      if (
        cleanName.length <
        2
      ) {
        setGroupError(
          "Enter a group name with at least 2 characters."
        );

        return;
      }

      if (
        selectedMembers.length <
        1
      ) {
        setGroupError(
          "Select at least one member."
        );

        return;
      }

      try {
        setCreatingGroup(
          true
        );

        setGroupError("");

        const response =
          await api.post(
            "/chat/conversations/group",
            {
              name:
                cleanName,

              memberIds:
                selectedMembers,
            }
          );

        const conversationId =
          response.data
            ?.conversation
            ?.id;

        const updatedConversations =
          await loadConversations();

        let newConversation =
          updatedConversations.find(
            (conversation) =>
              Number(
                conversation.id
              ) ===
              Number(
                conversationId
              )
          );

        if (
          !newConversation &&
          conversationId
        ) {
          newConversation = {
            id:
              conversationId,

            conversation_type:
              "group",

            name:
              cleanName,

            member_count:
              selectedMembers.length +
              1,

            unread_count:
              0,
          };
        }

        setShowGroupModal(
          false
        );

        setGroupName("");
        setGroupSearch("");
        setSelectedMembers([]);
        setGroupError("");

        if (
          newConversation
        ) {
          await selectConversation(
            newConversation
          );
        }

      } catch (error) {
        console.error(
          "Create Group Error:",
          error
        );

        setGroupError(
          error.response
            ?.data
            ?.message ||
            "Unable to create group. Please try again."
        );

      } finally {
        setCreatingGroup(
          false
        );
      }
    };

  // ==========================================
  // SEND MESSAGE
  // ==========================================

  const sendMessage =
    async (
      event
    ) => {
      event.preventDefault();

      const cleanMessage =
        messageText.trim();

if (
  (!cleanMessage && attachments.length === 0) ||
  !selectedConversation ||
  sending
) {
  return;
}

      try {
        setSending(
          true
        );

        setMessageText(
          ""
        );
        // Upload all selected images
for (const attachment of attachments) {
  const formData = new FormData();

formData.append(
  "image",
  attachment.file
);

  const uploadResponse =
    await api.post(
      `/chat/conversations/${selectedConversation.id}/upload-image`,
      formData,
      {
        headers: {
          "Content-Type":
            "multipart/form-data",
        },
      }
    );

  const uploadedMessage =
    uploadResponse.data?.message;

  if (uploadedMessage) {
    setMessages((current) => {
      const exists = current.some(
        (item) =>
          Number(item.id) ===
          Number(uploadedMessage.id)
      );

      if (exists) {
        return current;
      }

      return [
        ...current,
        uploadedMessage,
      ];
    });
  }
}

setAttachments([]);

if (cleanMessage) {

  const response =
    await api.post(
      `/chat/conversations/${selectedConversation.id}/messages`,
      {
        message: cleanMessage,
      }
    );

  const savedMessage =
    response.data?.message;

  if (savedMessage) {
    setMessages((current) => {
      const exists = current.some(
        (item) =>
          Number(item.id) ===
          Number(savedMessage.id)
      );

      if (exists) {
        return current;
      }

      return [
        ...current,
        savedMessage,
      ];
    });

    scrollToBottom();
  }

}

        await loadConversations();

      } catch (error) {
        console.error(
          "Send Message Error:",
          error
        );

        setMessageText(
          cleanMessage
        );

      } finally {
        setSending(
          false
        );
      }
    };

  // ==========================================
  // RESET CALL STATE
  // ==========================================

  const resetCallState =
    () => {
      cleanupCall();

      setIncomingCall(
        null
      );

      setActiveCall(
        null
      );

      setCallStatus(
        "idle"
      );

      setLocalMediaStream(
        null
      );

      setRemoteMediaStream(
        null
      );

      setMicrophoneEnabled(
        true
      );

      setCameraEnabled(
        true
      );

      setCallError(
        ""
      );

      activeCallRef.current =
        null;

      incomingCallRef.current =
        null;
    };

  // ==========================================
  // HANDLE REMOTE STREAM
  // ==========================================

  const handleRemoteStream =
    (
      stream
    ) => {
      setRemoteMediaStream(
        stream
      );
    };

  // ==========================================
  // START AUDIO OR VIDEO CALL
  // ==========================================

  const startCall =
    async (
      callType
    ) => {
      if (
        !selectedConversation
      ) {
        return;
      }

      if (
        isGroupConversation(
          selectedConversation
        )
      ) {
        return;
      }

      const targetUserId =
        Number(
          selectedConversation
            .other_user_id
        );

      if (
        !targetUserId
      ) {
        return;
      }

      if (
        callStatus !==
        "idle"
      ) {
        return;
      }

      try {
        setCallError("");

        const callData = {
          targetUserId,

          targetName:
            getConversationName(
              selectedConversation
            ),

          callType,

          direction:
            "outgoing",
        };

        setActiveCall(
          callData
        );

        activeCallRef.current =
          callData;

        setCallStatus(
          "calling"
        );

        setMicrophoneEnabled(
          true
        );

        setCameraEnabled(
          callType ===
            "video"
        );

        socket.emit(
          "call:start",
          {
            targetUserId,
            callType,
          }
        );

      } catch (error) {
        console.error(
          "Start Call Error:",
          error
        );

        setCallError(
          "Unable to start the call."
        );

        resetCallState();
      }
    };

  // ==========================================
  // ACCEPT INCOMING CALL
  // ==========================================

  const acceptIncomingCall =
    async () => {
      const call =
        incomingCallRef
          .current;

      if (
        !call
      ) {
        return;
      }

      try {
        setCallError("");

        const callerId =
          Number(
            call.callerId
          );

        const callType =
          call.callType ===
          "video"
            ? "video"
            : "audio";

        const stream =
          await getLocalStream(
            callType
          );

        setLocalMediaStream(
          stream
        );

        setMicrophoneEnabled(
          true
        );

        setCameraEnabled(
          callType ===
            "video"
        );

        createPeerConnection(
          callerId,
          handleRemoteStream
        );

        addLocalStream(
          stream
        );

        const activeCallData = {
          targetUserId:
            callerId,

          targetName:
            call.callerName ||
            "User",

          callType,

          direction:
            "incoming",
        };

        setActiveCall(
          activeCallData
        );

        activeCallRef.current =
          activeCallData;

        setIncomingCall(
          null
        );

        incomingCallRef.current =
          null;

        setCallStatus(
          "connecting"
        );

        socket.emit(
          "call:accept",
          {
            callerId,

            callType,
          }
        );

      } catch (error) {
        console.error(
          "Accept Call Error:",
          error
        );

        setCallError(
          "Microphone or camera permission was denied."
        );

        socket.emit(
          "call:reject",
          {
            callerId:
              call.callerId,
          }
        );

        resetCallState();
      }
    };

  // ==========================================
  // REJECT INCOMING CALL
  // ==========================================

  const rejectIncomingCall =
    () => {
      const call =
        incomingCallRef
          .current;

      if (
        !call
      ) {
        return;
      }

      socket.emit(
        "call:reject",
        {
          callerId:
            call.callerId,
        }
      );

      setIncomingCall(
        null
      );

      incomingCallRef.current =
        null;

      setCallStatus(
        "idle"
      );

      setCallError(
        ""
      );
    };

  // ==========================================
  // END ACTIVE CALL
  // ==========================================

  const endActiveCall =
    () => {
      const call =
        activeCallRef
          .current;

      if (
        call
          ?.targetUserId
      ) {
        socket.emit(
          "call:end",
          {
            targetUserId:
              call.targetUserId,
          }
        );
      }

      resetCallState();
    };

  // ==========================================
  // TOGGLE CALL MICROPHONE
  // ==========================================

  const handleToggleMicrophone =
    () => {
      const enabled =
        toggleMicrophone();

      setMicrophoneEnabled(
        enabled
      );
    };

  // ==========================================
  // TOGGLE CALL CAMERA
  // ==========================================

  const handleToggleCamera =
    () => {
      const call =
        activeCallRef
          .current;

      if (
        call?.callType !==
        "video"
      ) {
        return;
      }

      const enabled =
        toggleCamera();

      setCameraEnabled(
        enabled
      );
    };

  // ==========================================
  // SOCKET INITIALIZATION
  // CHAT + CALLING
  // ==========================================

  useEffect(() => {
    connectSocket();

    // ========================================
    // ONLINE USERS
    // ========================================

    const handleOnlineUsers =
      (
        userIds
      ) => {
        setOnlineUsers(
          userIds.map(
            Number
          )
        );
      };

    const handleUserOnline =
      ({
        userId,
      }) => {
        setOnlineUsers(
          (current) => {
            const id =
              Number(
                userId
              );

            if (
              current.includes(
                id
              )
            ) {
              return current;
            }

            return [
              ...current,
              id,
            ];
          }
        );
      };

    const handleUserOffline =
      ({
        userId,
      }) => {
        setOnlineUsers(
          (current) =>
            current.filter(
              (id) =>
                id !==
                Number(
                  userId
                )
            )
        );
      };

    // ========================================
    // NEW CHAT MESSAGE
    // ========================================

    const handleNewMessage =
      (
        newMessage
      ) => {
        const active =
          selectedConversationRef
            .current;

        if (
          Number(
            newMessage
              .conversation_id
          ) ===
          Number(
            active?.id
          )
        ) {
          setMessages(
            (current) => {
              const exists =
                current.some(
                  (message) =>
                    Number(
                      message.id
                    ) ===
                    Number(
                      newMessage.id
                    )
                );

              if (
                exists
              ) {
                return current;
              }

              return [
                ...current,
                newMessage,
              ];
            }
          );

          scrollToBottom();

          api.put(
            `/chat/conversations/${active.id}/read`
          ).catch(
            () => {}
          );
        }

        loadConversations();
      };

    const handleConversationUpdated =
      () => {
        loadConversations();
      };

    // ========================================
    // INCOMING CALL
    // ========================================

    const handleIncomingCall =
      (
        callData
      ) => {
        // If already in a call or another
        // call is ringing, reject new call.

        if (
          activeCallRef.current ||
          incomingCallRef.current
        ) {
          socket.emit(
            "call:reject",
            {
              callerId:
                callData
                  .callerId,
            }
          );

          return;
        }

        const incomingData = {
          callerId:
            Number(
              callData
                .callerId
            ),

          callerEmployeeId:
            callData
              .callerEmployeeId,

          callerName:
            callData
              .callerName ||
            "User",

          callerRole:
            callData
              .callerRole,

          callType:
            callData
              .callType ===
            "video"
              ? "video"
              : "audio",
        };

        setIncomingCall(
          incomingData
        );

        incomingCallRef.current =
          incomingData;

        setCallStatus(
          "incoming"
        );

        setCallError(
          ""
        );
      };

    // ========================================
    // CALL RINGING
    // ========================================

    const handleCallRinging =
      (
        data
      ) => {
        const call =
          activeCallRef
            .current;

        if (
          !call
        ) {
          return;
        }

        setActiveCall(
          (current) => ({
            ...current,

            targetName:
              data
                ?.targetName ||
              current
                ?.targetName,

            callType:
              data
                ?.callType ||
              current
                ?.callType,
          })
        );

        setCallStatus(
          "ringing"
        );
      };

    // ========================================
    // CALL ACCEPTED
    //
    // Caller now opens microphone/camera,
    // creates peer connection and sends offer.
    // ========================================

    const handleCallAccepted =
      async (
        data
      ) => {
        const call =
          activeCallRef
            .current;

        if (
          !call
        ) {
          return;
        }

        try {
          const targetUserId =
            Number(
              data?.userId ||
              call.targetUserId
            );

          const callType =
            call.callType ===
            "video"
              ? "video"
              : "audio";

          setCallStatus(
            "connecting"
          );

          const stream =
            await getLocalStream(
              callType
            );

          setLocalMediaStream(
            stream
          );

          setMicrophoneEnabled(
            true
          );

          setCameraEnabled(
            callType ===
              "video"
          );

          createPeerConnection(
            targetUserId,
            handleRemoteStream
          );

          addLocalStream(
            stream
          );

          await createOffer(
            targetUserId
          );

        } catch (error) {
          console.error(
            "Call Accepted Setup Error:",
            error
          );

          setCallError(
            "Unable to access microphone or camera."
          );

          socket.emit(
            "call:end",
            {
              targetUserId:
                call.targetUserId,
            }
          );

          resetCallState();
        }
      };

    // ========================================
    // CALL REJECTED
    // ========================================

    const handleCallRejected =
      () => {
        setCallError(
          "Call was declined."
        );

        cleanupCall();

        setActiveCall(
          null
        );

        activeCallRef.current =
          null;

        setLocalMediaStream(
          null
        );

        setRemoteMediaStream(
          null
        );

        setCallStatus(
          "idle"
        );

        setTimeout(() => {
          setCallError(
            ""
          );
        }, 3000);
      };

    // ========================================
    // USER UNAVAILABLE
    // ========================================

    const handleCallUnavailable =
      (
        data
      ) => {
        setCallError(
          data?.message ||
          "User is currently unavailable."
        );

        cleanupCall();

        setActiveCall(
          null
        );

        activeCallRef.current =
          null;

        setLocalMediaStream(
          null
        );

        setRemoteMediaStream(
          null
        );

        setCallStatus(
          "idle"
        );

        setTimeout(() => {
          setCallError(
            ""
          );
        }, 3000);
      };

    // ========================================
    // CALL ERROR
    // ========================================

    const handleCallError =
      (
        data
      ) => {
        setCallError(
          data?.message ||
          "Unable to start the call."
        );

        cleanupCall();

        setActiveCall(
          null
        );

        activeCallRef.current =
          null;

        setLocalMediaStream(
          null
        );

        setRemoteMediaStream(
          null
        );

        setCallStatus(
          "idle"
        );
      };

    // ========================================
    // WEBRTC OFFER
    //
    // Receiver gets caller's offer and
    // generates the WebRTC answer.
    // ========================================

    const handleWebRTCOffer =
      async (
        data
      ) => {
        try {
          const call =
            activeCallRef
              .current;

          if (
            !call
          ) {
            return;
          }

          const fromUserId =
            Number(
              data
                ?.fromUserId
            );

          if (
            Number(
              call.targetUserId
            ) !==
            fromUserId
          ) {
            return;
          }

          await handleOffer(
            fromUserId,
            data.offer
          );

          setCallStatus(
            "connected"
          );

        } catch (error) {
          console.error(
            "Handle WebRTC Offer Error:",
            error
          );

          setCallError(
            "Unable to establish the call connection."
          );
        }
      };

    // ========================================
    // WEBRTC ANSWER
    // ========================================

    const handleWebRTCAnswer =
      async (
        data
      ) => {
        try {
          const call =
            activeCallRef
              .current;

          if (
            !call
          ) {
            return;
          }

          const fromUserId =
            Number(
              data
                ?.fromUserId
            );

          if (
            Number(
              call.targetUserId
            ) !==
            fromUserId
          ) {
            return;
          }

          await handleAnswer(
            data.answer
          );

          setCallStatus(
            "connected"
          );

        } catch (error) {
          console.error(
            "Handle WebRTC Answer Error:",
            error
          );

          setCallError(
            "Unable to complete the call connection."
          );
        }
      };

    // ========================================
    // WEBRTC ICE CANDIDATE
    // ========================================

    const handleWebRTCIceCandidate =
      async (
        data
      ) => {
        try {
          const call =
            activeCallRef
              .current;

          if (
            !call
          ) {
            return;
          }

          const fromUserId =
            Number(
              data
                ?.fromUserId
            );

          if (
            Number(
              call.targetUserId
            ) !==
            fromUserId
          ) {
            return;
          }

          await handleIceCandidate(
            data.candidate
          );

        } catch (error) {
          console.error(
            "Handle ICE Candidate Error:",
            error
          );
        }
      };

    // ========================================
    // CALL ENDED BY OTHER USER
    // ========================================

    const handleCallEnded =
      () => {
        resetCallState();
      };

    // ========================================
    // REGISTER CHAT SOCKET EVENTS
    // ========================================

    socket.on(
      "users:online",
      handleOnlineUsers
    );

    socket.on(
      "user:online",
      handleUserOnline
    );

    socket.on(
      "user:offline",
      handleUserOffline
    );

    socket.on(
      "message:new",
      handleNewMessage
    );

    socket.on(
      "conversation:updated",
      handleConversationUpdated
    );

    // ========================================
    // REGISTER CALL SOCKET EVENTS
    // ========================================

    socket.on(
      "call:incoming",
      handleIncomingCall
    );

    socket.on(
      "call:ringing",
      handleCallRinging
    );

    socket.on(
      "call:accepted",
      handleCallAccepted
    );

    socket.on(
      "call:rejected",
      handleCallRejected
    );

    socket.on(
      "call:unavailable",
      handleCallUnavailable
    );

    socket.on(
      "call:error",
      handleCallError
    );

    socket.on(
      "call:ended",
      handleCallEnded
    );

    socket.on(
      "webrtc:offer",
      handleWebRTCOffer
    );

    socket.on(
      "webrtc:answer",
      handleWebRTCAnswer
    );

    socket.on(
      "webrtc:ice-candidate",
      handleWebRTCIceCandidate
    );

    // ========================================
    // INITIAL DATA
    // ========================================

    loadUsers();
    loadConversations();

    // ========================================
    // CLEANUP SOCKET LISTENERS
    // ========================================

    return () => {
      socket.off(
        "users:online",
        handleOnlineUsers
      );

      socket.off(
        "user:online",
        handleUserOnline
      );

      socket.off(
        "user:offline",
        handleUserOffline
      );

      socket.off(
        "message:new",
        handleNewMessage
      );

      socket.off(
        "conversation:updated",
        handleConversationUpdated
      );

      socket.off(
        "call:incoming",
        handleIncomingCall
      );

      socket.off(
        "call:ringing",
        handleCallRinging
      );

      socket.off(
        "call:accepted",
        handleCallAccepted
      );

      socket.off(
        "call:rejected",
        handleCallRejected
      );

      socket.off(
        "call:unavailable",
        handleCallUnavailable
      );

      socket.off(
        "call:error",
        handleCallError
      );

      socket.off(
        "call:ended",
        handleCallEnded
      );

      socket.off(
        "webrtc:offer",
        handleWebRTCOffer
      );

      socket.off(
        "webrtc:answer",
        handleWebRTCAnswer
      );

      socket.off(
        "webrtc:ice-candidate",
        handleWebRTCIceCandidate
      );
    };
  }, []);

  // ==========================================
  // FILTER PRIVATE CHAT SEARCH
  // ==========================================

  const filteredUsers =
    users.filter(
      (user) => {
        const value =
          search
            .toLowerCase()
            .trim();

        if (
          !value
        ) {
          return false;
        }

        return (
          user.full_name
            ?.toLowerCase()
            .includes(
              value
            ) ||
          user.employee_id
            ?.toLowerCase()
            .includes(
              value
            )
        );
      }
    );

  // ==========================================
  // FILTER GROUP MEMBER SEARCH
  // ==========================================

  const filteredGroupUsers =
    users.filter(
      (user) => {
        const value =
          groupSearch
            .toLowerCase()
            .trim();

        if (
          !value
        ) {
          return true;
        }

        return (
          user.full_name
            ?.toLowerCase()
            .includes(
              value
            ) ||
          user.employee_id
            ?.toLowerCase()
            .includes(
              value
            ) ||
          user.role
            ?.toLowerCase()
            .includes(
              value
            )
        );
      }
    );

  // ==========================================
  // FORMAT MESSAGE TIME
  // ==========================================

  const formatTime =
    (value) => {
      if (
        !value
      ) {
        return "";
      }

      return new Date(
        value
      ).toLocaleTimeString(
        "en-IN",
        {
          hour:
            "2-digit",

          minute:
            "2-digit",
        }
      );
    };

  // ==========================================
  // OPEN A SPECIFIC CONVERSATION ON ARRIVAL
  //
  // Set when navigating here from a chat
  // notification (toast / browser notification /
  // bell click) via
  // navigate(".../chat", { state: { openConversationId } }).
  // Runs once conversations have loaded, then
  // clears the navigation state so an unrelated
  // later conversations refresh never re-triggers
  // it and yanks the user back after they've
  // manually switched conversations.
  // ==========================================

  useEffect(() => {

    const targetId = location.state?.openConversationId;

    if (!targetId || conversations.length === 0) return;

    const target = conversations.find(
      (conversation) => Number(conversation.id) === Number(targetId)
    );

    if (target) {
      selectConversation(target);
    }

    navigate(location.pathname, { replace: true, state: {} });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, conversations]);

  // ==========================================
  // PART 1 ENDS HERE
  // PART 2 CONTINUES DIRECTLY BELOW
  // DO NOT CLOSE THE Chat FUNCTION HERE
  // ==========================================
    // ==========================================
  // MAIN CHAT CONTENT
  // ==========================================

const chatContent = (
  <>
    <div className="workhub-chat-layout">
<div className="workhub-chat-page">

      {/* LEFT SIDEBAR */}
      <section className="workhub-chat-sidebar">

          <div className="workhub-chat-sidebar-header">

            <div>
              <h2>
                Messages
              </h2>

              <p>
                Connect with your team
              </p>
            </div>

            <div className="workhub-chat-header-actions">

              <button
                type="button"
                className="workhub-new-group-button"
                onClick={
                  openGroupModal
                }
                title="Create new group"
              >
                <FaPlus />
                <FaUsers />
              </button>

              <div className="workhub-chat-header-icon">
                <FaComments />
              </div>

            </div>

          </div>

          {/* SEARCH */}

          <div className="workhub-chat-search">

            <FaSearch />

            <input
              type="text"
              placeholder="Search people..."
              value={
                search
              }
              onChange={(
                event
              ) =>
                setSearch(
                  event.target
                    .value
                )
              }
            />

          </div>

          {/* SEARCH RESULTS */}

          {search.trim() && (

            <div className="workhub-chat-search-results">

              <span className="workhub-chat-section-label">
                People
              </span>

              {filteredUsers.length ===
              0 ? (

                <div className="workhub-chat-no-results">
                  No people found
                </div>

              ) : (

                filteredUsers.map(
                  (user) => (

                    <button
                      type="button"
                      key={
                        user.id
                      }
                      className="workhub-chat-person"
                      onClick={() => {
                        startPrivateChat(
                          user
                        );

                        setSearch(
                          ""
                        );
                      }}
                    >

                      <div className="workhub-chat-avatar">

                        {user.full_name
                          ?.charAt(0)
                          ?.toUpperCase() ||
                          "U"}

                        {onlineUsers.includes(
                          Number(
                            user.id
                          )
                        ) && (
                          <span className="workhub-chat-online-dot" />
                        )}

                      </div>

                      <div className="workhub-chat-person-info">

                        <strong>
                          {
                            user.full_name
                          }
                        </strong>

                        <span>
                          {
                            user.employee_id
                          }{" "}
                          •{" "}
                          {
                            user.role
                          }
                        </span>

                      </div>

                      <FaUserPlus className="workhub-chat-start-icon" />

                    </button>

                  )
                )

              )}

            </div>

          )}

          {/* CONVERSATIONS */}

          <div className="workhub-chat-conversation-area">

            <span className="workhub-chat-section-label">
              Recent Chats
            </span>

            {loadingConversations ? (

              <div className="workhub-chat-sidebar-message">
                Loading conversations...
              </div>

            ) : conversations.length ===
              0 ? (

              <div className="workhub-chat-sidebar-empty">

                <FaComments />

                <h3>
                  No conversations yet
                </h3>

                <p>
                  Search for a colleague or
                  create a group to start
                  chatting.
                </p>

              </div>

            ) : (

              conversations.map(
                (
                  conversation
                ) => {
                  const group =
                    isGroupConversation(
                      conversation
                    );

                  const isOnline =
                    !group &&
                    onlineUsers.includes(
                      Number(
                        conversation
                          .other_user_id
                      )
                    );

                  const isSelected =
                    Number(
                      selectedConversation
                        ?.id
                    ) ===
                    Number(
                      conversation.id
                    );

                  const conversationName =
                    getConversationName(
                      conversation
                    );

                  return (

                    <button
                      type="button"
                      key={
                        conversation.id
                      }
                      className={
                        isSelected
                          ? "workhub-chat-conversation active"
                          : "workhub-chat-conversation"
                      }
                      onClick={() =>
                        selectConversation(
                          conversation
                        )
                      }
                    >

                      <div
                        className={
                          group
                            ? "workhub-chat-avatar group"
                            : "workhub-chat-avatar"
                        }
                      >

                        {group ? (
                          <FaUsers />
                        ) : (
                          getConversationInitial(
                            conversation
                          )
                        )}

                        {isOnline && (
                          <span className="workhub-chat-online-dot" />
                        )}

                      </div>

                      <div className="workhub-chat-conversation-info">

                        <div className="workhub-chat-conversation-top">

                          <strong>
                            {
                              conversationName
                            }
                          </strong>

                          {Number(
                            conversation
                              .unread_count
                          ) >
                            0 && (

                            <span className="workhub-chat-unread-badge">
                              {
                                conversation
                                  .unread_count
                              }
                            </span>

                          )}

                        </div>

                        <p>

                          {group &&
                            !conversation
                              .last_message && (
                              <>
                                {
                                  conversation
                                    .member_count
                                }{" "}
                                members
                              </>
                            )}

                          {!group &&
                            !conversation
                              .last_message &&
                            "Start a conversation"}

                          {conversation
                            .last_message && (
                              <>
                                {group &&
                                  conversation
                                    .last_message_sender && (
                                    <strong className="workhub-last-message-sender">
                                      {
                                        conversation
                                          .last_message_sender
                                      }
                                      :{" "}
                                    </strong>
                                  )}

                                {
                                  conversation
                                    .last_message
                                }
                              </>
                            )}

                        </p>

                      </div>

                    </button>

                  );
                }
              )

            )}

          </div>

        </section>

        {/* ==================================
            ACTIVE CHAT
        ================================== */}

        <section className="workhub-chat-main">

          {!selectedConversation ? (

            <div className="workhub-chat-welcome">

              <div className="workhub-chat-welcome-icon">
                <FaComments />
              </div>

              <h2>
                Welcome to WorkHub Chat
              </h2>

              <p>
                Select a conversation, search
                for a colleague, or create a
                group to start messaging.
              </p>

            </div>

          ) : (

            <>

              {/* ==================================
                  CHAT HEADER
              ================================== */}

              <div className="workhub-active-chat-header">

                <div className="workhub-active-chat-user">

                  <div
                    className={
                      isGroupConversation(
                        selectedConversation
                      )
                        ? "workhub-chat-avatar large group"
                        : "workhub-chat-avatar large"
                    }
                  >

                    {isGroupConversation(
                      selectedConversation
                    ) ? (
                      <FaUsers />
                    ) : (
                      getConversationInitial(
                        selectedConversation
                      )
                    )}

                    {!isGroupConversation(
                      selectedConversation
                    ) &&
                      onlineUsers.includes(
                        Number(
                          selectedConversation
                            .other_user_id
                        )
                      ) && (
                        <span className="workhub-chat-online-dot" />
                      )}

                  </div>

                  <div>

                    <h3>
                      {getConversationName(
                        selectedConversation
                      )}
                    </h3>

                    {isGroupConversation(
                      selectedConversation
                    ) ? (

                      <span className="workhub-chat-group-status">
                        <FaUsers />

                        {
                          selectedConversation
                            .member_count ||
                          1
                        }{" "}
                        members
                      </span>

                    ) : (

<span
  className={
    onlineUsers.includes(
      Number(selectedConversation.other_user_id)
    )
      ? "workhub-chat-status online"
      : "workhub-chat-status offline"
  }
>
  <FaCircle />

  {onlineUsers.includes(
    Number(selectedConversation.other_user_id)
  )
    ? "Online"
    : "Offline"}
</span>

                    )}

                  </div>

                </div>

                {/* ==================================
                    PRIVATE CALL BUTTONS
                ================================== */}

                {!isGroupConversation(
                  selectedConversation
                ) && (

                  <div className="workhub-chat-call-actions">

                    <button
                      type="button"
                      className="workhub-chat-call-button"
                      onClick={() =>
                        startCall(
                          "audio"
                        )
                      }
                      disabled={
                        callStatus !==
                        "idle"
                      }
                      title="Start voice call"
                    >
                      <FaPhone />

                      <span>
                        Voice
                      </span>
                    </button>

                    <button
                      type="button"
                      className="workhub-chat-call-button video"
                      onClick={() =>
                        startCall(
                          "video"
                        )
                      }
                      disabled={
                        callStatus !==
                        "idle"
                      }
                      title="Start video call"
                    >
                      <FaVideo />

                      <span>
                        Video
                      </span>
                    </button>

                  </div>

                )}

              </div>

              {/* CALL ERROR */}

              {callError && (

                <div className="workhub-call-error-banner">
                  {
                    callError
                  }
                </div>

              )}

              {/* ==================================
                  MESSAGES
              ================================== */}

              <div className="workhub-chat-messages">

                {loadingMessages ? (

                  <div className="workhub-chat-loading">
                    Loading messages...
                  </div>

                ) : messages.length ===
                  0 ? (

                  <div className="workhub-chat-empty-conversation">

                    {isGroupConversation(
                      selectedConversation
                    ) ? (
                      <FaUsers />
                    ) : (
                      <FaComments />
                    )}

                    <h3>
                      Start the conversation
                    </h3>

                    <p>

                      {isGroupConversation(
                        selectedConversation
                      )
                        ? `Send the first message to ${getConversationName(
                            selectedConversation
                          )}.`
                        : `Send a message to ${getConversationName(
                            selectedConversation
                          )}.`}

                    </p>

                  </div>

                ) : (

                  messages.map(
                    (message) => {
                      const isMine =
                        Number(
                          message
                            .sender_id
                        ) ===
                        Number(
                          currentUser
                            ?.id
                        );

                      return (

                        <div
                          key={
                            message.id
                          }
                          className={
                            isMine
                              ? "workhub-message-row mine"
                              : "workhub-message-row"
                          }
                        >

                          {!isMine && (

                            <div className="workhub-message-avatar">

                              {message
                                .sender_name
                                ?.charAt(0)
                                ?.toUpperCase() ||
                                "U"}

                            </div>

                          )}

                          <div className="workhub-message-wrapper">

                            {!isMine && (

                              <span className="workhub-message-sender">
                                {
                                  message
                                    .sender_name
                                }
                              </span>

                            )}

<div
  className={
    isMine
      ? "workhub-message-bubble mine"
      : "workhub-message-bubble"
  }
>

{message.message_type === "image" ? (

  <img
    src={`http://localhost:5000${message.image}`}
    alt="Shared"
    className="workhub-chat-image"
    onClick={() =>
      setPreviewImage(
        `http://localhost:5000${message.image}`
      )
    }
  />

) : message.message_type === "file" ? (

<button
  type="button"
  className="workhub-file-message"
  onClick={() => {
    window.open(
      `http://localhost:5000${message.image}`,
      "_blank"
    );
  }}
>
  📄 {message.file_name}
</button>

) : (

  <div className="workhub-message-text">
    {message.message_text}
  </div>

)}

  <span>
    {formatTime(message.created_at)}
  </span>

</div>

                          </div>

                        </div>

                      );
                    }
                  )

                )}

                <div
                  ref={
                    messagesEndRef
                  }
                />
                {previewImage && (
<div
  className="workhub-image-preview"
  onClick={() => setPreviewImage(null)}
>
  <img
    src={previewImage}
    alt="Preview"
    className="workhub-image-preview-img"
    onClick={(e) => e.stopPropagation()}
  />
</div>
)}

              </div>

              {/* ==================================
                  MESSAGE COMPOSER
              ================================== */}

              <form
              
                className="workhub-chat-composer"
                onSubmit={
                  sendMessage
                }
              >
              <AttachmentPreview
  attachments={attachments}
  removeAttachment={removeAttachment}
/>

<input
  ref={imageInputRef}
  type="file"
  accept="image/*"
  multiple
  style={{ display: "none" }}
onChange={(event) => {
  const files = Array.from(event.target.files || []);

  if (!files.length) return;

  addAttachments(files);

  event.target.value = "";
}}
/>
<input
  ref={documentInputRef}
  type="file"
  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar"
  multiple
  style={{ display: "none" }}
  onChange={(event) => {
    const files = Array.from(event.target.files || []);

    if (!files.length) return;

    addAttachments(files);

    event.target.value = "";
  }}
/>
 <div className="workhub-chat-input-bar">

  <div className="workhub-attachment-wrapper">

    <button
      type="button"
      className="workhub-chat-plus-button"
      onClick={() =>
        setShowAttachmentMenu((prev) => !prev)
      }
      title="Attach"
    >
      <FaPlus />
    </button>

    {showAttachmentMenu && (
      <div className="workhub-attachment-menu">

        <button
          type="button"
          className="workhub-menu-item"
          onClick={() => imageInputRef.current?.click()}
        >
          <div className="workhub-menu-icon image">
            <FaImage />
          </div>

          <div className="workhub-menu-content">
            <h4>Add Photos</h4>
            <p>Upload images from your computer</p>
          </div>

          <div className="workhub-menu-arrow">
            →
          </div>
        </button>

        <button
          type="button"
          className="workhub-menu-item"
          onClick={() => documentInputRef.current?.click()}
        >
          <div className="workhub-menu-icon file">
            <FaFileAlt />
          </div>

          <div className="workhub-menu-content">
            <h4>Add Files</h4>
            <p>Upload PDF, DOCX, Excel and more</p>
          </div>

          <div className="workhub-menu-arrow">
            →
          </div>
        </button>

      </div>
    )}

  </div>

  <div className="workhub-chat-input-wrapper">

    <input
      type="text"
      className="workhub-chat-input"
      placeholder={`Message ${getConversationName(selectedConversation)}`}
      value={messageText}
      onChange={(event) =>
        setMessageText(event.target.value)
      }
      maxLength={5000}
    />

    <button
      type="submit"
      className="workhub-chat-send-button"
      disabled={
        (!messageText.trim() &&
          attachments.length === 0) ||
        sending
      }
      title="Send message"
    >
      <FaPaperPlane />
    </button>

  </div>

</div>
                  </form>

                </>

              )}

            </section>

          </div>

          {/* ==================================
              INCOMING CALL POPUP
          ================================== */}

          {incomingCall && (

            <div className="workhub-incoming-call-overlay">

              <div className="workhub-incoming-call-card">

                <div className="workhub-incoming-call-avatar">

                  {incomingCall
                    .callerName
                    ?.charAt(0)
                    ?.toUpperCase() ||
                    "U"}

                </div>

                <span className="workhub-incoming-call-label">

                  {incomingCall
                    .callType ===
                  "video"
                    ? "Incoming video call"
                    : "Incoming voice call"}

                </span>

                <h2>
                  {
                    incomingCall
                      .callerName
                  }
                </h2>

            {incomingCall
              .callerEmployeeId && (

              <p>
                {
                  incomingCall
                    .callerEmployeeId
                }
              </p>

            )}

            <div className="workhub-incoming-call-type-icon">

              {incomingCall
                .callType ===
              "video" ? (
                <FaVideo />
              ) : (
                <FaPhone />
              )}

            </div>

            <div className="workhub-incoming-call-actions">

              <button
                type="button"
                className="workhub-call-reject-button"
                onClick={
                  rejectIncomingCall
                }
              >
                <FaPhoneSlash />

                <span>
                  Decline
                </span>
              </button>

              <button
                type="button"
                className="workhub-call-accept-button"
                onClick={
                  acceptIncomingCall
                }
              >

                {incomingCall
                  .callType ===
                "video" ? (
                  <FaVideo />
                ) : (
                  <FaPhone />
                )}

                <span>
                  Accept
                </span>

              </button>

            </div>

          </div>

        </div>

      )}

      {/* ==================================
          OUTGOING / ACTIVE CALL SCREEN
      ================================== */}

      {activeCall &&
        callStatus !==
          "idle" && (

        <div className="workhub-call-overlay">

          <div
            className={
              activeCall
                .callType ===
              "video"
                ? "workhub-call-window video-call"
                : "workhub-call-window audio-call"
            }
          >

            {/* ==================================
                REMOTE MEDIA AREA
            ================================== */}

            <div className="workhub-call-media-area">

              {/* REMOTE VIDEO */}

              {activeCall
                .callType ===
              "video" && (

                <video
                  ref={
                    remoteVideoRef
                  }
                  className="workhub-call-remote-video"
                  autoPlay
                  playsInline
                />

              )}

              {/* REMOTE AUDIO FOR AUDIO CALL */}

              {activeCall
                .callType ===
              "audio" && (

                <audio
                  ref={
                    remoteVideoRef
                  }
                  autoPlay
                />

              )}

              {/* AUDIO CALL AVATAR */}

              {activeCall
                .callType ===
              "audio" && (

                <div className="workhub-audio-call-profile">

                  <div className="workhub-audio-call-avatar">

                    {activeCall
                      .targetName
                      ?.charAt(0)
                      ?.toUpperCase() ||
                      "U"}

                  </div>

                  <h2>
                    {
                      activeCall
                        .targetName
                    }
                  </h2>

                  <p>

                    {callStatus ===
                      "calling" &&
                      "Starting call..."}

                    {callStatus ===
                      "ringing" &&
                      "Ringing..."}

                    {callStatus ===
                      "connecting" &&
                      "Connecting..."}

                    {callStatus ===
                      "connected" &&
                      "Voice call connected"}

                  </p>

                </div>

              )}

              {/* VIDEO CALL STATUS */}

              {activeCall
                .callType ===
                "video" &&
                callStatus !==
                  "connected" && (

                <div className="workhub-video-call-status">

                  <div className="workhub-video-call-avatar">

                    {activeCall
                      .targetName
                      ?.charAt(0)
                      ?.toUpperCase() ||
                      "U"}

                  </div>

                  <h2>
                    {
                      activeCall
                        .targetName
                    }
                  </h2>

                  <p>

                    {callStatus ===
                      "calling" &&
                      "Starting video call..."}

                    {callStatus ===
                      "ringing" &&
                      "Ringing..."}

                    {callStatus ===
                      "connecting" &&
                      "Connecting video..."}

                  </p>

                </div>

              )}

              {/* LOCAL VIDEO PREVIEW */}

              {activeCall
                .callType ===
                "video" &&
                localMediaStream && (

                <div className="workhub-call-local-video-wrapper">

                  <video
                    ref={
                      localVideoRef
                    }
                    className="workhub-call-local-video"
                    autoPlay
                    muted
                    playsInline
                  />

                  {!cameraEnabled && (

                    <div className="workhub-local-camera-off">

                      <FaVideoSlash />

                      <span>
                        Camera off
                      </span>

                    </div>

                  )}

                </div>

              )}

            </div>

            {/* ==================================
                CALL TOP INFO
            ================================== */}

            <div className="workhub-call-top-bar">

              <div>

                <strong>
                  {
                    activeCall
                      .targetName
                  }
                </strong>

                <span>

                  {activeCall
                    .callType ===
                  "video"
                    ? "Video call"
                    : "Voice call"}

                  {" • "}

                  {callStatus ===
                    "calling" &&
                    "Calling"}

                  {callStatus ===
                    "ringing" &&
                    "Ringing"}

                  {callStatus ===
                    "connecting" &&
                    "Connecting"}

                  {callStatus ===
                    "connected" &&
                    "Connected"}

                </span>

              </div>

            </div>

            {/* ==================================
                CALL CONTROLS
            ================================== */}

            <div className="workhub-call-controls">

              <button
                type="button"
                className={
                  microphoneEnabled
                    ? "workhub-call-control-button"
                    : "workhub-call-control-button disabled"
                }
                onClick={
                  handleToggleMicrophone
                }
                title={
                  microphoneEnabled
                    ? "Mute microphone"
                    : "Unmute microphone"
                }
              >

                {microphoneEnabled ? (
                  <FaMicrophone />
                ) : (
                  <FaMicrophoneSlash />
                )}

                <span>

                  {microphoneEnabled
                    ? "Mute"
                    : "Unmute"}

                </span>

              </button>

              {activeCall
                .callType ===
                "video" && (

                <button
                  type="button"
                  className={
                    cameraEnabled
                      ? "workhub-call-control-button"
                      : "workhub-call-control-button disabled"
                  }
                  onClick={
                    handleToggleCamera
                  }
                  title={
                    cameraEnabled
                      ? "Turn camera off"
                      : "Turn camera on"
                  }
                >

                  {cameraEnabled ? (
                    <FaVideo />
                  ) : (
                    <FaVideoSlash />
                  )}

                  <span>

                    {cameraEnabled
                      ? "Camera"
                      : "Camera off"}

                  </span>

                </button>

              )}

              <button
                type="button"
                className="workhub-call-end-button"
                onClick={
                  endActiveCall
                }
                title="End call"
              >

                <FaPhoneSlash />

                <span>
                  End
                </span>

              </button>

            </div>

          </div>

        </div>

      )}

      {/* ==================================
          CREATE GROUP MODAL
      ================================== */}

      {showGroupModal && (

        <div
          className="workhub-group-modal-overlay"
          onMouseDown={(
            event
          ) => {
            if (
              event.target ===
              event.currentTarget
            ) {
              closeGroupModal();
            }
          }}
        >

          <div className="workhub-group-modal">

            {/* MODAL HEADER */}

            <div className="workhub-group-modal-header">

              <div className="workhub-group-modal-title">

                <div className="workhub-group-modal-icon">
                  <FaUsers />
                </div>

                <div>

                  <h2>
                    Create New Group
                  </h2>

                  <p>
                    Create a space for your
                    team to collaborate.
                  </p>

                </div>

              </div>

              <button
                type="button"
                className="workhub-group-close-button"
                onClick={
                  closeGroupModal
                }
                disabled={
                  creatingGroup
                }
              >
                <FaTimes />
              </button>

            </div>

            {/* MODAL FORM */}

            <form
              onSubmit={
                createGroup
              }
            >

              <div className="workhub-group-modal-body">

                {/* GROUP NAME */}

                <div className="workhub-group-form-group">

                  <label>
                    Group Name
                  </label>

                  <input
                    type="text"
                    placeholder="Example: Development Team"
                    value={
                      groupName
                    }
                    onChange={(
                      event
                    ) => {
                      setGroupName(
                        event.target
                          .value
                      );

                      setGroupError(
                        ""
                      );
                    }}
                    maxLength={
                      150
                    }
                    autoFocus
                  />

                </div>

                {/* SELECT MEMBERS */}

                <div className="workhub-group-member-heading">

                  <div>

                    <label>
                      Add Members
                    </label>

                    <p>
                      Select employees or
                      administrators to join
                      this group.
                    </p>

                  </div>

                  <span className="workhub-group-selected-count">
                    {
                      selectedMembers.length
                    }{" "}
                    selected
                  </span>

                </div>

                {/* MEMBER SEARCH */}

                <div className="workhub-group-search">

                  <FaSearch />

                  <input
                    type="text"
                    placeholder="Search by name or employee ID..."
                    value={
                      groupSearch
                    }
                    onChange={(
                      event
                    ) =>
                      setGroupSearch(
                        event.target
                          .value
                      )
                    }
                  />

                </div>

                {/* MEMBER LIST */}

                <div className="workhub-group-member-list">

                  {filteredGroupUsers.length ===
                  0 ? (

                    <div className="workhub-group-no-users">
                      No users found
                    </div>

                  ) : (

                    filteredGroupUsers.map(
                      (user) => {
                        const selected =
                          selectedMembers.includes(
                            Number(
                              user.id
                            )
                          );

                        const online =
                          onlineUsers.includes(
                            Number(
                              user.id
                            )
                          );

                        return (

                          <button
                            type="button"
                            key={
                              user.id
                            }
                            className={
                              selected
                                ? "workhub-group-member selected"
                                : "workhub-group-member"
                            }
                            onClick={() =>
                              toggleGroupMember(
                                user.id
                              )
                            }
                          >

                            <div className="workhub-chat-avatar">

                              {user.full_name
                                ?.charAt(0)
                                ?.toUpperCase() ||
                                "U"}

                              {online && (
                                <span className="workhub-chat-online-dot" />
                              )}

                            </div>

                            <div className="workhub-group-member-info">

                              <strong>
                                {
                                  user.full_name
                                }
                              </strong>

                              <span>
                                {
                                  user.employee_id
                                }{" "}
                                •{" "}
                                {
                                  user.role
                                }
                              </span>

                            </div>

                            <div
                              className={
                                selected
                                  ? "workhub-group-checkbox selected"
                                  : "workhub-group-checkbox"
                              }
                            >

                              {selected && (
                                <FaCheck />
                              )}

                            </div>

                          </button>

                        );
                      }
                    )

                  )}

                </div>

                {/* ERROR */}

                {groupError && (

                  <div className="workhub-group-error">
                    {
                      groupError
                    }
                  </div>

                )}

              </div>

              {/* MODAL FOOTER */}

              <div className="workhub-group-modal-footer">

                <button
                  type="button"
                  className="workhub-group-cancel-button"
                  onClick={
                    closeGroupModal
                  }
                  disabled={
                    creatingGroup
                  }
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  className="workhub-group-create-button"
                  disabled={
                    creatingGroup ||
                    groupName
                      .trim()
                      .length <
                      2 ||
                    selectedMembers
                      .length <
                      1
                  }
                >

                  <FaUsers />

                  {creatingGroup
                    ? "Creating..."
                    : `Create Group${
                        selectedMembers.length
                          ? ` (${selectedMembers.length + 1})`
                          : ""
                      }`}

                </button>

              </div>

            </form>

          </div>

        </div>

  )}

  <ImageViewer
    image={previewImage}
    open={Boolean(previewImage)}
    onClose={() => setPreviewImage(null)}
  />
  </div>
  </>
);


// ==========================================
// ADMIN LAYOUT
// ==========================================

if (isAdmin) {
  return (
    <DragDrop onImageDrop={addAttachments}>
      {chatContent}
    </DragDrop>
  );
}

// ==========================================
// EMPLOYEE LAYOUT
// ==========================================

return (
  <DragDrop onImageDrop={addAttachments}>
    {chatContent}
  </DragDrop>
);

}

export default Chat;