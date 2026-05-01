import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { AgentDef, AgentProvider, Project } from "@agent-hero/shared";
import { canonicalWslProjectKey, parseWslUncPath, wslUncPath } from "./wsl.js";
import { APP_ROOT, DEFAULT_BUILT_IN_AGENT_DIR } from "./config.js";

const agentColorPalette = [
  "#2563eb",
  "#dc2626",
  "#16a34a",
  "#d97706",
  "#7c3aed",
  "#0891b2",
  "#db2777",
  "#65a30d",
  "#ea580c",
  "#4f46e5",
  "#0d9488",
  "#be123c",
  "#9333ea",
  "#0284c7",
  "#ca8a04",
  "#059669"
];
const minAgentColorHueDistance = 32;

function hashName(name: string): number {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 33) ^ name.charCodeAt(index);
  }
  return Math.abs(hash);
}

function colorForName(name: string): string {
  return agentColorPalette[hashName(name) % agentColorPalette.length];
}

function hueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right) % 360;
  return Math.min(distance, 360 - distance);
}

function rgbToHue(red: number, green: number, blue: number): number | undefined {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return undefined;
  if (max === r) return 60 * (((g - b) / delta) % 6);
  if (max === g) return 60 * ((b - r) / delta + 2);
  return 60 * ((r - g) / delta + 4);
}

function hueForColor(color: string): number | undefined {
  const trimmed = color.trim().toLowerCase();
  const hslMatch = trimmed.match(/^hsla?\(\s*([\d.]+)/);
  if (hslMatch) return Number(hslMatch[1]) % 360;
  const hexMatch = trimmed.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!hexMatch) return undefined;
  const hex = hexMatch[1].length === 3 ? hexMatch[1].split("").map((part) => part + part).join("") : hexMatch[1];
  const hue = rgbToHue(parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16));
  return hue === undefined ? undefined : (hue + 360) % 360;
}

function explicitAgentColor(agent: AgentDef): string | undefined {
  if (!agent.sourceContent) return stringValue(agent.color);
  const parsed = matter(agent.sourceContent);
  return stringValue((parsed.data as Record<string, unknown>).color);
}

function generatedColorCandidates(name: string, index: number): string[] {
  const offset = hashName(name) % agentColorPalette.length;
  const palette = agentColorPalette.map((_, paletteIndex) => agentColorPalette[(offset + paletteIndex) % agentColorPalette.length]);
  const generated = Array.from({ length: 16 }, (_, generatedIndex) => {
    const hue = (hashName(name) + Math.round((index + generatedIndex + 1) * 137.508)) % 360;
    return `hsl(${hue} 65% 55%)`;
  });
  return [...palette, ...generated];
}

function chooseDistinctAgentColor(name: string, usedColors: Set<string>, usedHues: number[], index: number): string {
  let bestColor = colorForName(name);
  let bestScore = -Infinity;
  for (const candidate of generatedColorCandidates(name, index)) {
    const normalized = candidate.toLowerCase();
    const hue = hueForColor(candidate);
    const closestHue = hue === undefined || usedHues.length === 0 ? 180 : Math.min(...usedHues.map((usedHue) => hueDistance(hue, usedHue)));
    const score = (usedColors.has(normalized) ? -1000 : 0) + closestHue;
    if (!usedColors.has(normalized) && closestHue >= minAgentColorHueDistance) return candidate;
    if (score > bestScore) {
      bestColor = candidate;
      bestScore = score;
    }
  }
  return bestColor;
}

function normalizeAgentColors(agents: AgentDef[]): AgentDef[] {
  const usedColors = new Set<string>();
  const usedHues: number[] = [];
  return agents.map((agent, index) => {
    const color = explicitAgentColor(agent) || chooseDistinctAgentColor(agent.name, usedColors, usedHues, index);
    usedColors.add(color.trim().toLowerCase());
    const hue = hueForColor(color);
    if (hue !== undefined) usedHues.push(hue);
    return { ...agent, color };
  });
}

