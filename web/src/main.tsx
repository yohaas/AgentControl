import React from "react";
import ReactDOM from "react-dom/client";
import { App, FileExplorerPopoutApp, MobileApp, TerminalPopoutApp } from "./App";
import "./index.css";

const Root =
  window.location.pathname === "/terminal-popout"
    ? TerminalPopoutApp
    : window.location.pathname === "/file-explorer-popout"
      ? FileExplorerPopoutApp
      : window.location.pathname === "/mobile"
        ? MobileApp
      : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
