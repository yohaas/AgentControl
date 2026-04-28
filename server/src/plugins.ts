import { execFile } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentProvider, ClaudeAvailablePlugin, ClaudeMarketplace, ClaudePlugin, ClaudePluginCatalog } from "@agent-control/shared";
import { resolveClaudeCommand, resolveCodexInvocation, type CommandInvocation } from "./capabilities.js";

const execFileAsync = promisify(execFile);
export type PluginProvider = Extract<AgentProvider, "claude" | "codex">;

function providerCommand(provider: PluginProvider): CommandInvocation {
  if (provider === "codex") return resolveCodexInvocation();
  return { command: resolveClaudeCommand(), args: [] };
}

export function normalizePluginProvider(value: unknown): PluginProvider {
  return value === "codex" ? "codex" : "claude";
}

export function supportsPluginProvider(provider: AgentProvider): provider is PluginProvider {
  return provider === "claude" || provider === "codex";
}

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

export async function listPlugins(provider: PluginProvider = "claude"): Promise<ClaudePlugin[]> {
  if (provider === "codex") return codexPluginCatalog().then((catalog) => catalog.installed);
  try {
    return (await pluginCatalog(provider)).installed;
  } catch {
    const { stdout, stderr } = await execFileAsync(resolveClaudeCommand(), ["plugin", "list"], { timeout: 8000 });
    return parsePluginList(`${stdout}\n${stderr}`);
  }
}

export async function enablePlugin(plugin: string, provider: PluginProvider = "claude"): Promise<ClaudePlugin[]> {
  if (provider === "codex") {
    await enableCodexPlugin(plugin);
    return listPlugins(provider);
  }
  await execFileAsync(resolveClaudeCommand(), ["plugin", "enable", plugin], { timeout: 8000 });
  return listPlugins(provider);
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

export async function pluginCatalog(provider: PluginProvider = "claude"): Promise<ClaudePluginCatalog> {
  if (provider === "codex") return codexPluginCatalog();
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

export async function installPlugin(plugin: string, scope = "user", provider: PluginProvider = "claude"): Promise<ClaudePluginCatalog> {
  if (provider === "codex") {
    const catalog = await codexPluginCatalog();
    if (!catalog.installed.some((item) => item.name === plugin)) {
      throw new Error("Codex CLI does not expose per-plugin install yet. Add or upgrade a marketplace, then enable a cached plugin.");
    }
    await enableCodexPlugin(plugin);
    return codexPluginCatalog();
  }
  const cleanScope = ["user", "project", "local"].includes(scope) ? scope : "user";
  await execFileAsync(resolveClaudeCommand(), ["plugin", "install", plugin, "--scope", cleanScope], { timeout: 120000 });
  return pluginCatalog(provider);
}

export async function addMarketplace(source: string, provider: PluginProvider = "claude"): Promise<ClaudePluginCatalog> {
  const args = provider === "codex" ? ["plugin", "marketplace", "add", source] : ["plugin", "marketplace", "add", source];
  const invocation = providerCommand(provider);
  await execFileAsync(invocation.command, [...invocation.args, ...args], { timeout: 120000 });
  return pluginCatalog(provider);
}

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

function unquoteTomlKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function normalizeCodexPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseCodexConfig(raw: string): {
  enabledPlugins: Set<string>;
  marketplaces: Map<string, ClaudeMarketplace>;
} {
  const enabledPlugins = new Set<string>();
  const marketplaces = new Map<string, ClaudeMarketplace>();
  let section: { type: "plugin" | "marketplace"; name: string } | undefined;

  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^\s*\[(plugins|marketplaces)\.(.+)]\s*$/);
    if (header) {
      section = { type: header[1] === "plugins" ? "plugin" : "marketplace", name: unquoteTomlKey(header[2]) };
      if (section.type === "marketplace") marketplaces.set(section.name, { name: section.name });
      continue;
    }
    if (!section) continue;

    const enabled = line.match(/^\s*enabled\s*=\s*(true|false)\s*$/i);
    if (section.type === "plugin" && enabled?.[1]?.toLowerCase() === "true") enabledPlugins.add(section.name);

    const stringField = line.match(/^\s*(source|source_type|last_updated)\s*=\s*(.+?)\s*$/);
    if (section.type === "marketplace" && stringField) {
      const current = marketplaces.get(section.name) || { name: section.name };
      const key = stringField[1];
      const value = unquoteTomlKey(stringField[2]);
      marketplaces.set(section.name, key === "source" ? { ...current, source: normalizeCodexPath(value) } : current);
    }
  }

  return { enabledPlugins, marketplaces };
}

