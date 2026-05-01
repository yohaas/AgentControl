import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunningAgent, SavedChat, TranscriptEvent } from "@agent-hero/shared";
import { migrateLegacyStateDir, statePath as resolveStatePath } from "./storage.js";

export interface PersistedState {
  agents: RunningAgent[];
  transcripts: Record<string, TranscriptEvent[]>;
  savedChats?: SavedChat[];
}

const stateDir = resolveStatePath();
const persistedStatePath = path.join(stateDir, "state.json");

async function ensurePrivateDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

export async function readPersistedState(): Promise<PersistedState> {
  try {
    await migrateLegacyStateDir();
    await ensurePrivateDir(stateDir);
    const raw = await readFile(persistedStatePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    return { agents: parsed.agents || [], transcripts: parsed.transcripts || {}, savedChats: parsed.savedChats || [] };
  } catch {
    return { agents: [], transcripts: {}, savedChats: [] };
  }
}

export function createStateWriter(getState: () => PersistedState) {
  let timer: NodeJS.Timeout | undefined;

  return function scheduleWrite() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await ensurePrivateDir(stateDir);
        await writeFile(persistedStatePath, `${JSON.stringify(getState(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(persistedStatePath, 0o600).catch(() => undefined);
      } catch (error) {
        console.error("Failed to persist dashboard state", error);
      }
    }, 500);
  };
}
