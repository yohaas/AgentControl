import { access, chmod, cp, mkdir, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const STATE_DIR_NAME = ".agent-control";
export const LEGACY_STATE_DIR_NAME = ".agent-dashboard";

export const STATE_DIR = path.join(os.homedir(), STATE_DIR_NAME);
export const LEGACY_STATE_DIR = path.join(os.homedir(), LEGACY_STATE_DIR_NAME);

const MIGRATED_ENTRIES = ["config.json", "secrets.json", "state.json", "attachments", "terminal-history"];

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export function statePath(...segments: string[]): string {
  return path.join(STATE_DIR, ...segments);
}

export function legacyStatePath(...segments: string[]): string {
  return path.join(LEGACY_STATE_DIR, ...segments);
}

export async function ensurePrivateStateDir(directory = STATE_DIR): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
}

export async function migrateLegacyStateDir(): Promise<void> {
  if (!(await exists(LEGACY_STATE_DIR))) {
    await ensurePrivateStateDir();
    return;
  }

  await ensurePrivateStateDir();
  const entries = await readdir(LEGACY_STATE_DIR, { withFileTypes: true }).catch(() => []);
  const existingNames = new Set(entries.map((entry) => entry.name));

  for (const entryName of MIGRATED_ENTRIES) {
    if (!existingNames.has(entryName)) continue;
    const source = legacyStatePath(entryName);
    const destination = statePath(entryName);
    if (await exists(destination)) continue;
    await cp(source, destination, { recursive: true, force: false, errorOnExist: true }).catch(() => undefined);
  }
}
