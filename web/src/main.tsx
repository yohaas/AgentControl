import React from "react";
import ReactDOM from "react-dom/client";
import { App, TerminalPopoutApp } from "./App";
import "./index.css";

const Root = window.location.pathname === "/terminal-popout" ? TerminalPopoutApp : App;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
