import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { keepsBrowserMenu } from "./components/ContextMenu";
import "./branding/tm-tokens.css";
import "./branding/tm-icons.css";
import "./index.css";

// The webview's own right-click menu (Back, Refresh, Save as, Print) is a
// browser's, not T-Money's: Back and Refresh throw away what is on screen.
// It stays in text boxes and on selected text, where Cut, Copy and Paste are
// what a right-click is for; everywhere else a list's own menu
// (ContextMenu.tsx) answers, or nothing does.
window.addEventListener("contextmenu", (e) => {
  if (!keepsBrowserMenu(e.target, window.getSelection()?.toString() ?? "")) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
