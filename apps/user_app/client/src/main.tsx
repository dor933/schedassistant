import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "./context/AuthContext";
import { ToastProvider } from "./components/Toast";
import App from "./App";
import "./index.css";

/** Matches Vite `base` (e.g. `/claw/` → basename `/claw`). Root deploy uses no basename. */
function routerBasename(): string | undefined {
  const base = import.meta.env.BASE_URL;
  if (base === "/" || base === "") return undefined;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename={routerBasename()}>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