async function walkCodexPluginJson(root: string): Promise<string[]> {
  const rootStats = await stat(root).catch(() => undefined);
  if (!rootStats?.isDirectory()) return [];
  const results: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".codex-plugin") {
          results.push(path.join(fullPath, "plugin.json"));
        } else {
          stack.push(fullPath);
        }
      }
    }
  }
  return results;
}

function codexPluginId(pluginPath: string, parsed: Record<string, unknown>, marketplaceName?: string): string | undefined {
  const name = typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
  if (!name) return undefined;
  if (marketplaceName) return `${name}@${marketplaceName}`;
  const cacheRoot = path.join(codexHome(), "plugins", "cache");
  const relative = path.relative(cacheRoot, pluginPath);
  const marketplace = relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative.split(path.sep)[0] : undefined;
  return marketplace ? `${name}@${marketplace}` : name;
}

async function readCodexPlugin(pluginFile: string, enabledPlugins: Set<string>, marketplaceName?: string): Promise<{
  installed: ClaudePlugin;
  available: ClaudeAvailablePlugin;
} | undefined> {
  const raw = await readFile(pluginFile, "utf8").catch(() => "");
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    parsed = {};
  }
  const id = codexPluginId(pluginFile, parsed, marketplaceName);
  if (!id) return undefined;
  const pluginInterface = parsed.interface as Record<string, unknown> | undefined;
  const description =
    typeof parsed.description === "string"
      ? parsed.description
      : typeof pluginInterface?.shortDescription === "string"
        ? String(pluginInterface.shortDescription)
        : undefined;
  const marketplace = marketplaceName || (id.includes("@") ? id.split("@").at(-1) : undefined);
  return {
    installed: {
      name: id,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      scope: marketplace,
      enabled: enabledPlugins.has(id)
    },
    available: {
      pluginId: id,
      name: typeof pluginInterface?.displayName === "string" ? String(pluginInterface.displayName) : id,
      description,
      marketplaceName: marketplace,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      installed: false
    }
  };
}

async function codexPluginCatalog(): Promise<ClaudePluginCatalog> {
  const config = await readFile(codexConfigPath(), "utf8").catch(() => "");
  const parsedConfig = parseCodexConfig(config);
  const installedById = new Map<string, ClaudePlugin>();
  const availableById = new Map<string, ClaudeAvailablePlugin>();

  for (const pluginFile of await walkCodexPluginJson(path.join(codexHome(), "plugins", "cache"))) {
    const plugin = await readCodexPlugin(pluginFile, parsedConfig.enabledPlugins);
    if (!plugin) continue;
    installedById.set(plugin.installed.name, plugin.installed);
    availableById.set(plugin.available.pluginId, { ...plugin.available, installed: true });
  }

  for (const marketplace of parsedConfig.marketplaces.values()) {
    const source = normalizeCodexPath(marketplace.source);
    if (!source) continue;
    const roots = [path.join(source, "plugins"), source];
    for (const root of roots) {
      for (const pluginFile of await walkCodexPluginJson(root)) {
        const plugin = await readCodexPlugin(pluginFile, parsedConfig.enabledPlugins, marketplace.name);
        if (!plugin) continue;
        const installed = installedById.has(plugin.available.pluginId);
        availableById.set(plugin.available.pluginId, { ...plugin.available, installed });
      }
    }
  }

  const marketplaces = [...parsedConfig.marketplaces.values()];
  return {
    installed: [...installedById.values()].sort((left, right) => left.name.localeCompare(right.name)),
    available: [...availableById.values()].sort((left, right) => left.name.localeCompare(right.name)),
    marketplaces
  };
}

async function enableCodexPlugin(plugin: string): Promise<void> {
  const configPath = codexConfigPath();
  const raw = await readFile(configPath, "utf8").catch(() => "");
  const lines = raw ? raw.split(/\r?\n/) : [];
  const header = `[plugins.${tomlString(plugin)}]`;
  const headerPattern = new RegExp(`^\\s*\\[plugins\\.${tomlString(plugin).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`);
  let sectionStart = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (headerPattern.test(lines[index])) {
      sectionStart = index;
      break;
    }
  }

  if (sectionStart === -1) {
    const prefix = lines.length && lines.at(-1)?.trim() ? [""] : [];
    lines.push(...prefix, header, "enabled = true");
  } else {
    let sectionEnd = lines.length;
    for (let index = sectionStart + 1; index < lines.length; index += 1) {
      if (/^\s*\[/.test(lines[index])) {
        sectionEnd = index;
        break;
      }
    }
    const enabledIndex = lines.findIndex((line, index) => index > sectionStart && index < sectionEnd && /^\s*enabled\s*=/.test(line));
    if (enabledIndex === -1) lines.splice(sectionEnd, 0, "enabled = true");
    else lines[enabledIndex] = "enabled = true";
  }

  await writeFile(configPath, `${lines.join("\n").replace(/\s+$/, "")}\n`, "utf8");
}
