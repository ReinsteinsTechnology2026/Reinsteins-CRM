// ==========================================
// API ORIGIN (Phase 8 -- production readiness)
//
// Every backend URL in the client (REST base URLs, Socket.IO
// connection, and file/image URL construction) previously hardcoded
// "http://localhost:5000" directly, which only ever worked in local
// dev and would silently break the entire app against any deployed
// backend. VITE_API_URL lets a production build point at the real
// backend origin; the localhost fallback keeps `npm run dev` working
// exactly as before when the var is unset.
// ==========================================

export const API_ORIGIN = import.meta.env.VITE_API_URL || "http://localhost:5000";
