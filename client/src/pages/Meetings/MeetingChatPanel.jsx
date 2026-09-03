import { useEffect, useRef, useState } from "react";

import {
    FaTimes,
    FaPaperPlane,
    FaComments,
    FaArrowDown,
    FaPaperclip,
    FaSpinner,
    FaFilePdf,
    FaFileWord,
    FaFileExcel,
    FaFilePowerpoint,
    FaFileArchive,
    FaFileAlt,
    FaCloudUploadAlt,
} from "react-icons/fa";

import { toast } from "react-toastify";

import ImageViewer from "../Chat/Features/ImageViewer";

// All Meeting Room / Meeting Chat styling — including this panel's
// — already lives consolidated in MeetingRoom.css (no separate
// per-component CSS file exists in this feature); MeetingRoom.jsx
// always renders alongside this component, so that stylesheet is
// already loaded whenever this one is.

// ==========================================
// MEETING CHAT PANEL
//
// Purely presentational — MeetingRoom.jsx owns
// the message list (loaded via the existing
// GET /:id/messages REST call and kept live via
// the existing meeting:chat-message broadcast,
// both already built in Phase 5). This panel is
// meeting-specific and does not touch the
// separate global WorkHub Chat module/table.
//
// STAGED ATTACHMENT FLOW: the paperclip button,
// Ctrl+V/Cmd+V paste, and drag-and-drop all call
// the SAME stageAttachment() — which only
// validates the file and stores it in local
// pendingAttachments state (a File object + a
// local preview URL). Nothing is uploaded until
// the user clicks Send. Send is what calls
// onSendAttachment() (MeetingRoom.jsx's
// handleSendChatAttachment -> the existing
// sendMeetingAttachment API call) — one call per
// staged file, sequentially — which remains the
// single place that actually talks to the
// backend, exactly as before.
//
// Closing this panel (either via the X below or
// the toolbar Chat button in MeetingRoom.jsx)
// only hides this component — it does not touch
// Socket.IO, WebRTC, or the message list, which
// is why there's no local message state here at
// all; messages/onClose both come straight from
// the parent's single source of truth.
// ==========================================

// How close to the bottom (in px) counts as
// "already at the bottom" for auto-scroll
// purposes.

const NEAR_BOTTOM_THRESHOLD = 80;

// Exact same whitelist as meetingUploadMiddleware.js (and, in turn,
// chatUploadMiddleware.js) — the single source of truth for which
// MIME types are actually allowed. Used here for a fast, friendly
// client-side check on ALL THREE entry points (button/paste/drop);
// the backend remains the real authority regardless.

const ALLOWED_MIME_TYPES = [
    "image/jpeg",
    "image/jpg",
    "image/png",
    "image/webp",
    "image/gif",
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "text/plain",
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
];

// <input accept> works more reliably as a mix of MIME types and
// extensions across browsers/OSes — derived from the same list
// above rather than maintained separately.

const ACCEPTED_FILE_TYPES = [
    ...ALLOWED_MIME_TYPES,
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".zip", ".rar",
].join(",");

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

function isSupportedFileType(file) {
    return ALLOWED_MIME_TYPES.includes(file.type);
}

function formatTime(value) {

    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

}

function formatFileSize(bytes) {

    const size = Number(bytes);

    if (!size) return "";

    if (size < 1024) return `${size} B`;

    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;

    return `${(size / (1024 * 1024)).toFixed(1)} MB`;

}

function fileIconFor(mimeType) {

    if (mimeType === "application/pdf") return <FaFilePdf />;

    if (mimeType?.includes("word")) return <FaFileWord />;

    if (mimeType?.includes("excel") || mimeType?.includes("spreadsheet")) return <FaFileExcel />;

    if (mimeType?.includes("powerpoint") || mimeType?.includes("presentation")) return <FaFilePowerpoint />;

    if (mimeType?.includes("zip") || mimeType?.includes("rar")) return <FaFileArchive />;

    return <FaFileAlt />;

}

// Backend returns a relative /uploads/... path — same convention
// already used by normal WorkHub Chat's attachment URLs.

function buildAttachmentUrl(path) {
    return `http://localhost:5000${path}`;
}

