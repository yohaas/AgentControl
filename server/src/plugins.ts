import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudePlugin } from "@agent-control/shared";
import { resolveClaudeCommand } from "./capabilities.js";

const execFileAsync = promisify(execFile);

export function parsePluginList(output: string): ClaudePlugin[] {
  const plugins: ClaudePlugin[] = [];
  const blocks = output.split(/\r?\n\s*\r?\n/);

  for (const block of blocks) {
    const name = block.match(/>\s+(.+)/)?.[1]?.trim();
    if (!name) continue;

    plugins.push({
      name,
      version: block.match(/Version:\s+(.+)/)?.[1]?.trim(),
      scope: block.match(/Scope:\s+(.+)/)?.[1]?.trim(),
      enabled: /Status:.*enabled/i.test(block)
    });
  }

  return plugins;
}

export async function listPlugins(): Promise<ClaudePlugin[]> {
  const { stdout, stderr } = await execFileAsync(resolveClaudeCommand(), ["plugin", "list"], { timeout: 8000 });
  return parsePluginList(`${stdout}\n${stderr}`);
}

export async function enablePlugin(plugin: string): Promise<ClaudePlugin[]> {
  await execFileAsync(resolveClaudeCommand(), ["plugin", "enable", plugin], { timeout: 8000 });
  return listPlugins();
}
