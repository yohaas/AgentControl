import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ClaudeAvailablePlugin, ClaudeMarketplace, ClaudePlugin, ClaudePluginCatalog } from "@agent-control/shared";
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
  try {
    return (await pluginCatalog()).installed;
  } catch {
    const { stdout, stderr } = await execFileAsync(resolveClaudeCommand(), ["plugin", "list"], { timeout: 8000 });
    return parsePluginList(`${stdout}\n${stderr}`);
  }
}

export async function enablePlugin(plugin: string): Promise<ClaudePlugin[]> {
  await execFileAsync(resolveClaudeCommand(), ["plugin", "enable", plugin], { timeout: 8000 });
  return listPlugins();
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function normalizeInstalledPlugin(value: unknown): ClaudePlugin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id : typeof item.name === "string" ? item.name : undefined;
  if (!id) return undefined;
  return {
    name: id,
    version: typeof item.version === "string" ? item.version : undefined,
    scope: typeof item.scope === "string" ? item.scope : undefined,
    enabled: Boolean(item.enabled)
  };
}

function normalizeAvailablePlugin(value: unknown, installedIds: Set<string>): ClaudeAvailablePlugin | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const pluginId = typeof item.pluginId === "string" ? item.pluginId : typeof item.id === "string" ? item.id : undefined;
  const name = typeof item.name === "string" ? item.name : pluginId;
  if (!pluginId || !name) return undefined;
  return {
    pluginId,
    name,
    description: typeof item.description === "string" ? item.description : undefined,
    marketplaceName: typeof item.marketplaceName === "string" ? item.marketplaceName : undefined,
    version: typeof item.version === "string" ? item.version : undefined,
    installCount: typeof item.installCount === "number" ? item.installCount : undefined,
    installed: installedIds.has(pluginId)
  };
}

function normalizeMarketplace(value: unknown): ClaudeMarketplace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Record<string, unknown>;
  const name = typeof item.name === "string" ? item.name : undefined;
  if (!name) return undefined;
  return {
    name,
    source: typeof item.source === "string" ? item.source : undefined,
    repo: typeof item.repo === "string" ? item.repo : undefined,
    url: typeof item.url === "string" ? item.url : undefined,
    path: typeof item.path === "string" ? item.path : undefined,
    installLocation: typeof item.installLocation === "string" ? item.installLocation : undefined
  };
}

export async function pluginCatalog(): Promise<ClaudePluginCatalog> {
  const [{ stdout: pluginStdout }, { stdout: marketplaceStdout }] = await Promise.all([
    execFileAsync(resolveClaudeCommand(), ["plugin", "list", "--available", "--json"], { timeout: 20000 }),
    execFileAsync(resolveClaudeCommand(), ["plugin", "marketplace", "list", "--json"], { timeout: 8000 })
  ]);
  const pluginJson = parseJson<{ installed?: unknown[]; available?: unknown[] }>(pluginStdout, {});
  const installed = (pluginJson.installed || []).map(normalizeInstalledPlugin).filter((plugin): plugin is ClaudePlugin => Boolean(plugin));
  const installedIds = new Set(installed.map((plugin) => plugin.name));
  const available = (pluginJson.available || [])
    .map((plugin) => normalizeAvailablePlugin(plugin, installedIds))
    .filter((plugin): plugin is ClaudeAvailablePlugin => Boolean(plugin));
  const marketplaces = parseJson<unknown[]>(marketplaceStdout, [])
    .map(normalizeMarketplace)
    .filter((marketplace): marketplace is ClaudeMarketplace => Boolean(marketplace));
  return { installed, available, marketplaces };
}

export async function installPlugin(plugin: string, scope = "user"): Promise<ClaudePluginCatalog> {
  const cleanScope = ["user", "project", "local"].includes(scope) ? scope : "user";
  await execFileAsync(resolveClaudeCommand(), ["plugin", "install", plugin, "--scope", cleanScope], { timeout: 120000 });
  return pluginCatalog();
}

export async function addMarketplace(source: string): Promise<ClaudePluginCatalog> {
  await execFileAsync(resolveClaudeCommand(), ["plugin", "marketplace", "add", source], { timeout: 120000 });
  return pluginCatalog();
}
