import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { AgentDef, AgentProvider, Project } from "@agent-control/shared";

function colorForName(name: string): string {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 33) ^ name.charCodeAt(index);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 55%)`;
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
  openai: ".agent-control/openai-agents",
  builtIn: ".agent-control/built-in-agents"
};

function genericAgentDef(): AgentDef {
  return {
    name: "Generic",
    description: "General-purpose Claude agent",
    color: "#ffffff",
    provider: "claude",
    tools: [],
    systemPrompt: "",
    builtIn: true
  };
}

function projectId(projectPath: string): string {
  return Buffer.from(path.resolve(projectPath)).toString("base64url");
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function normalizedProjectPath(projectPath: string): string {
  const resolved = path.resolve(expandHome(projectPath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
    color: stringValue(data.color) || colorForName(name),
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
  return path.resolve(process.cwd(), expanded);
}

export async function updateAgentPluginsFile(filePath: string, plugins: string[]): Promise<void> {
  const raw = await readFile(filePath, "utf8");
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const next = matter.stringify(parsed.content.trim() ? `${parsed.content.trim()}\n` : "", {
    ...data,
    plugins
  });
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
  const groups = await Promise.all([
    readAgentDir(projectPath, agentDirs.claude, "claude"),
    readAgentDir(projectPath, agentDirs.codex, "codex"),
    readAgentDir(projectPath, agentDirs.openai, "openai")
  ]);
  const byName = new Map<string, AgentDef>();
  for (const agent of groups.flat()) byName.set(`${agent.provider || "claude"}:${agent.name}`, agent);
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readBuiltInAgentDefs(projectPath: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<AgentDef[]> {
  const agents = await readAgentDir(resolveBuiltInAgentDir(agentDirs.builtIn), ".", undefined, true);
  return agents.length > 0 ? agents : [genericAgentDef()];
}

export async function upsertBuiltInAgent(projectPath: string, agent: AgentDef, originalName?: string, agentDirs = DEFAULT_AGENT_DIRS): Promise<void> {
  const agentsPath = resolveBuiltInAgentDir(agentDirs.builtIn);
  await mkdir(agentsPath, { recursive: true });
  if (originalName && originalName !== agent.name) await deleteBuiltInAgent(projectPath, originalName, agentDirs).catch(() => undefined);
  const filePath = path.join(agentsPath, `${agentSlug(agent.name)}.md`);
  const body = matter.stringify(agent.systemPrompt.trim() ? `${agent.systemPrompt.trim()}\n` : "", {
    name: agent.name,
    description: agent.description || undefined,
    color: agent.color || colorForName(agent.name),
    provider: agent.provider || "claude",
    defaultModel: agent.defaultModel || undefined,
    tools: agent.tools || [],
    plugins: agent.plugins || []
  });
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
      agents,
      builtInAgents
    });
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export async function scanProject(projectPath: string, agentDirs = DEFAULT_AGENT_DIRS, agentSourcePath?: string): Promise<Project | null> {
  const resolvedPath = path.resolve(expandHome(projectPath));
  const projectStats = await stat(resolvedPath).catch(() => null);
  if (!projectStats?.isDirectory()) return null;
  const resolvedAgentSourcePath = agentSourcePath ? path.resolve(expandHome(agentSourcePath)) : resolvedPath;
  const agents = await readAgentDefs(resolvedAgentSourcePath, agentDirs);
  const builtInAgents = await readBuiltInAgentDefs(resolvedPath, agentDirs);

  return {
    id: projectId(resolvedPath),
    name: path.basename(resolvedPath),
    path: resolvedPath,
    agents,
    builtInAgents
  };
}

export async function scanConfiguredProjects(projectPaths: string[], agentDirs = DEFAULT_AGENT_DIRS): Promise<Project[]> {
  const resolvedProjectPaths = projectPaths.map((projectPath) => path.resolve(expandHome(projectPath)));
  const projects = (
    await Promise.all(
      resolvedProjectPaths.map((projectPath) => scanProject(projectPath, agentDirs, nearestAgentSourcePath(projectPath, resolvedProjectPaths)).catch(() => null))
    )
  ).filter((project): project is Project => Boolean(project));

  const byId = new Map<string, Project>();
  for (const project of projects) byId.set(project.id, project);
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}
