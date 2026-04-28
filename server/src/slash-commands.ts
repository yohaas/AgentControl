import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { AgentProvider, ClaudePlugin, SlashCommandInfo } from "@agent-control/shared";

const INTERACTIVE_BUILTINS = new Set(["/config", "/login", "/mcp", "/permissions", "/terminal-setup", "/vim"]);

const BUILTIN_COMMANDS: SlashCommandInfo[] = [
  { command: "/add-dir", description: "Add additional working directories", source: "builtin" },
  { command: "/agents", description: "Manage subagent definitions", source: "builtin", interactive: true },
  { command: "/allowed-tools", description: "Alias for /permissions", source: "builtin", interactive: true },
  { command: "/batch", description: "Run coordinated batches of work", source: "builtin" },
  { command: "/bug", description: "Report a Claude Code issue", source: "builtin", interactive: true },
  { command: "/clear", description: "Clear this chat history", source: "agentcontrol" },
  { command: "/claude-api", description: "Get help using Claude APIs", source: "builtin" },
  { command: "/compact", description: "Compact conversation context", argumentHint: "[instructions]", source: "builtin" },
  { command: "/config", description: "Open Claude Code configuration", source: "builtin", interactive: true },
  { command: "/cost", description: "Show session cost and usage", source: "builtin" },
  { command: "/debug", description: "Debug a failing test or bug", source: "builtin" },
  { command: "/doctor", description: "Check Claude Code installation health", source: "builtin", interactive: true },
  { command: "/exit", description: "Close this agent", source: "agentcontrol" },
  { command: "/export", description: "Export the current conversation", source: "builtin", interactive: true },
  { command: "/help", description: "Show Claude Code help", source: "builtin", interactive: true },
  { command: "/hooks", description: "Manage hooks", source: "builtin", interactive: true },
  { command: "/ide", description: "Manage IDE integration", source: "builtin", interactive: true },
  { command: "/init", description: "Initialize project memory", source: "builtin" },
  { command: "/install-github-app", description: "Install the Claude GitHub app", source: "builtin", interactive: true },
  { command: "/interrupt", description: "Stop the active response", source: "agentcontrol" },
  { command: "/login", description: "Change Claude authentication", source: "builtin", interactive: true },
  { command: "/logout", description: "Log out of Claude Code", source: "builtin", interactive: true },
  { command: "/loop", description: "Iterate on a task repeatedly", source: "builtin" },
  { command: "/memory", description: "Edit or inspect memory files", source: "builtin", interactive: true },
  { command: "/model", description: "Switch this agent to another model", argumentHint: "[model]", source: "builtin" },
  { command: "/output-style", description: "Change Claude response style", source: "builtin", interactive: true },
  { command: "/permissions", description: "Manage allow, ask, and deny rules", source: "builtin", interactive: true },
  { command: "/plan", description: "Enter plan mode directly", argumentHint: "[description]", source: "builtin" },
  { command: "/pr-comments", description: "Fetch pull request comments", source: "builtin" },
  { command: "/release-notes", description: "Show release notes", source: "builtin" },
  { command: "/resume", description: "Resume a previous conversation", source: "builtin", interactive: true },
  { command: "/review", description: "Review code changes", source: "builtin" },
  { command: "/simplify", description: "Simplify code or explanations", source: "builtin" },
  { command: "/status", description: "Show AgentControl session status", source: "agentcontrol" },
  { command: "/stop", description: "Stop the active response", source: "agentcontrol" },
  { command: "/terminal-setup", description: "Install terminal integration", source: "builtin", interactive: true },
  { command: "/upgrade", description: "Upgrade Claude Code", source: "builtin", interactive: true },
  { command: "/vim", description: "Toggle Vim mode", source: "builtin", interactive: true }
];

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (/^(true|yes|1)$/i.test(value.trim())) return true;
    if (/^(false|no|0)$/i.test(value.trim())) return false;
  }
  return undefined;
}

