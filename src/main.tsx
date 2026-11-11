import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { logClientEvent } from "./features/repositories/api";
import "./styles.css";

const applyViewportSize = () => {
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
};

applyViewportSize();
window.addEventListener("resize", applyViewportSize);
window.visualViewport?.addEventListener("resize", applyViewportSize);

window.addEventListener("error", (event) => {
  void logClientEvent(
    "frontend.error",
    event.message || "Uncaught render error",
    event.error instanceof Error
      ? event.error.stack ?? event.error.message
      : String(event.error ?? ""),
  ).catch(() => {});
});

window.addEventListener("unhandledrejection", (event) => {
  void logClientEvent(
    "frontend.unhandled-rejection",
    "Unhandled promise rejection",
    event.reason instanceof Error
      ? event.reason.stack ?? event.reason.message
      : String(event.reason ?? ""),
  ).catch(() => {});
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
