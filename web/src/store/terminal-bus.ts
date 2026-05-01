const MAX_CHUNKS = 1200;
const LAST_LINE_THROTTLE_MS = 120;
const ACTIVITY_THROTTLE_MS = 750;

export type TerminalEvent =
  | { type: "chunk"; chunk: string }
  | { type: "clear" }
  | { type: "replace"; chunks: string[] };

const buffers = new Map<string, string[]>();
const listeners = new Map<string, Set<(event: TerminalEvent) => void>>();
const lastLineListeners = new Map<string, Set<() => void>>();
const lastLineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const activityListeners = new Set<(id: string, at: number) => void>();
const activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastActivity = new Map<string, number>();
const pendingActivity = new Map<string, number>();

function emit(id: string, event: TerminalEvent) {
  const set = listeners.get(id);
  if (!set) return;
  set.forEach((fn) => fn(event));
}

function notifyLastLine(id: string) {
  if (lastLineTimers.has(id)) return;
  const timer = setTimeout(() => {
    lastLineTimers.delete(id);
    const set = lastLineListeners.get(id);
    if (!set) return;
    set.forEach((fn) => fn());
  }, LAST_LINE_THROTTLE_MS);
  lastLineTimers.set(id, timer);
}

function noteActivity(id: string) {
  const at = Date.now();
  pendingActivity.set(id, at);
  if (activityTimers.has(id)) return;
  const timer = setTimeout(() => {
    activityTimers.delete(id);
    const finalAt = pendingActivity.get(id) ?? at;
    pendingActivity.delete(id);
    lastActivity.set(id, finalAt);
    activityListeners.forEach((fn) => fn(id, finalAt));
  }, ACTIVITY_THROTTLE_MS);
  activityTimers.set(id, timer);
}

export function getBuffer(id: string): string[] {
  return buffers.get(id) ?? [];
}

export function setBuffer(id: string, chunks: string[]): void {
  const trimmed = chunks.length > MAX_CHUNKS ? chunks.slice(-MAX_CHUNKS) : chunks.slice();
  buffers.set(id, trimmed);
  emit(id, { type: "replace", chunks: trimmed });
  notifyLastLine(id);
}

export function appendChunk(id: string, chunk: string): void {
  let buf = buffers.get(id);
  if (!buf) {
    buf = [];
    buffers.set(id, buf);
  }
  buf.push(chunk);
  if (buf.length > MAX_CHUNKS) buf.splice(0, buf.length - MAX_CHUNKS);
  emit(id, { type: "chunk", chunk });
  notifyLastLine(id);
  noteActivity(id);
}

export function clearBuffer(id: string): void {
  buffers.set(id, []);
  emit(id, { type: "clear" });
  notifyLastLine(id);
}

export function removeBuffer(id: string): void {
  buffers.delete(id);
  listeners.delete(id);
  lastLineListeners.delete(id);
  const timer = lastLineTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    lastLineTimers.delete(id);
  }
  const activityTimer = activityTimers.get(id);
  if (activityTimer) {
    clearTimeout(activityTimer);
    activityTimers.delete(id);
  }
  pendingActivity.delete(id);
  lastActivity.delete(id);
}

export function subscribe(id: string, fn: (event: TerminalEvent) => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(id);
  };
}

export function subscribeLastLine(id: string, fn: () => void): () => void {
  let set = lastLineListeners.get(id);
  if (!set) {
    set = new Set();
    lastLineListeners.set(id, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) lastLineListeners.delete(id);
  };
}

export function subscribeActivity(fn: (id: string, at: number) => void): () => void {
  activityListeners.add(fn);
  return () => {
    activityListeners.delete(fn);
  };
}

export function getLastActivity(id: string): number | undefined {
  return lastActivity.get(id);
}
