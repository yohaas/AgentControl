import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentPermissionMode, AppInstallMode, AutoApproveMode, ModelProfile, PermissionAllowRule } from "@agent-hero/shared";
import { migrateLegacyStateDir, statePath } from "./storage.js";

export const DEFAULT_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5"
];

export const DEFAULT_MODEL_PROFILES: ModelProfile[] = [
  { id: "claude-opus-4-7", provider: "claude", default: false, supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-4-6", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-4-6", provider: "claude", default: true, supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5", provider: "claude", supportsThinking: true, supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "gpt-5.5", provider: "openai", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-mini", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.4-nano", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5", provider: "openai", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "o3-deep-research", provider: "openai", supportedEfforts: ["low", "medium", "high"] },
  { id: "o4-mini-deep-research", provider: "openai", supportedEfforts: ["low", "medium", "high"] },
  { id: "gpt-5.3-codex", provider: "codex", default: true, supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.3-codex-spark", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.2-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex-max", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5.1-codex-mini", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] },
  { id: "gpt-5-codex", provider: "codex", supportedEfforts: ["low", "medium", "high", "xhigh"] }
];

export interface DashboardConfig {
  projectsRoot?: string;
  projectPaths?: string[];
  models?: string[];
  modelProfiles?: ModelProfile[];
  gitPath?: string;
  gitFetchIntervalMinutes?: number;
  claudePath?: string;
  claudeRuntime?: ClaudeRuntime;
  codexPath?: string;
  claudeAgentDir?: string;
  codexAgentDir?: string;
  openaiAgentDir?: string;
  builtInAgentDir?: string;
  autoApprove?: AutoApproveMode;
  permissionAllowRules?: PermissionAllowRule[];
  defaultAgentMode?: AgentPermissionMode;
  codexDefaultAgentMode?: AgentPermissionMode;
  tileHeight?: number;
  tileColumns?: number;
  tileScrolling?: TileScrollingMode;
  chatTranscriptDetail?: ChatTranscriptDetailMode;
  chatFontFamily?: string;
  chatFontSize?: number;
  menuDisplay?: MenuDisplayMode;
  sidebarWidth?: number;
  pinLastSentMessage?: boolean;
  terminalDock?: TerminalDockPosition;
  fileExplorerDock?: FileExplorerDockPosition;
  themeMode?: ThemeMode;
  agentControlProjectPath?: string;
  updateChecksEnabled?: boolean;
  updateCommands?: string[];
  updateManifestUrl?: string;
  installMode?: AppInstallMode;
  inputNotificationsEnabled?: boolean;
  externalEditor?: ExternalEditor;
  externalEditorUrlTemplate?: string;
  accessTokenEnabled?: boolean;
}

export type TerminalDockPosition = "float" | "left" | "bottom" | "right";
export type FileExplorerDockPosition = "tile" | "left" | "bottom" | "right";
export type ThemeMode = "auto" | "light" | "dark";
export type ClaudeRuntime = "cli" | "api";
export type MenuDisplayMode = "iconOnly" | "iconText";
export type TileScrollingMode = "vertical" | "horizontal";
export type ChatTranscriptDetailMode = "responses" | "actions" | "detailed" | "raw";
export type ExternalEditor = "none" | "vscode" | "cursor" | "custom";

const configDir = statePath();
const configPath = path.join(configDir, "config.json");
const secretsPath = path.join(configDir, "secrets.json");
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_BUILT_IN_AGENT_DIR = path.join(APP_ROOT, ".agent-hero", "built-in-agents");
const WINDOWS_UPDATE_COMMANDS = [
  "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\start-update.ps1"
];
const WINDOWS_INSTALLED_UPDATE_COMMANDS = [
  "powershell -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\windows\\start-installed-update.ps1"
];
const POSIX_INSTALLED_UPDATE_COMMANDS = ["bash ./scripts/macos/update-installed-agent-hero.sh"];
const PREVIOUS_WINDOWS_UPDATE_COMMANDS = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-hero.ps1'; $command = \"Write-Host 'Starting AgentHero updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const OLDER_WINDOWS_UPDATE_COMMANDS = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-hero.ps1'; $command = \"Write-Host 'Starting AgentHero updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const POSIX_UPDATE_COMMANDS = ["bash ./scripts/update-agent-hero.sh"];
const PREVIOUS_WINDOWS_UPDATE_COMMANDS_LEGACY = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-control.ps1'; $command = \"Write-Host 'Starting AgentControl updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const OLDER_WINDOWS_UPDATE_COMMANDS_LEGACY = [
  "$script = Join-Path (Get-Location) 'scripts\\update-agent-control.ps1'; $command = \"Write-Host 'Starting AgentControl updater...'; & `\"$script`\"\"; Start-Process powershell -Verb RunAs -WorkingDirectory (Get-Location).Path -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $command)"
];
const POSIX_UPDATE_COMMANDS_LEGACY = ["bash ./scripts/update-agent-control.sh"];
const LEGACY_UPDATE_COMMANDS = ["git pull", "npm ci", "npm run build", "Restart-Service AgentControl"];
const LEGACY_BUILT_IN_AGENT_DIR = "~/.agent-control/built-in-agents";
const LEGACY_REPO_RELATIVE_BUILT_IN_AGENT_DIR = ".agent-control/built-in-agents";
const DEFAULT_RELEASE_MANIFEST_URL = "https://raw.githubusercontent.com/yohaas/AgentHero/main/installer/manifest.json";

export function defaultUpdateCommands(platform = process.platform, installMode: AppInstallMode = "checkout"): string[] {
  if (platform === "win32" && installMode === "installed") return WINDOWS_INSTALLED_UPDATE_COMMANDS;
  if (platform !== "win32" && installMode === "installed") return POSIX_INSTALLED_UPDATE_COMMANDS;
  return platform === "win32" ? WINDOWS_UPDATE_COMMANDS : POSIX_UPDATE_COMMANDS;
}

export interface DashboardSecrets {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  accessToken?: string;
}

export function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function ensurePrivateConfigDir(): Promise<void> {
  await migrateLegacyStateDir();
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700).catch(() => undefined);
}

