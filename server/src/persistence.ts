import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunningAgent, TranscriptEvent } from "@agent-control/shared";

export interface PersistedState {
  agents: RunningAgent[];
  transcripts: Record<string, TranscriptEvent[]>;
}

const stateDir = path.join(os.homedir(), ".agent-dashboard");
const statePath = path.join(stateDir, "state.json");

async function ensurePrivateDir(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

export async function readPersistedState(): Promise<PersistedState> {
  try {
    await ensurePrivateDir(stateDir);
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as PersistedState;
  } catch {
    return { agents: [], transcripts: {} };
  }
}

export function createStateWriter(getState: () => PersistedState) {
  let timer: NodeJS.Timeout | undefined;

  return function scheduleWrite() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        await ensurePrivateDir(stateDir);
        await writeFile(statePath, `${JSON.stringify(getState(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await chmod(statePath, 0o600).catch(() => undefined);
      } catch (error) {
        console.error("Failed to persist dashboard state", error);
      }
    }, 500);
  };
}
