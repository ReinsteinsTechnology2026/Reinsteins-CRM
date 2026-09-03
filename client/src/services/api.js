import axios from "axios";

const api = axios.create({
  baseURL:
    "http://localhost:5000/api",

  headers: {
    "Content-Type":
      "application/json",
  },
});

// ==========================================
// REQUEST INTERCEPTOR
// ADD AUTH TOKEN TO EVERY REQUEST
// ==========================================

api.interceptors.request.use(
  (config) => {
    const token =
      sessionStorage.getItem(
        "token"
      );

    if (token) {
      config.headers.Authorization =
        `Bearer ${token}`;
    }

    return config;
  },

  (error) =>
    Promise.reject(
      error
    )
);

// ==========================================
// RESPONSE INTERCEPTOR
// HANDLE EXPIRED / INVALID TOKEN
// ==========================================

api.interceptors.response.use(
  (response) =>
    response,

  (error) => {
    if (
      error.response?.status ===
      401
    ) {
      sessionStorage.removeItem(
        "token"
      );

      sessionStorage.removeItem(
        "user"
      );
    }

    return Promise.reject(
      error
    );
  }
);

export default api;