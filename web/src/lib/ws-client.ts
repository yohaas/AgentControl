import type { WsClientCommand, WsServerEvent } from "@agent-control/shared";
import { useAppStore } from "../store/app-store";
import { storedAgentControlToken } from "./api";

let socket: WebSocket | undefined;
let reconnectTimer: number | undefined;
let attempt = 0;
let connecting = false;
let lastSyncedMessageQueues = "";

function wsUrl(token?: string) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${window.location.host}/ws${query}`;
}

export async function connectWebSocket() {
  if (connecting || (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))) return;
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }

  connecting = true;
  const token = storedAgentControlToken();

  const nextSocket = new WebSocket(wsUrl(token));
  socket = nextSocket;
  connecting = false;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    attempt = 0;
    useAppStore.getState().setWsConnected(true);
    sendCommand({ type: "snapshot" });
    sendMessageQueues();
  });
  nextSocket.addEventListener("message", (message) => {
    if (socket !== nextSocket) return;
    try {
      const event = JSON.parse(message.data) as WsServerEvent;
      if (event.type === "agent.message_queues") lastSyncedMessageQueues = JSON.stringify(event.messageQueues);
      if (event.type === "agent.snapshot" && event.snapshot.messageQueues) {
        lastSyncedMessageQueues = JSON.stringify(event.snapshot.messageQueues);
      }
      useAppStore.getState().handleServerEvent(event);
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
    useAppStore.getState().addError("WebSocket is not connected.");
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

function sendMessageQueues() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const messageQueues = useAppStore.getState().messageQueues;
  const serialized = JSON.stringify(messageQueues);
  if (serialized === "{}" || serialized === lastSyncedMessageQueues) return;
  lastSyncedMessageQueues = serialized;
  socket.send(JSON.stringify({ type: "messageQueues", messageQueues } satisfies WsClientCommand));
}

useAppStore.subscribe((state, previousState) => {
  if (state.messageQueues !== previousState.messageQueues) sendMessageQueues();
});