function sourceField(value: unknown): SlashCommandInfo["source"] | undefined {
  return value === "agentcontrol" || value === "builtin" || value === "project" || value === "user" || value === "plugin" || value === "session"
    ? value
    : undefined;
}

function firstParagraph(content: string): string | undefined {
  return content
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.replace(/\s+/g, " ").trim())
    .find(Boolean);
}

function normalizeCommandName(name: string): string {
  const clean = name.trim().replace(/\\/g, "/").replace(/\.md$/i, "").replace(/\/SKILL$/i, "");
  const leaf = clean.split("/").filter(Boolean).at(-1) || clean;
  return leaf.replace(/^\//, "");
}

function withSlash(command: string): string {
  return command.startsWith("/") ? command : `/${command}`;
}

function pluginBaseName(pluginName: string): string {
  return pluginName.split("@")[0] || pluginName;
}

function pluginSelfAliases(pluginName: string, commands: SlashCommandInfo[]): SlashCommandInfo[] {
  const base = pluginBaseName(pluginName);
  const prefix = `/${base}:`;
  return commands
    .filter((command) => command.command.startsWith(prefix) && command.command.slice(prefix.length) === base)
    .map((command) => ({
      ...command,
      command: `/${base}`
    }));
}

async function readMarkdownCommand(
  filePath: string,
  commandName: string,
  source: SlashCommandInfo["source"],
  namespace?: string
): Promise<SlashCommandInfo | undefined> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  if (booleanField(data["user-invocable"]) === false) return undefined;

  const frontmatterName = stringField(data.name);
  const name = normalizeCommandName(frontmatterName || commandName);
  const command = namespace ? `/${namespace}:${name}` : withSlash(name);
  return {
    command,
    description: stringField(data.description) || firstParagraph(parsed.content),
    argumentHint: stringField(data["argument-hint"]) || stringField(data.argumentHint),
    source,
    sourcePath: filePath,
    interactive: INTERACTIVE_BUILTINS.has(command)
  };
}

async function walkMarkdownFiles(root: string): Promise<string[]> {
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
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) results.push(fullPath);
    }
  }
  return results;
}

async function scanCommandsDir(root: string, source: SlashCommandInfo["source"], namespace?: string): Promise<SlashCommandInfo[]> {
  const files = await walkMarkdownFiles(root);
  const commands = await Promise.all(
    files.map((filePath) => {
      const relative = path.relative(root, filePath);
      return readMarkdownCommand(filePath, relative, source, namespace).catch(() => undefined);
    })
  );
  return commands.filter((command): command is SlashCommandInfo => Boolean(command));
}

async function scanSkillsDir(root: string, source: SlashCommandInfo["source"], namespace?: string): Promise<SlashCommandInfo[]> {
  const rootStats = await stat(root).catch(() => undefined);
  if (!rootStats?.isDirectory()) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const commands = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const skillPath = path.join(root, entry.name, "SKILL.md");
        return readMarkdownCommand(skillPath, entry.name, source, namespace).catch(() => undefined);
      })
  );
  return commands.filter((command): command is SlashCommandInfo => Boolean(command));
}

async function pluginRootCandidates(plugin: ClaudePlugin, provider: AgentProvider = "claude"): Promise<string[]> {
  const marker = provider === "codex" ? ".codex-plugin" : ".claude-plugin";
  const cacheRoot =
    provider === "codex" ? path.join(os.homedir(), ".codex", "plugins", "cache") : path.join(os.homedir(), ".claude", "plugins", "cache");
  const cacheStats = await stat(cacheRoot).catch(() => undefined);
  if (!cacheStats?.isDirectory()) return [];
  const candidates: string[] = [];
  const stack = [cacheRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.isDirectory() && entry.name === marker)) {
      const pluginJson = path.join(current, marker, "plugin.json");
      const raw = await readFile(pluginJson, "utf8").catch(() => "");
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      } catch {
        parsed = {};
      }
      const parsedName = stringField(parsed.name);
      if (parsedName === plugin.name || parsedName === pluginBaseName(plugin.name)) candidates.push(current);
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
    }
  }
  return candidates;
}

