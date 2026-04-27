import type { WsClientCommand, WsServerEvent } from "@agent-control/shared";
import { useAppStore } from "../store/app-store";

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let attempt = 0;

function wsUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export function connectWebSocket() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

  socket = new WebSocket(wsUrl());
  socket.addEventListener("open", () => {
    attempt = 0;
    useAppStore.getState().setWsConnected(true);
    sendCommand({ type: "snapshot" });
  });
  socket.addEventListener("message", (message) => {
    try {
      useAppStore.getState().handleServerEvent(JSON.parse(message.data) as WsServerEvent);
    } catch {
      useAppStore.getState().addError("Received an invalid WebSocket event.");
    }
  });
  socket.addEventListener("close", () => {
    useAppStore.getState().setWsConnected(false);
    const delay = Math.min(10000, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = window.setTimeout(connectWebSocket, delay);
  });
}

export function disconnectWebSocket() {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  socket?.close();
  socket = undefined;
}

export function sendCommand(command: WsClientCommand) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    useAppStore.getState().addError("WebSocket is not connected yet.");
    return;
  }
  socket.send(JSON.stringify(command));
}