export async function readConfig(): Promise<DashboardConfig> {
  try {
    await ensurePrivateConfigDir();
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw) as DashboardConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(config: DashboardConfig): Promise<DashboardConfig> {
  await ensurePrivateConfigDir();
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(configPath, 0o600).catch(() => undefined);
  return config;
}

export async function readSecrets(): Promise<DashboardSecrets> {
  try {
    await ensurePrivateConfigDir();
    const raw = await readFile(secretsPath, "utf8");
    return JSON.parse(raw) as DashboardSecrets;
  } catch {
    return {};
  }
}

export async function writeSecrets(secrets: DashboardSecrets): Promise<DashboardSecrets> {
  await ensurePrivateConfigDir();
  await writeFile(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(secretsPath, 0o600).catch(() => undefined);
  return secrets;
}

export function resolveProjectsRoot(config: DashboardConfig): string {
  return path.resolve(expandHome(config.projectsRoot || process.env.PROJECTS_ROOT || "~/projects"));
}

export function resolveModels(config: DashboardConfig): string[] {
  const models = config.models?.map((model) => model.trim()).filter(Boolean);
  return models?.length ? models : DEFAULT_MODELS;
}

export function resolveModelProfiles(config: DashboardConfig): ModelProfile[] {
  const profiles = Array.isArray(config.modelProfiles)
    ? config.modelProfiles
        .filter((profile): profile is ModelProfile =>
          Boolean(profile) &&
          typeof profile.id === "string" &&
          profile.id.trim().length > 0 &&
          (profile.provider === "claude" || profile.provider === "codex" || profile.provider === "openai")
        )
        .map((profile) => ({ ...profile, id: profile.id.trim(), label: profile.label?.trim() || undefined }))
    : [];
  if (profiles.length) return profiles;
  if (!config.models?.length) return DEFAULT_MODEL_PROFILES;
  return resolveModels(config).map((model, index) => ({
    id: model,
    provider: "claude",
    default: index === 0,
    supportsThinking: true,
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"]
  }));
}

export function resolveAgentDirs(config: DashboardConfig): Record<"claude" | "codex" | "openai" | "builtIn", string> {
  const builtInAgentDir = config.builtInAgentDir?.trim();
  const useDefaultBuiltInDir =
    !builtInAgentDir ||
    builtInAgentDir === LEGACY_BUILT_IN_AGENT_DIR ||
    builtInAgentDir === LEGACY_REPO_RELATIVE_BUILT_IN_AGENT_DIR;
  return {
    claude: config.claudeAgentDir?.trim() || ".claude/agents",
    codex: config.codexAgentDir?.trim() || ".codex/agents",
    openai: config.openaiAgentDir?.trim() || ".agent-hero/openai-agents",
    builtIn: useDefaultBuiltInDir ? DEFAULT_BUILT_IN_AGENT_DIR : builtInAgentDir
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function resolveTileHeight(config: DashboardConfig): number {
  if (config.tileHeight === 0) return 0;
  return clampNumber(config.tileHeight, 460, 320, 2000);
}

export function resolveTileColumns(config: DashboardConfig): number {
  return clampNumber(config.tileColumns, 2, 1, 6);
}

export function resolveGitFetchIntervalMinutes(config: DashboardConfig): number {
  return clampNumber(config.gitFetchIntervalMinutes, 15, 0, 1440);
}

export function resolveTileScrolling(config: DashboardConfig): TileScrollingMode {
  return config.tileScrolling === "horizontal" ? "horizontal" : "vertical";
}

export function resolveChatTranscriptDetail(config: DashboardConfig): ChatTranscriptDetailMode {
  return config.chatTranscriptDetail === "responses" ||
    config.chatTranscriptDetail === "detailed" ||
    config.chatTranscriptDetail === "raw"
    ? config.chatTranscriptDetail
    : "actions";
}

export function resolveChatFontFamily(config: DashboardConfig): string {
  return typeof config.chatFontFamily === "string" ? config.chatFontFamily.trim().slice(0, 160) : "";
}

export function resolveChatFontSize(config: DashboardConfig): number {
  return clampNumber(config.chatFontSize, 14, 11, 24);
}

export function resolveSidebarWidth(config: DashboardConfig): number {
  return clampNumber(config.sidebarWidth, 280, 240, 420);
}

export function resolveMenuDisplay(config: DashboardConfig): MenuDisplayMode {
  return config.menuDisplay === "iconText" ? "iconText" : "iconOnly";
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

export function resolveCodexDefaultAgentMode(config: DashboardConfig): AgentPermissionMode {
  return config.codexDefaultAgentMode === "default" ||
    config.codexDefaultAgentMode === "acceptEdits" ||
    config.codexDefaultAgentMode === "bypassPermissions"
    ? config.codexDefaultAgentMode
    : "default";
}

export function resolveClaudeRuntime(config: DashboardConfig): ClaudeRuntime {
  return config.claudeRuntime === "api" ? "api" : "cli";
}

export function resolveTerminalDock(config: DashboardConfig): TerminalDockPosition {
  return config.terminalDock === "float" ||
    config.terminalDock === "left" ||
    config.terminalDock === "right" ||
    config.terminalDock === "bottom"
    ? config.terminalDock
    : "bottom";
}

export function resolveFileExplorerDock(config: DashboardConfig): FileExplorerDockPosition {
  return config.fileExplorerDock === "tile" ||
    config.fileExplorerDock === "left" ||
    config.fileExplorerDock === "right" ||
    config.fileExplorerDock === "bottom"
    ? config.fileExplorerDock
    : "left";
}

export function resolveThemeMode(config: DashboardConfig): ThemeMode {
  return config.themeMode === "light" || config.themeMode === "dark" || config.themeMode === "auto" ? config.themeMode : "auto";
}

export function resolveAgentHeroProjectPath(config: DashboardConfig): string {
  return path.resolve(expandHome(config.agentControlProjectPath?.trim() || process.env.AGENTHERO_PROJECT_PATH || process.env.AGENTCONTROL_PROJECT_PATH || APP_ROOT));
}

export function resolveInstallMode(config: DashboardConfig): AppInstallMode {
  const value = (process.env.AGENTHERO_INSTALL_MODE || config.installMode || "").trim().toLowerCase();
  return value === "installed" ? "installed" : "checkout";
}

export function resolveUpdateManifestUrl(config: DashboardConfig): string | undefined {
  const installMode = resolveInstallMode(config);
  const candidates = [
    process.env.AGENTHERO_UPDATE_MANIFEST_URL,
    config.updateManifestUrl,
    installMode === "installed" ? DEFAULT_RELEASE_MANIFEST_URL : undefined
  ];
  for (const candidate of candidates) {
    const value = (candidate || "").trim();
    if (!value) continue;
    if (installMode === "installed" && !/^https?:\/\//i.test(value) && !existsSync(expandHome(value))) {
      continue;
    }
    return value;
  }
  return undefined;
}

export function resolveUpdateCommands(config: DashboardConfig): string[] {
  const commands = Array.isArray(config.updateCommands) ? config.updateCommands : [];
  const normalized = commands.map((command) => command.trim()).filter(Boolean);
  const commandKey = normalized.join("\n");
  if (
    normalized.length &&
    commandKey !== LEGACY_UPDATE_COMMANDS.join("\n") &&
    commandKey !== WINDOWS_UPDATE_COMMANDS.join("\n") &&
    commandKey !== WINDOWS_INSTALLED_UPDATE_COMMANDS.join("\n") &&
    commandKey !== POSIX_UPDATE_COMMANDS.join("\n") &&
    commandKey !== POSIX_INSTALLED_UPDATE_COMMANDS.join("\n") &&
    commandKey !== PREVIOUS_WINDOWS_UPDATE_COMMANDS.join("\n") &&
    commandKey !== OLDER_WINDOWS_UPDATE_COMMANDS.join("\n") &&
    commandKey !== PREVIOUS_WINDOWS_UPDATE_COMMANDS_LEGACY.join("\n") &&
    commandKey !== OLDER_WINDOWS_UPDATE_COMMANDS_LEGACY.join("\n") &&
    commandKey !== POSIX_UPDATE_COMMANDS_LEGACY.join("\n")
  ) {
    return normalized;
  }
  return defaultUpdateCommands(process.platform, resolveInstallMode(config));
}

export function resolveUpdateChecksEnabled(config: DashboardConfig): boolean {
  return config.updateChecksEnabled !== false;
}

export function resolveInputNotificationsEnabled(config: DashboardConfig): boolean {
  return config.inputNotificationsEnabled === true;
}

export function resolveExternalEditor(config: DashboardConfig): ExternalEditor {
  return config.externalEditor === "vscode" || config.externalEditor === "cursor" || config.externalEditor === "custom"
    ? config.externalEditor
    : "none";
}