function generatePendingId() {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function MeetingChatPanel({ messages, currentUserId, onSend, onSendAttachment, onClose, sending, uploadingAttachment }) {

    const [draft, setDraft] = useState("");

    const [isNearBottom, setIsNearBottom] = useState(true);

    const [newMessageCount, setNewMessageCount] = useState(0);

    const [previewImageUrl, setPreviewImageUrl] = useState(null);

    const [isDraggingFile, setIsDraggingFile] = useState(false);

    const [pendingAttachments, setPendingAttachments] = useState([]);

    const [sendingAttachments, setSendingAttachments] = useState(false);

    const listRef = useRef(null);

    const fileInputRef = useRef(null);

    const panelRef = useRef(null);

    const dragCounterRef = useRef(0);

    const previousMessageCountRef = useRef(messages.length);

    // Always reflects the LATEST pendingAttachments, for the
    // unmount-cleanup effect below (which must not close over a
    // stale, empty array from the initial render).

    const pendingAttachmentsRef = useRef([]);

    useEffect(() => {
        pendingAttachmentsRef.current = pendingAttachments;
    }, [pendingAttachments]);

    // Every time the panel is opened (mounted — MeetingRoom.jsx
    // only renders this component while showChat is true, so
    // opening it is a fresh mount) it should land on the latest
    // message, same as any chat app, rather than wherever a fresh
    // DOM element happens to default to.

    useEffect(() => {

        if (listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight;
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Revoke any still-staged preview object URLs when the panel
    // closes/unmounts, so closing Chat with an unsent image staged
    // doesn't leak that blob URL.

    useEffect(() => {

        return () => {
            pendingAttachmentsRef.current.forEach((attachment) => {
                if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
            });
        };

    }, []);

    // ==========================================
    // AUTO-SCROLL
    // Jumps to the newest message only when the
    // user was already near the bottom. If they
    // scrolled up to read history, a new message
    // instead just increments a small counter
    // shown on the "New messages" button.
    // ==========================================

    useEffect(() => {

        const grew = messages.length > previousMessageCountRef.current;
        previousMessageCountRef.current = messages.length;

        if (!grew) return;

        if (isNearBottom) {

            listRef.current?.scrollTo({
                top: listRef.current.scrollHeight,
                behavior: "smooth",
            });

            setNewMessageCount(0);

        } else {

            setNewMessageCount((count) => count + 1);

        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [messages.length]);

    function handleScroll() {

        const node = listRef.current;

        if (!node) return;

        const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;

        const nearBottom = distanceFromBottom < NEAR_BOTTOM_THRESHOLD;

        setIsNearBottom(nearBottom);

        if (nearBottom) setNewMessageCount(0);

    }

    function scrollToBottom() {

        listRef.current?.scrollTo({
            top: listRef.current.scrollHeight,
            behavior: "smooth",
        });

        setNewMessageCount(0);
        setIsNearBottom(true);

    }

    // ==========================================
    // STAGE AN ATTACHMENT (validate + local-only)
    // The single entry point the paperclip button,
    // paste, and drop all call. Never uploads —
    // only adds a validated file to
    // pendingAttachments with a local preview URL.
    // ==========================================

    function stageAttachment(file) {

        if (!file) return;

        if (!isSupportedFileType(file)) {
            toast.error(`"${file.name}" isn't a supported file type.`);
            return;
        }

        if (file.size > MAX_ATTACHMENT_BYTES) {
            toast.error(`"${file.name}" is too large. Maximum size is 50MB.`);
            return;
        }

        const isImage = file.type.startsWith("image/");

        const attachment = {
            id: generatePendingId(),
            file,
            name: file.name,
            type: file.type,
            size: file.size,
            previewUrl: isImage ? URL.createObjectURL(file) : null,
        };

        setPendingAttachments((current) => [...current, attachment]);

    }

    function removeAttachment(id) {

        setPendingAttachments((current) => {

            const target = current.find((attachment) => attachment.id === id);

            if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);

            return current.filter((attachment) => attachment.id !== id);

        });

    }

    // ==========================================
    // SEND
    // Text (if any) is sent exactly as it always
    // was — fired immediately, draft cleared right
    // away, unchanged from the existing behavior.
    // Staged attachments (if any) are THEN uploaded
    // one at a time through the existing per-file
    // upload call. A failed attachment stays in
    // pendingAttachments (for retry) instead of
    // being cleared, and already-successful ones in
    // the same batch are never re-uploaded.
    // ==========================================

    async function handleSubmit(event) {

        event.preventDefault();

        if (sendingAttachments) return;

        const text = draft.trim();
        const hasPending = pendingAttachments.length > 0;

        if (!text && !hasPending) return;

        if (text) {
            onSend(text);
            setDraft("");
        }

        if (hasPending) {

            setSendingAttachments(true);

            const stillPending = [];

            for (const attachment of pendingAttachments) {

                try {

                    // eslint-disable-next-line no-await-in-loop
                    await onSendAttachment(attachment.file);

                    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);

                } catch (error) {

                    console.error(error);

                    toast.error(`"${attachment.name}" failed to send. It's still staged — click Send to try again.`);

                    stillPending.push(attachment);

                }

            }

            setPendingAttachments(stillPending);

            setSendingAttachments(false);

        }

        requestAnimationFrame(scrollToBottom);

    }

    function handleAttachClick() {

        if (sending || uploadingAttachment || sendingAttachments) return;

        fileInputRef.current?.click();

    }

    function handleFileSelected(event) {

        const file = event.target.files?.[0];

        // Always clear the input value, even on validation failure,
        // so selecting the exact same file again still fires onChange.

        event.target.value = "";

        stageAttachment(file);

    }

    // ==========================================
    // CTRL+V / CMD+V PASTE
    // Scoped to this panel (not window) so it
    // never interferes with pasting anywhere else
    // in WorkHub. Only preventDefault()s once an
    // actual file/image is found in the clipboard
    // — plain text paste into the message input
    // is left completely alone. Same native
    // "paste" event fires for both Ctrl+V and
    // Cmd+V, so one handler covers both.
    // ==========================================

    function handlePaste(event) {

        const items = event.clipboardData?.items;

        if (!items || items.length === 0) return;

        let pastedFile = null;

        for (const item of items) {
            if (item.kind === "file") {
                const candidate = item.getAsFile();
                if (candidate) {
                    pastedFile = candidate;
                    break;
                }
            }
        }

        // Nothing file-like on the clipboard — let the browser's
        // normal text paste behavior proceed untouched.

        if (!pastedFile) return;

        event.preventDefault();

        stageAttachment(pastedFile);

    }

    // ==========================================
    // DRAG AND DROP
    // Uses a drag counter (not a plain boolean)
    // so dragging over child elements inside the
    // panel — which fires extra dragenter/dragleave
    // pairs as the pointer crosses element
    // boundaries — never flickers the overlay.
    // Dropped files are staged, exactly like the
    // paperclip/paste — nothing uploads here.
    // ==========================================

    function hasFilesInDrag(event) {
        return Array.from(event.dataTransfer?.types || []).includes("Files");
    }

    function handleDragEnter(event) {

        if (!hasFilesInDrag(event)) return;

        event.preventDefault();

        dragCounterRef.current += 1;

        setIsDraggingFile(true);

    }

    function handleDragOver(event) {

        if (!hasFilesInDrag(event)) return;

        // Required for onDrop to fire at all, and to show the
        // "copy" cursor instead of the browser's "forbidden" one.

        event.preventDefault();

        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";

    }

    function handleDragLeave(event) {

        if (!hasFilesInDrag(event)) return;

        event.preventDefault();

        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);

        if (dragCounterRef.current === 0) setIsDraggingFile(false);

    }

    function handleDrop(event) {

        event.preventDefault();

        dragCounterRef.current = 0;
        setIsDraggingFile(false);

        const files = Array.from(event.dataTransfer?.files || []);

        if (files.length === 0) return;

        // Staging is local/synchronous (no network call), so every
        // dropped file can be validated and staged immediately —
        // invalid ones get their own error toast, valid ones are
        // added, nothing is silently lost.

        files.forEach(stageAttachment);

    }

    return (

        <div
            className="meeting-room-side-panel meeting-chat-panel"
            ref={panelRef}
            onPaste={handlePaste}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >

            <div className="meeting-room-participants-header">

                <h3><FaComments /> Meeting Chat</h3>

                <button
                    type="button"
                    className="meeting-panel-close-button"
                    onClick={onClose}
                    aria-label="Close chat panel"
                    title="Close chat"
                >
                    <FaTimes />
                </button>

            </div>

            <div className="meeting-chat-messages" ref={listRef} onScroll={handleScroll}>

                {messages.length === 0 ? (

                    <div className="meeting-chat-empty">
                        <FaComments />
                        <p>No messages yet. Say hello!</p>
                    </div>

                ) : (

                    messages.map((message) => {

                        const isOwn = Number(message.sender_id) === Number(currentUserId);

                        return (

                            <div
                                key={message.id}
                                className={isOwn ? "meeting-chat-message own" : "meeting-chat-message"}
                            >
                                {!isOwn && <span className="meeting-chat-sender">{message.sender_name}</span>}
                                {isOwn && <span className="meeting-chat-sender">You</span>}

                                {message.message_type === "image" ? (

                                    <img
                                        src={buildAttachmentUrl(message.image)}
                                        alt="Shared attachment"
                                        className="meeting-chat-image"
                                        onClick={() => setPreviewImageUrl(buildAttachmentUrl(message.image))}
                                    />

                                ) : message.message_type === "file" ? (

                                    <a
                                        className="meeting-chat-file"
                                        href={buildAttachmentUrl(message.image)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        <span className="meeting-chat-file-icon">{fileIconFor(message.mime_type)}</span>
                                        <span className="meeting-chat-file-info">
                                            <strong>{message.file_name}</strong>
                                            {message.file_size ? <span>{formatFileSize(message.file_size)}</span> : null}
                                        </span>
                                    </a>

                                ) : (

                                    <span className="meeting-chat-bubble">{message.message_text}</span>

                                )}

                                <span className="meeting-chat-time">{formatTime(message.created_at)}</span>
                            </div>

                        );

                    })

                )}

            </div>

            {!isNearBottom && newMessageCount > 0 && (

                <button
                    type="button"
                    className="meeting-chat-new-messages-button"
                    onClick={scrollToBottom}
                >
                    <FaArrowDown /> {newMessageCount === 1 ? "New message" : `${newMessageCount} new messages`}
                </button>

            )}

            {pendingAttachments.length > 0 && (

                <div className="meeting-chat-pending-row">

                    {pendingAttachments.map((attachment) => (

                        <div key={attachment.id} className="meeting-chat-pending-item">

                            {attachment.previewUrl ? (

                                <img
                                    src={attachment.previewUrl}
                                    alt={attachment.name}
                                    className="meeting-chat-pending-thumb"
                                />

                            ) : (

                                <div className="meeting-chat-pending-file" title={attachment.name}>
                                    <span className="meeting-chat-pending-file-icon">{fileIconFor(attachment.type)}</span>
                                    <span className="meeting-chat-pending-file-name">{attachment.name}</span>
                                    <span className="meeting-chat-pending-file-size">{formatFileSize(attachment.size)}</span>
                                </div>

                            )}

                            <button
                                type="button"
                                className="meeting-chat-pending-remove"
                                onClick={() => removeAttachment(attachment.id)}
                                disabled={sendingAttachments}
                                aria-label={`Remove ${attachment.name}`}
                                title="Remove"
                            >
                                <FaTimes />
                            </button>

                        </div>

                    ))}

                </div>

            )}

            <form className="meeting-chat-input-row" onSubmit={handleSubmit}>

                <input
                    ref={fileInputRef}
                    type="file"
                    accept={ACCEPTED_FILE_TYPES}
                    style={{ display: "none" }}
                    onChange={handleFileSelected}
                />

                <button
                    type="button"
                    className="meeting-chat-attach-button"
                    onClick={handleAttachClick}
                    disabled={sending || uploadingAttachment || sendingAttachments}
                    aria-label="Attach a file"
                    title="Attach a file"
                >
                    <FaPaperclip />
                </button>

                <input
                    type="text"
                    placeholder="Type a message..."
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={2000}
                    aria-label="Type a message"
                    disabled={sendingAttachments}
                />

                <button
                    type="submit"
                    disabled={(!draft.trim() && pendingAttachments.length === 0) || sending || uploadingAttachment || sendingAttachments}
                    aria-label="Send message"
                    title="Send"
                >
                    {sendingAttachments || uploadingAttachment ? <FaSpinner className="meeting-chat-spin" /> : <FaPaperPlane />}
                </button>

            </form>

            {isDraggingFile && (

                <div className="meeting-chat-drop-overlay">
                    <FaCloudUploadAlt />
                    <p>Drop files to send</p>
                </div>

            )}

            <ImageViewer
                image={previewImageUrl}
                open={Boolean(previewImageUrl)}
                onClose={() => setPreviewImageUrl(null)}
            />

        </div>

    );

}

export default MeetingChatPanel;
