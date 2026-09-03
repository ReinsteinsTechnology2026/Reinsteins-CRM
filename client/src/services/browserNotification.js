// ==========================================
// BROWSER (DESKTOP) NOTIFICATION HELPERS
//
// Thin wrapper around the native Notification
// API. Permission is never requested
// automatically — only ever from an explicit
// user click (see the "Enable Desktop
// Notifications" action in AdminHeader.jsx /
// EmployeeHeader.jsx). This intentionally does
// NOT implement Web Push / service worker push —
// it only works while this browser tab/window is
// open and connected, which is the documented
// scope for this phase.
// ==========================================

export function isNotificationSupported() {
    return typeof window !== "undefined" && "Notification" in window;
}

export function getNotificationPermission() {
    if (!isNotificationSupported()) return "unsupported";
    return Notification.permission;
}

export async function requestNotificationPermission() {

    if (!isNotificationSupported()) return "unsupported";

    try {
        return await Notification.requestPermission();
    } catch (error) {
        console.error("Notification permission request failed:", error);
        return Notification.permission;
    }

}

// tag: reusing the same tag replaces/updates the previous
// notification instead of stacking a new one (native
// equivalent of the toast's "N new messages" grouping).

export function showBrowserNotification({ tag, title, body, onClick }) {

    if (!isNotificationSupported() || Notification.permission !== "granted") {
        return null;
    }

    let notification;

    try {
        notification = new Notification(title, { body, tag, renotify: true });
    } catch (error) {
        console.error("Unable to show browser notification:", error);
        return null;
    }

    if (typeof onClick === "function") {

        notification.onclick = () => {
            window.focus();
            onClick();
            notification.close();
        };

    }

    return notification;

}