async function scanPluginCommands(
  enabledPlugins: ClaudePlugin[],
  selectedPluginNames: string[],
  provider: AgentProvider = "claude"
): Promise<SlashCommandInfo[]> {
  const selected = new Set(selectedPluginNames);
  const plugins = enabledPlugins.filter((plugin) => plugin.enabled || selected.has(plugin.name) || selected.has(pluginBaseName(plugin.name)));
  const commandSets = await Promise.all(
    plugins.map(async (plugin) => {
      const roots = await pluginRootCandidates(plugin, provider);
      const scanned = await Promise.all(
        roots.map(async (root) => [
          ...(await scanCommandsDir(path.join(root, "commands"), "plugin", pluginBaseName(plugin.name))),
          ...(await scanSkillsDir(path.join(root, "skills"), "plugin", pluginBaseName(plugin.name)))
        ])
      );
      const commands = scanned.flat();
      return [...commands, ...pluginSelfAliases(plugin.name, commands)];
    })
  );
  return commandSets.flat();
}

export function normalizeSlashCommandInfo(value: unknown, source: SlashCommandInfo["source"] = "session"): SlashCommandInfo | undefined {
  if (typeof value === "string" && value.trim()) {
    const command = withSlash(value.trim());
    return { command, source, interactive: INTERACTIVE_BUILTINS.has(command) };
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const command = stringField(record.command) || stringField(record.name) || stringField(record.value);
  if (!command) return undefined;
  const normalized = withSlash(command);
  return {
    command: normalized,
    description: stringField(record.description),
    argumentHint: stringField(record.argumentHint) || stringField(record["argument-hint"]),
    source: sourceField(record.source) || source,
    sourcePath: stringField(record.sourcePath),
    interactive: booleanField(record.interactive) ?? INTERACTIVE_BUILTINS.has(normalized)
  };
}

export function mergeSlashCommands(...groups: Array<Array<SlashCommandInfo | string | undefined>>): SlashCommandInfo[] {
  const byCommand = new Map<string, SlashCommandInfo>();
  for (const group of groups) {
    for (const item of group) {
      const command = normalizeSlashCommandInfo(item);
      if (!command) continue;
      const key = command.command.toLowerCase();
      const existing = byCommand.get(key);
      byCommand.set(key, {
        ...existing,
        ...command,
        description: command.description || existing?.description,
        argumentHint: command.argumentHint || existing?.argumentHint,
        sourcePath: command.sourcePath || existing?.sourcePath,
        interactive: command.interactive || existing?.interactive
      });
    }
  }
  return [...byCommand.values()].sort((left, right) => left.command.localeCompare(right.command, undefined, { sensitivity: "base" }));
}

export async function scanSlashCommands(
  projectPath: string,
  enabledPlugins: ClaudePlugin[] = [],
  selectedPluginNames: string[] = [],
  provider: AgentProvider = "claude"
): Promise<SlashCommandInfo[]> {
  if (provider === "openai") return [];
  const providerDir = provider === "codex" ? ".codex" : ".claude";
  const projectRoot = path.join(projectPath, providerDir);
  const userRoot = path.join(expandHome("~"), providerDir);
  return mergeSlashCommands(
    provider === "claude" ? BUILTIN_COMMANDS : [],
    await scanCommandsDir(path.join(projectRoot, "commands"), "project"),
    await scanSkillsDir(path.join(projectRoot, "skills"), "project"),
    await scanCommandsDir(path.join(userRoot, "commands"), "user"),
    await scanSkillsDir(path.join(userRoot, "skills"), "user"),
    await scanPluginCommands(enabledPlugins, selectedPluginNames, provider)
  );
}
