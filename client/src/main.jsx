import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./styles/theme.css";
import "./styles/uiTokens.css";
import { reloadIfStaleBuild } from "./utils/buildVersion";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// A tab opened from a stale cached index.html reloads once as soon as it sees a newer deploy.
reloadIfStaleBuild();
