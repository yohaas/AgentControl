import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentPermissionMode, AutoApproveMode } from "@agent-control/shared";

export const DEFAULT_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
];

export interface DashboardConfig {
  projectsRoot?: string;
  projectPaths?: string[];
  models?: string[];
  autoApprove?: AutoApproveMode;
  defaultAgentMode?: AgentPermissionMode;
  tileHeight?: number;
  tileColumns?: number;
  sidebarWidth?: number;
  pinLastSentMessage?: boolean;
  terminalDock?: TerminalDockPosition;
}

export type TerminalDockPosition = "float" | "left" | "bottom" | "right";

const configDir = path.join(os.homedir(), ".agent-dashboard");
const configPath = path.join(configDir, "config.json");

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export async function readConfig(): Promise<DashboardConfig> {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as DashboardConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(config: DashboardConfig): Promise<DashboardConfig> {
  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

export function resolveProjectsRoot(config: DashboardConfig): string {
  return path.resolve(expandHome(config.projectsRoot || process.env.PROJECTS_ROOT || "~/projects"));
}

export function resolveModels(config: DashboardConfig): string[] {
  const models = config.models?.map((model) => model.trim()).filter(Boolean);
  return models?.length ? models : DEFAULT_MODELS;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function resolveTileHeight(config: DashboardConfig): number {
  return clampNumber(config.tileHeight, 460, 320, 760);
}

export function resolveTileColumns(config: DashboardConfig): number {
  return clampNumber(config.tileColumns, 2, 1, 6);
}

export function resolveSidebarWidth(config: DashboardConfig): number {
  return clampNumber(config.sidebarWidth, 280, 240, 420);
}

export function resolvePinLastSentMessage(config: DashboardConfig): boolean {
  return config.pinLastSentMessage !== false;
}

export function resolveDefaultAgentMode(config: DashboardConfig): AgentPermissionMode {
  return config.defaultAgentMode === "default" ||
    config.defaultAgentMode === "acceptEdits" ||
    config.defaultAgentMode === "plan" ||
    config.defaultAgentMode === "bypassPermissions"
    ? config.defaultAgentMode
    : "acceptEdits";
}

export function resolveTerminalDock(config: DashboardConfig): TerminalDockPosition {
  return config.terminalDock === "float" ||
    config.terminalDock === "left" ||
    config.terminalDock === "right" ||
    config.terminalDock === "bottom"
    ? config.terminalDock
    : "bottom";
}