export interface AgentDirectoryConfig {
  claude: string;
  codex: string;
  openai: string;
  builtIn: string;
}

export const DEFAULT_AGENT_DIRS: AgentDirectoryConfig = {
  claude: ".claude/agents",
  codex: ".codex/agents",
  openai: ".agent-hero/openai-agents",
  builtIn: DEFAULT_BUILT_IN_AGENT_DIR
};
const LEGACY_OPENAI_AGENT_DIR = ".agent-control/openai-agents";
const LEGACY_BUILT_IN_AGENT_DIR = ".agent-control/built-in-agents";

function generalAgentDef(): AgentDef {
  return {
    name: "general",
    description: "General-purpose engineering assistant",
    color: "#ffffff",
    provider: "claude",
    tools: [],
    systemPrompt: "",
    builtIn: true
  };
}

function projectId(projectPath: string): string {
  return Buffer.from(canonicalWslProjectKey(projectPath) || path.resolve(projectPath)).toString("base64url");
}

function projectRuntimeFields(projectPath: string): Pick<Project, "runtime" | "wslDistro" | "wslPath"> {
  const wsl = parseWslUncPath(projectPath);
  return wsl ? { runtime: "wsl", wslDistro: wsl.distro, wslPath: wsl.wslPath } : { runtime: "local" };
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizedProjectPath(projectPath: string): string {
  const wslKey = canonicalWslProjectKey(projectPath);
  if (wslKey) return wslKey;
  const resolved = path.resolve(expandHome(projectPath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function resolveExistingProjectPath(projectPath: string): Promise<string | null> {
  const resolvedPath = path.resolve(expandHome(projectPath));
  const wsl = parseWslUncPath(resolvedPath);
  const candidates = wsl ? Array.from(new Set([resolvedPath, wslUncPath(wsl.distro, wsl.wslPath)])) : [resolvedPath];

  for (const candidate of candidates) {
    const projectStats = await stat(candidate).catch(() => null);
    if (projectStats?.isDirectory()) return candidate;
  }

  return null;
}

function isDescendantPath(childPath: string, parentPath: string): boolean {
  const relative = path.relative(normalizedProjectPath(parentPath), normalizedProjectPath(childPath));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function nearestAgentSourcePath(projectPath: string, configuredPaths: string[]): string | undefined {
  return configuredPaths
    .filter((candidatePath) => isDescendantPath(projectPath, candidatePath))
    .sort((left, right) => normalizedProjectPath(right).length - normalizedProjectPath(left).length)[0];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolsValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function providerValue(value: unknown): AgentProvider | undefined {
  if (value === "claude" || value === "codex" || value === "openai") return value;
  return undefined;
}

function modelValue(data: Record<string, unknown>): string | undefined {
  return stringValue(data.defaultModel) || stringValue(data.default_model) || stringValue(data.model);
}

function frontmatterData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

async function parseAgentFile(filePath: string, fallbackProvider?: AgentProvider, builtIn = false): Promise<AgentDef | null> {
  if (!filePath.endsWith(".md")) return null;
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const fallbackName = path.basename(filePath, ".md");
  const name = stringValue(data.name) || fallbackName;

  return {
    name,
    description: stringValue(data.description),
    color: stringValue(data.color) || "",
    provider: providerValue(data.provider) || fallbackProvider,
    defaultModel: modelValue(data),
    tools: toolsValue(data.tools),
    plugins: toolsValue(data.plugins),
    systemPrompt: parsed.content.trim(),
    sourcePath: filePath,
    sourceContent: raw,
    builtIn
  };
}

function agentSlug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
}

function resolveProjectSubdir(projectPath: string, subdir: string): string {
  const expanded = expandHome(subdir);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  const resolved = path.resolve(projectPath, expanded);
  const root = path.resolve(projectPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Agent directory must be inside the project.");
  return resolved;
}

function resolveBuiltInAgentDir(builtInDir: string): string {
  const expanded = expandHome(builtInDir);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(APP_ROOT, expanded);
}

export async function updateAgentPluginsFile(filePath: string, plugins: string[]): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const next = matter.stringify(parsed.content.trim() ? `${parsed.content.trim()}\n` : "", frontmatterData({
    ...data,
    plugins
  }));
  await writeFile(filePath, next, "utf8");
}

export async function updateAgentPlugins(projectPath: string, agentName: string, plugins: string[], agentDirs = DEFAULT_AGENT_DIRS): Promise<void> {
  const agentsPath = resolveProjectSubdir(projectPath, agentDirs.claude);
  const agentFiles = await readdir(agentsPath, { withFileTypes: true }).catch(() => []);
  for (const file of agentFiles.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
    const filePath = path.join(agentsPath, file.name);
    const raw = await readFile(filePath, "utf8");
    const parsed = matter(raw);
    const data = parsed.data as Record<string, unknown>;
    const name = stringValue(data.name) || path.basename(filePath, ".md");
    if (name !== agentName) continue;
    await updateAgentPluginsFile(filePath, plugins);
    return;
  }
  throw new Error("Agent definition file not found.");
}

async function readAgentDir(projectPath: string, relativeDir: string, fallbackProvider?: AgentProvider, builtIn = false): Promise<AgentDef[]> {
  const agentsPath = resolveProjectSubdir(projectPath, relativeDir);
  const agentDirStats = await stat(agentsPath).catch(() => null);
  if (!agentDirStats?.isDirectory()) return [];

  const agentFiles = await readdir(agentsPath, { withFileTypes: true }).catch(() => []);
  const agents = (
    await Promise.all(
      agentFiles
        .filter((file) => file.isFile() && file.name.endsWith(".md"))
        .map((file) => parseAgentFile(path.join(agentsPath, file.name), fallbackProvider, builtIn).catch(() => null))
    )
  )
    .filter((agent): agent is AgentDef => Boolean(agent))
    .sort((left, right) => left.name.localeCompare(right.name));

  return agents;
}

async function readAgentDefs(projectPath: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<AgentDef[]> {
  const openaiAgents = await readAgentDir(projectPath, agentDirs.openai, "openai");
  const legacyOpenaiAgents =
    openaiAgents.length === 0 && agentDirs.openai === DEFAULT_AGENT_DIRS.openai
      ? await readAgentDir(projectPath, LEGACY_OPENAI_AGENT_DIR, "openai")
      : [];
  const groups = await Promise.all([
    readAgentDir(projectPath, agentDirs.claude, "claude"),
    readAgentDir(projectPath, agentDirs.codex, "codex"),
    Promise.resolve([...openaiAgents, ...legacyOpenaiAgents])
  ]);
  const byName = new Map<string, AgentDef>();
  for (const agent of groups.flat()) byName.set(`${agent.provider || "claude"}:${agent.name}`, agent);
  return normalizeAgentColors([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)));
}

async function readBuiltInAgentDefs(projectPath: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<AgentDef[]> {
  const agents = await readAgentDir(resolveBuiltInAgentDir(agentDirs.builtIn), ".", undefined, true);
  if (agents.length > 0) return normalizeAgentColors(agents);
  if (agentDirs.builtIn === DEFAULT_AGENT_DIRS.builtIn) {
    const legacyAgents = await readAgentDir(resolveBuiltInAgentDir(LEGACY_BUILT_IN_AGENT_DIR), ".", undefined, true);
    if (legacyAgents.length > 0) return normalizeAgentColors(legacyAgents);
  }
  return [generalAgentDef()];
}

export async function upsertBuiltInAgent(projectPath: string, agent: AgentDef, originalName?: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<void> {
  const agentsPath = resolveBuiltInAgentDir(agentDirs.builtIn);
  await mkdir(agentsPath, { recursive: true });
  if (originalName && originalName !== agent.name) await deleteBuiltInAgent(projectPath, originalName, agentDirs).catch(() => undefined);
  const filePath = path.join(agentsPath, `${agentSlug(agent.name)}.md`);
  const body = matter.stringify(agent.systemPrompt.trim() ? `${agent.systemPrompt.trim()}\n` : "", frontmatterData({
    name: agent.name,
    description: agent.description || undefined,
    color: agent.color || colorForName(agent.name),
    provider: agent.provider || "claude",
    defaultModel: agent.defaultModel || undefined,
    tools: agent.tools || [],
    plugins: agent.plugins || []
  }));
  await writeFile(filePath, body, "utf8");
}

export async function deleteBuiltInAgent(projectPath: string, agentName: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<void> {
  const agentsPath = resolveBuiltInAgentDir(agentDirs.builtIn);
  const agentFiles = await readdir(agentsPath, { withFileTypes: true }).catch(() => []);
  for (const file of agentFiles.filter((item) => item.isFile() && item.name.endsWith(".md"))) {
    const filePath = path.join(agentsPath, file.name);
    const parsed = await parseAgentFile(filePath, undefined, true).catch(() => null);
    if (parsed?.name !== agentName) continue;
    await rm(filePath, { force: true });
    return;
  }
  throw new Error("Built-in agent not found.");
}

export async function scanProjects(projectsRoot: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<Project[]> {
  const rootStats = await stat(projectsRoot).catch(() => null);
  if (!rootStats?.isDirectory()) return [];

  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const projects: Project[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, entry.name);
    const agents = await readAgentDefs(projectPath, agentDirs);
    const builtInAgents = await readBuiltInAgentDefs(projectPath, agentDirs);

    projects.push({
      id: projectId(projectPath),
      name: entry.name,
      path: projectPath,
      ...projectRuntimeFields(projectPath),
      agents,
      builtInAgents
    });
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export async function scanProject(projectPath: string, agentDirs = DEFAULT_AGENT_DIRS, agentSourcePath?: string): Promise<Project | null> {
  const resolvedPath = await resolveExistingProjectPath(projectPath);
  if (!resolvedPath) return null;
  const resolvedAgentSourcePath = agentSourcePath ? (await resolveExistingProjectPath(agentSourcePath)) || resolvedPath : resolvedPath;
  const agents = await readAgentDefs(resolvedAgentSourcePath, agentDirs);
  const builtInAgents = await readBuiltInAgentDefs(resolvedPath, agentDirs);

  return {
    id: projectId(resolvedPath),
    name: path.basename(resolvedPath),
    path: resolvedPath,
    ...projectRuntimeFields(resolvedPath),
    agents,
    builtInAgents
  };
}

async function fallbackConfiguredWslProject(projectPath: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<Project | null> {
  const wsl = parseWslUncPath(projectPath);
  if (!wsl) return null;
  const normalizedPath = wslUncPath(wsl.distro, wsl.wslPath);
  return {
    id: projectId(normalizedPath),
    name: path.basename(normalizedPath),
    path: normalizedPath,
    ...projectRuntimeFields(normalizedPath),
    agents: [],
    builtInAgents: await readBuiltInAgentDefs(normalizedPath, agentDirs)
  };
}

export async function scanConfiguredProjects(projectPaths: string[], agentDirs = DEFAULT_AGENT_DIRS, existingProjects: Project[] = []): Promise<Project[]> {
  const resolvedProjectPaths = projectPaths.map((projectPath) => path.resolve(expandHome(projectPath)));
  const projects = (
    await Promise.all(
      resolvedProjectPaths.map(async (projectPath) => {
        const scanned = await scanProject(projectPath, agentDirs, nearestAgentSourcePath(projectPath, resolvedProjectPaths)).catch(() => null);
        if (scanned) return scanned;
        if (!parseWslUncPath(projectPath)) return null;
        const existing = existingProjects.find((candidate) => normalizedProjectPath(candidate.path) === normalizedProjectPath(projectPath));
        return existing || fallbackConfiguredWslProject(projectPath, agentDirs);
      })
    )
  ).filter((project): project is Project => Boolean(project));

  const byId = new Map<string, Project>();
  for (const project of projects) byId.set(project.id, project);
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}
