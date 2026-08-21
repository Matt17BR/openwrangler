import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { WebviewErrorBoundary } from "./WebviewErrorBoundary";
import "@vscode/codicons/dist/codicon.css";
import "./styles.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Open Wrangler root element not found.");
}

createRoot(root).render(
  <React.StrictMode>
    <WebviewErrorBoundary>
      <App />
    </WebviewErrorBoundary>
  </React.StrictMode>
);
