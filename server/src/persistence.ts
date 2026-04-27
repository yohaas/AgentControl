import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunningAgent, TranscriptEvent } from "@agent-control/shared";

export interface PersistedState {
  agents: RunningAgent[];
  transcripts: Record<string, TranscriptEvent[]>;
}

const stateDir = path.join(os.homedir(), ".agent-dashboard");
const statePath = path.join(stateDir, "state.json");

export async function readPersistedState(): Promise<PersistedState> {
  try {
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
        await mkdir(stateDir, { recursive: true });
        await writeFile(statePath, `${JSON.stringify(getState(), null, 2)}\n`, "utf8");
      } catch (error) {
        console.error("Failed to persist dashboard state", error);
      }
    }, 500);
  };
}
