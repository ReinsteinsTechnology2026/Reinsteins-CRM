import axios from "axios";

import { API_ORIGIN } from "../config";

// ==========================================
// PLATFORM API CLIENT (Phase 4)
//
// Deliberately a SEPARATE axios instance from services/api.js (the
// tenant/company API client) -- mirrors its exact structure, but
// reads/writes "platformToken" / "platformUser" in sessionStorage,
// never the tenant portal's "token" / "user" keys. A Platform Owner
// session and a tenant session can coexist in the same browser
// without either one overwriting or authenticating as the other.
// ==========================================

const platformApi = axios.create({
  baseURL: `${API_ORIGIN}/api/platform`,
  headers: {
    "Content-Type": "application/json",
  },
});

platformApi.interceptors.request.use(
  (config) => {
    const token = sessionStorage.getItem("platformToken");

    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    return config;
  },
  (error) => Promise.reject(error)
);

platformApi.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      sessionStorage.removeItem("platformToken");
      sessionStorage.removeItem("platformUser");
    }

    return Promise.reject(error);
  }
);

export default platformApi;
