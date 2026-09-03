import { useEffect, useRef, useState } from "react";

import { useNavigate } from "react-router-dom";

import { FaUsers, FaTimes } from "react-icons/fa";

import socket, { connectSocket } from "../services/socket";

import "./ChatNotificationListener.css";

const AUTO_DISMISS_MS = 5000;
const EXIT_ANIMATION_MS = 220;

function getCurrentUser() {

    try {
        return JSON.parse(sessionStorage.getItem("user"));
    } catch (error) {
        return null;
    }

}

// Popups only ever live for ~5 seconds, so this is realistically
// always "now" — computed for real rather than hardcoded so a
// popup that gets its timer reset several times in a row (a fast
// burst of messages) still reads correctly.

function formatRelativeTime(value) {

    if (!value) return "now";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) return "now";

    const diffSeconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));

    if (diffSeconds < 60) return "now";

    if (diffSeconds < 3600) return `${Math.round(diffSeconds / 60)}m ago`;

    return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

}

// ==========================================
// POPUP CARD
//
// Group avatar reuses the exact same convention
// already established in Chat.jsx's own sidebar
// (FaUsers icon for a group, sender's initial
// for a person) rather than inventing a new one.
// ==========================================

function ChatPopupCard({ popup, onOpen, onClose }) {

    const { isGroup, senderName, conversationName, preview, count, createdAt, closing } = popup;

    // Never "Group message" for a direct conversation, and never
    // the group name for a direct one — but a direct notification
    // still gets its own generic "Direct message" label, it's just
    // never the group-specific one.

    const kindLabel = isGroup
        ? (count > 1 ? `${count} new messages` : "Group message")
        : (count > 1 ? `${count} new messages` : "Direct message");

    return (

        <div
            className={closing ? "chat-popup-card closing" : "chat-popup-card"}
            onClick={onOpen}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen();
                }
            }}
        >

            <div className="chat-popup-header">

                <span className="chat-popup-avatar">
                    {isGroup ? <FaUsers /> : (senderName?.charAt(0)?.toUpperCase() || "?")}
                </span>

                <div className="chat-popup-title-block">

                    <strong className="chat-popup-title">{isGroup ? conversationName : senderName}</strong>

                    <span className="chat-popup-label">
                        {kindLabel} <span className="chat-popup-time-dot">•</span> {formatRelativeTime(createdAt)}
                    </span>

                </div>

                <button
                    type="button"
                    className="chat-popup-close"
                    onClick={(event) => {
                        event.stopPropagation();
                        onClose();
                    }}
                    aria-label="Dismiss notification"
                    title="Dismiss"
                >
                    <FaTimes />
                </button>

            </div>

            <div className="chat-popup-body">

                {isGroup && <span className="chat-popup-sender">{senderName}</span>}

                <p className="chat-popup-preview">{preview}</p>

            </div>

        </div>

    );

}

// ==========================================
// CHAT NOTIFICATION LISTENER
//
// Mounted exactly once in App.jsx (a sibling of
// <Routes>) so there is a single centralized
// "notification:new" listener for chat regardless
// of which page is active — avoids the duplicate-
// listener risk of mounting this inside Chat.jsx,
// the sidebars, or the header bells (which already
// have their own separate "notification:new"
// listener for the bell dropdown itself — that one
// is untouched; this component only adds the
// in-app popup layer on top of the same event).
//
// Renders its own small fixed-position popup stack
// (not react-toastify, not the native browser
// Notification API) so the 5-second auto-dismiss —
// including resetting to a full 5 seconds whenever
// the same conversation's popup is updated with a
// newer message — is exact plain setTimeout/
// clearTimeout, not dependent on a third-party
// library's update/timer behavior. This is the ONLY
// visible popup for an incoming chat message,
// regardless of tab focus/visibility. The app-wide
// <ToastContainer> in App.jsx (used by every other
// toast: login errors, task messages, etc.) is
// completely untouched, and the native browser
// Notification API is never called for chat.
//
// Every "notification:new" event fired for a chat
// message already reflects backend-verified
// recipients (conversation_members, sender
// excluded, active viewers excluded — for both
// group and private conversations) — this
// component does no filtering of its own.
// ==========================================

