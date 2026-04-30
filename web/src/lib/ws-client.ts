import type { WsClientCommand, WsServerEvent } from "@agent-control/shared";
import { useAppStore } from "../store/app-store";
import { agentControlToken } from "./api";

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let attempt = 0;
let connecting = false;

function wsUrl(token: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
}

export async function connectWebSocket() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  connecting = true;
  let token: string;
  try {
    token = await agentControlToken();
  } catch (error) {
    connecting = false;
    useAppStore.getState().addError(error instanceof Error ? error.message : String(error));
    const delay = Math.min(10000, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = window.setTimeout(() => void connectWebSocket(), delay);
    return;
  }

  const nextSocket = new WebSocket(wsUrl(token));
  socket = nextSocket;
  connecting = false;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    attempt = 0;
    useAppStore.getState().setWsConnected(true);
    sendCommand({ type: "snapshot" });
  });
  nextSocket.addEventListener("message", (message) => {
    if (socket !== nextSocket) return;
    try {
      useAppStore.getState().handleServerEvent(JSON.parse(message.data) as WsServerEvent);
    } catch {
      useAppStore.getState().addError("Received an invalid WebSocket event.");
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    useAppStore.getState().setWsConnected(false);
    socket = undefined;
    const delay = Math.min(10000, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = window.setTimeout(() => void connectWebSocket(), delay);
  });
}

export function disconnectWebSocket() {
  if (reconnectTimer) window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  connecting = false;
  const currentSocket = socket;
  socket = undefined;
  useAppStore.getState().setWsConnected(false);
  if (!currentSocket) return;
  if (currentSocket.readyState === WebSocket.CONNECTING) {
    currentSocket.addEventListener("open", () => currentSocket.close(), { once: true });
    currentSocket.addEventListener("error", () => undefined, { once: true });
    return;
  }
  currentSocket.close();
}

export function sendCommand(command: WsClientCommand): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    useAppStore.getState().addError("Backend server not running.");
    return false;
  }
  try {
    socket.send(JSON.stringify(command));
    return true;
  } catch (error) {
    useAppStore.getState().addError(error instanceof Error ? error.message : String(error));
    return false;
  }
}
