import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";
import type { AgentDef, Project } from "@agent-control/shared";

function colorForName(name: string): string {
  let hash = 5381;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 33) ^ name.charCodeAt(index);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 55%)`;
}

function genericAgentDef(): AgentDef {
  return {
    name: "Generic",
    description: "General-purpose Claude agent",
    color: "#000000",
    tools: [],
    systemPrompt: ""
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toolsValue(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function modelValue(data: Record<string, unknown>): string | undefined {
  return stringValue(data.defaultModel) || stringValue(data.default_model) || stringValue(data.model);
}

async function parseAgentFile(filePath: string): Promise<AgentDef | null> {
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
    defaultModel: modelValue(data),
    tools: toolsValue(data.tools),
    systemPrompt: parsed.content.trim()
  };
}

async function readAgentDefs(projectPath: string): Promise<AgentDef[]> {
  const agentsPath = path.join(projectPath, ".claude", "agents");
  const agentDirStats = await stat(agentsPath).catch(() => null);
  if (!agentDirStats?.isDirectory()) return [genericAgentDef()];

  const agentFiles = await readdir(agentsPath, { withFileTypes: true }).catch(() => []);
  const agents = (
    await Promise.all(
      agentFiles
        .filter((file) => file.isFile() && file.name.endsWith(".md"))
        .map((file) => parseAgentFile(path.join(agentsPath, file.name)).catch(() => null))
    )
  )
    .filter((agent): agent is AgentDef => Boolean(agent))
    .sort((left, right) => left.name.localeCompare(right.name));

  return agents.length > 0 ? agents : [genericAgentDef()];
}

export async function scanProjects(projectsRoot: string): Promise<Project[]> {
  const rootStats = await stat(projectsRoot).catch(() => null);
  if (!rootStats?.isDirectory()) return [];

  const entries = await readdir(projectsRoot, { withFileTypes: true });
  const projects: Project[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, entry.name);
    const agents = await readAgentDefs(projectPath);

    projects.push({
      id: projectId(projectPath),
      name: entry.name,
      path: projectPath,
      agents
    });
  }

  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

export async function scanProject(projectPath: string): Promise<Project | null> {
  const resolvedPath = path.resolve(expandHome(projectPath));
  const projectStats = await stat(resolvedPath).catch(() => null);
  if (!projectStats?.isDirectory()) return null;
  const agents = await readAgentDefs(resolvedPath);

  return {
    id: projectId(resolvedPath),
    name: path.basename(resolvedPath),
    path: resolvedPath,
    agents
  };
}

export async function scanConfiguredProjects(projectPaths: string[]): Promise<Project[]> {
  const projects = (
    await Promise.all(projectPaths.map((projectPath) => scanProject(projectPath).catch(() => null)))
  ).filter((project): project is Project => Boolean(project));

  const byId = new Map<string, Project>();
  for (const project of projects) byId.set(project.id, project);
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}