function ChatNotificationListener() {

    const navigate = useNavigate();

    const [popups, setPopups] = useState([]);

    const countsRef = useRef(new Map());
    const timersRef = useRef(new Map());

    // Single source of truth for removing a popup — used by the
    // auto-dismiss timer, the close (X) button, and clicking the
    // card to open the conversation. Only ever touches refs and
    // setPopups (both stable across renders), so it's safe to call
    // from inside the socket effect below without being redefined
    // there or added to its dependency array.

    function dismissPopup(conversationId) {

        const timer = timersRef.current.get(conversationId);

        if (timer) clearTimeout(timer);

        timersRef.current.delete(conversationId);
        countsRef.current.delete(conversationId);

        setPopups((current) =>
            current.map((popup) =>
                popup.id === conversationId ? { ...popup, closing: true } : popup
            )
        );

        setTimeout(() => {
            setPopups((current) => current.filter((popup) => popup.id !== conversationId));
        }, EXIT_ANIMATION_MS);

    }

    function scheduleAutoDismiss(conversationId) {

        const existing = timersRef.current.get(conversationId);

        if (existing) clearTimeout(existing);

        const timeoutId = setTimeout(() => dismissPopup(conversationId), AUTO_DISMISS_MS);

        timersRef.current.set(conversationId, timeoutId);

    }

    function handleOpen(conversationId) {

        dismissPopup(conversationId);

        const currentUser = getCurrentUser();
        const basePath = currentUser?.role === "admin" ? "/admin" : "/employee";

        navigate(`${basePath}/chat`, { state: { openConversationId: conversationId } });

    }

    useEffect(() => {

        connectSocket();

        function handleNewNotification(notification) {

            if (notification?.type !== "chat_message") return;

            const conversationId = notification.reference_id;

            if (!conversationId) return;

            const count = (countsRef.current.get(conversationId) || 0) + 1;
            countsRef.current.set(conversationId, count);

            const senderName = notification.senderName || "Someone";
            const conversationName = notification.conversationName || "";
            const preview = notification.preview || notification.message || "New message";
            const isGroup = Boolean(conversationName);

            // Always render the custom in-app card — the native
            // browser Notification API is intentionally never used
            // for chat messages (see browserNotification.js, which
            // is still used elsewhere for the header bell's opt-in
            // "Enable Desktop Notifications" permission button, but
            // nothing calls showBrowserNotification() for chat
            // anymore, so it can never produce a native popup here).

            setPopups((current) => {

                const nextPopup = {
                    id: conversationId,
                    isGroup,
                    senderName,
                    conversationName,
                    preview,
                    count,
                    createdAt: notification.created_at,
                    closing: false,
                };

                const alreadyShown = current.some((popup) => popup.id === conversationId);

                if (alreadyShown) {
                    return current.map((popup) => (popup.id === conversationId ? nextPopup : popup));
                }

                return [...current, nextPopup];

            });

            scheduleAutoDismiss(conversationId);

        }

        socket.on("notification:new", handleNewNotification);

        const timers = timersRef.current;

        return () => {
            socket.off("notification:new", handleNewNotification);
            timers.forEach((timeoutId) => clearTimeout(timeoutId));
            timers.clear();
        };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [navigate]);

    if (popups.length === 0) return null;

    return (

        <div className="chat-popup-stack">

            {popups.map((popup) => (
                <ChatPopupCard
                    key={popup.id}
                    popup={popup}
                    onOpen={() => handleOpen(popup.id)}
                    onClose={() => dismissPopup(popup.id)}
                />
            ))}

        </div>

    );

}

export default ChatNotificationListener;
