import {
  io,
} from "socket.io-client";

// ==========================================
// SOCKET.IO CLIENT
// ==========================================

const socket = io(
  "http://localhost:5000",
  {
    autoConnect: false,

    transports: [
      "websocket",
      "polling",
    ],
  }
);

// ==========================================
// CONNECT SOCKET
// ==========================================

export const connectSocket =
  () => {
    const token =
      sessionStorage.getItem(
        "token"
      );

    if (!token) {
      return;
    }

    // Attach latest authentication token

    socket.auth = {
      token,
    };

    // Prevent duplicate connection

    if (
      !socket.connected
    ) {
      socket.connect();
    }
  };

// ==========================================
// DISCONNECT SOCKET
// ==========================================

export const disconnectSocket =
  () => {
    if (
      socket.connected
    ) {
      socket.disconnect();
    }
  };

// ==========================================
// EXPORT SOCKET
// ==========================================

export default socket;