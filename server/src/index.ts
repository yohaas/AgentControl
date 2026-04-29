import http from "node:http";
import { execFile } from "node:child_process";
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import type { DashboardConfig } from "./config.js";
import type {
  Capabilities,
  AgentDef,
  DirectoryEntry,
  GitChangedFile,
  GitStatus,
  GitWorktree,
  GitWorktreeCreateRequest,
  GitWorktreeList,
  GitWorktreeMergeRequest,
  GitWorktreeRemoveRequest,
  LaunchRequest,
  MessageAttachment,
  ModelProfile,
  Project,
  ProjectFileEntry,
  WsClientCommand,
  WsServerEvent
} from "@agent-control/shared";
import { detectCapabilities } from "./capabilities.js";
import {
  expandHome,
  readConfig,
  readSecrets,
  resolveClaudeRuntime,
  resolveDefaultAgentMode,
  resolveAgentDirs,
  resolveModelProfiles,
  resolveModels,
  resolveMenuDisplay,
  resolvePinLastSentMessage,
  resolveProjectsRoot,
  resolveSidebarWidth,
  resolveTerminalDock,
  resolveThemeMode,
  resolveTileColumns,
  resolveTileHeight,
  writeConfig,
  writeSecrets
} from "./config.js";
import { addMarketplace, enablePlugin, installPlugin, listPlugins, normalizePluginProvider, pluginCatalog, supportsPluginProvider } from "./plugins.js";
import { AgentRuntimeManager } from "./runtime.js";
import { deleteBuiltInAgent, scanConfiguredProjects, scanProject, updateAgentPlugins, updateAgentPluginsFile, upsertBuiltInAgent } from "./scanner.js";
import { TerminalManager } from "./terminal.js";
import { isWslProject, normalizeWslPath, parseWslUncPath, wslCommandArgs, wslProjectPath, wslUncPath } from "./wsl.js";

const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const attachmentsDir = path.join(os.homedir(), ".agent-dashboard", "attachments");
const controlDir = path.join(os.homedir(), ".agent-dashboard");
const controlPath = path.join(controlDir, "control.json");
const supervised = process.env.AGENT_CONTROL_SUPERVISED === "1";
const ignoredContextDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage"]);
const appAuthToken = process.env.AGENTCONTROL_AUTH_TOKEN || nanoid(48);
const authCookieName = "agent_control_token";
const anthropicModelsApiUrl = "https://api.anthropic.com/v1/models";
const anthropicModelsDocUrl = "https://docs.anthropic.com/en/docs/about-claude/models/overview";
const anthropicOpus47NewsUrl = "https://www.anthropic.com/news/claude-opus-4-7";
const openAiModelsDocUrl = "https://developers.openai.com/api/docs/models";
const codexModelsDocUrl = "https://developers.openai.com/codex/models";
const fallbackClaudeModelIds = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

let config = await readConfig();
let secrets = await readSecrets();
if (config.claudePath) process.env.AGENTCONTROL_CLAUDE_PATH = config.claudePath;
if (config.codexPath) process.env.AGENTCONTROL_CODEX_PATH = config.codexPath;
if (config.gitPath) process.env.GIT_PATH = config.gitPath;
if (!process.env.ANTHROPIC_API_KEY && secrets.anthropicApiKey) process.env.ANTHROPIC_API_KEY = secrets.anthropicApiKey;
if (!process.env.OPENAI_API_KEY && secrets.openaiApiKey) process.env.OPENAI_API_KEY = secrets.openaiApiKey;
let agentDirs = resolveAgentDirs(config);
let projectsRoot = resolveProjectsRoot(config);
let projects: Project[] = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths, agentDirs) : [];
let capabilities: Capabilities = await detectCapabilities();
await ensurePrivateAttachmentsDir();

const app = express();
const server = http.createServer(app);
const clients = new Set<WebSocket>();

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function configuredAllowedOrigins(): string[] {
  return (process.env.AGENTCONTROL_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustedDefaultOrigins(): string[] {
  const serverPort = String(PORT);
  const devPort = process.env.AGENTCONTROL_WEB_PORT || "4318";
  const hosts = new Set(["127.0.0.1", "localhost"]);
  if (HOST && HOST !== "0.0.0.0" && HOST !== "::") hosts.add(HOST);
  return [...hosts].flatMap((host) => [`http://${host}:${serverPort}`, `http://${host}:${devPort}`]);
}

function uniqueModelIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()).filter(Boolean))];
}

function openAiModelRank(id: string): [number, number, number] {
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?(?:-(mini|nano|pro))?$/);
  if (!match) return [0, 0, 99];
  const family = Number(match[1]);
  const minor = Number(match[2] || 0);
  const variantRank = match[3] === "pro" ? 1 : match[3] === "mini" ? 2 : match[3] === "nano" ? 3 : 0;
  return [family, minor, variantRank];
}

function sortOpenAiModels(ids: string[]): string[] {
  return [...ids].sort((left, right) => {
    const [leftFamily, leftMinor, leftVariant] = openAiModelRank(left);
    const [rightFamily, rightMinor, rightVariant] = openAiModelRank(right);
    if (leftFamily !== rightFamily) return rightFamily - leftFamily;
    if (leftMinor !== rightMinor) return rightMinor - leftMinor;
    return leftVariant - rightVariant;
  });
}

function codexModelRank(id: string): [number, number, number] {
  const match = id.match(/^gpt-(\d+)(?:\.(\d+))?-codex(?:-(spark|mini|max))?$/);
  if (!match) return [0, 0, 99];
  const family = Number(match[1]);
  const minor = Number(match[2] || 0);
  const variantRank = match[3] === "spark" ? 1 : match[3] === "max" ? 2 : match[3] === "mini" ? 3 : 0;
  return [family, minor, variantRank];
}

function sortCodexModels(ids: string[]): string[] {
  return [...ids].sort((left, right) => {
    const [leftFamily, leftMinor, leftVariant] = codexModelRank(left);
    const [rightFamily, rightMinor, rightVariant] = codexModelRank(right);
    if (leftFamily !== rightFamily) return rightFamily - leftFamily;
    if (leftMinor !== rightMinor) return rightMinor - leftMinor;
    return leftVariant - rightVariant;
  });
}

function modelProfiles(ids: string[], provider: "codex" | "openai"): ModelProfile[] {
  return ids.map((id, index) => ({
    id,
    provider,
    default: index === 0,
    supportedEfforts: ["low", "medium", "high", "xhigh"]
  }));
}

function claudeModelProfiles(ids: string[]): ModelProfile[] {
  return ids.map((id, index) => ({
    id,
    provider: "claude",
    default: index === 0,
    supportsThinking: /\b(opus|sonnet)\b/.test(id),
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"]
  }));
}

function claudeModelRank(id: string): [number, number, number, number] {
  const date = Number(id.match(/-(\d{8})$/)?.[1] || 0);
  const family = id.includes("opus") ? 3 : id.includes("sonnet") ? 2 : id.includes("haiku") ? 1 : 0;
  const versionMatch = id.match(/claude-(?:3(?:-(\d+))?|(\w+)-(\d+)(?:-(\d+))?)/);
  const major = Number(versionMatch?.[2] || (id.includes("claude-3") ? 3 : 0));
  const minor = Number(versionMatch?.[4] || versionMatch?.[1] || 0);
  return [date, major, minor, family];
}

function sortClaudeModels(ids: string[]): string[] {
  return [...ids].sort((left, right) => {
    const [leftDate, leftMajor, leftMinor, leftFamily] = claudeModelRank(left);
    const [rightDate, rightMajor, rightMinor, rightFamily] = claudeModelRank(right);
    if (leftDate !== rightDate) return rightDate - leftDate;
    if (leftMajor !== rightMajor) return rightMajor - leftMajor;
    if (leftMinor !== rightMinor) return rightMinor - leftMinor;
    return rightFamily - leftFamily;
  });
}

function parsePublishedClaudeModels(html: string): ModelProfile[] {
  const explicitApiIds = [...html.matchAll(/Developers can use\s+[`"“]([^`"”]+)[`"”]/gi)].map((match) => match[1]);
  const ids = uniqueModelIds([...explicitApiIds, ...fallbackClaudeModelIds])
    .filter((id) => /^claude-(?:opus|sonnet|haiku)-\d-\d$/.test(id))
    .filter((id) => !id.endsWith("-v1"));
  return claudeModelProfiles(sortClaudeModels(ids));
}

async function fetchAnthropicApiModels(): Promise<ModelProfile[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const response = await fetch(anthropicModelsApiUrl, {
    headers: {
      "User-Agent": "AgentControl model updater",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    }
  });
  if (!response.ok) throw new Error(`${anthropicModelsApiUrl} returned ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: string; created_at?: string }> };
  const ids = uniqueModelIds((body.data || []).map((model) => model.id || "").filter(Boolean));
  return claudeModelProfiles(ids.length ? ids : []);
}

async function fetchClaudeModels(): Promise<{ sourceUrl: string; models: ModelProfile[] }> {
  try {
    const models = await fetchAnthropicApiModels();
    if (models.length > 0) return { sourceUrl: anthropicModelsApiUrl, models };
  } catch {
    // Fall back to the public docs when no Anthropic key is configured or the API is unavailable.
  }
  const [modelsHtml, opus47Html] = await Promise.all([fetchText(anthropicModelsDocUrl), fetchText(anthropicOpus47NewsUrl)]);
  return {
    sourceUrl: anthropicModelsDocUrl,
    models: parsePublishedClaudeModels(`${modelsHtml}\n${opus47Html}`)
  };
}

function parsePublishedOpenAiModels(html: string): ModelProfile[] {
  const ids = uniqueModelIds([...html.matchAll(/\bgpt-\d+(?:\.\d+)?(?:-(?:mini|nano|pro))?\b/gi)].map((match) => match[0]));
  return modelProfiles(sortOpenAiModels(ids), "openai");
}

function parsePublishedCodexModels(html: string): ModelProfile[] {
  const commandIds = [...html.matchAll(/\bcodex\s+-m\s+([a-z0-9.-]+)/gi)]
    .map((match) => match[1])
    .filter((id) => /-codex\b/.test(id));
  const fallbackIds = [...html.matchAll(/\bgpt-\d+(?:\.\d+)?-codex(?:-[a-z0-9]+)?\b/gi)].map((match) => match[0]);
  return modelProfiles(sortCodexModels(uniqueModelIds(commandIds.length ? commandIds : fallbackIds)), "codex");
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "AgentControl model updater"
    }
  });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.text();
}

async function fetchPublishedModels() {
  const [claude, openAiHtml, codexHtml] = await Promise.all([
    fetchClaudeModels(),
    fetchText(openAiModelsDocUrl),
    fetchText(codexModelsDocUrl)
  ]);
  return {
    fetchedAt: new Date().toISOString(),
    sourceUrls: {
      claude: claude.sourceUrl,
      openai: openAiModelsDocUrl,
      codex: codexModelsDocUrl
    },
    providers: {
      claude: claude.models,
      openai: parsePublishedOpenAiModels(openAiHtml),
      codex: parsePublishedCodexModels(codexHtml)
    }
  };
}

async function fetchPublishedProviderModels(provider: "claude" | "codex" | "openai") {
  const fetchedAt = new Date().toISOString();
  if (provider === "claude") {
    const claude = await fetchClaudeModels();
    return {
      fetchedAt,
      sourceUrls: { claude: claude.sourceUrl },
      providers: { claude: claude.models }
    };
  }
  if (provider === "codex") {
    return {
      fetchedAt,
      sourceUrls: { codex: codexModelsDocUrl },
      providers: { codex: parsePublishedCodexModels(await fetchText(codexModelsDocUrl)) }
    };
  }
  return {
    fetchedAt,
    sourceUrls: { openai: openAiModelsDocUrl },
    providers: { openai: parsePublishedOpenAiModels(await fetchText(openAiModelsDocUrl)) }
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const configured = configuredAllowedOrigins();
    if (configured.length) return configured.includes(parsed.origin);
    return isLoopbackHost(parsed.hostname) && trustedDefaultOrigins().includes(parsed.origin);
  } catch {
    return false;
  }
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  return Object.fromEntries(
    cookieHeader
      .split(";")
      .map((part) => {
        const [name = "", ...valueParts] = part.trim().split("=");
        return [decodeURIComponent(name), decodeURIComponent(valueParts.join("="))];
      })
      .filter(([name]) => Boolean(name))
  );
}

function requestToken(request: express.Request): string | undefined {
  const header = request.header("x-agent-control-token");
  if (header) return header;
  const authorization = request.header("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return parseCookies(request.header("cookie"))[authCookieName];
}

function isAuthenticatedRequest(request: express.Request): boolean {
  return isAllowedOrigin(request.header("origin")) && requestToken(request) === appAuthToken;
}

function canIssueToken(request: express.Request): boolean {
  const origin = request.header("origin");
  if (origin) return isAllowedOrigin(origin);
  return isLoopbackAddress(request.socket.remoteAddress);
}

function webSocketToken(request: http.IncomingMessage): string | undefined {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const queryToken = requestUrl.searchParams.get("token");
  if (queryToken) return queryToken;
  const header = request.headers["x-agent-control-token"];
  if (typeof header === "string") return header;
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return parseCookies(request.headers.cookie)[authCookieName];
}

function isAuthenticatedWebSocket(request: http.IncomingMessage): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  return isAllowedOrigin(origin) && webSocketToken(request) === appAuthToken;
}

function setAuthCookie(response: express.Response): void {
  response.cookie(authCookieName, appAuthToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/"
  });
}

function send(ws: WebSocket, event: WsServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function broadcast(event: WsServerEvent): void {
  for (const client of clients) send(client, event);
}

async function ensurePrivateAttachmentsDir(): Promise<void> {
  await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
  await chmod(attachmentsDir, 0o700).catch(() => undefined);
  const entries = await readdir(attachmentsDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => chmod(path.join(attachmentsDir, entry.name), 0o600).catch(() => undefined))
  );
}

function normalizedProjectPath(projectPath: string): string {
  const resolved = path.resolve(expandHome(projectPath));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function projectById(id: string): Project | undefined {
  return projects.find((candidate) => candidate.id === id);
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function pathInsideOrEqual(parent: string, child: string): boolean {
  const normalizedParent = normalizedProjectPath(parent);
  const normalizedChild = normalizedProjectPath(child);
  const relative = path.relative(normalizedParent, normalizedChild);
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function allowedDirectoryRoots(): Promise<DirectoryEntry[]> {
  await mkdir(projectsRoot, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const candidates: DirectoryEntry[] = [
    { name: "Home", path: os.homedir() },
    { name: "Projects", path: projectsRoot },
    ...projects.map((project) => ({ name: project.name, path: project.path })),
    { name: "Claude agents", path: agentDirs.claude },
    { name: "Codex agents", path: agentDirs.codex },
    { name: "OpenAI agents", path: agentDirs.openai },
    { name: "Built-in agents", path: agentDirs.builtIn }
  ];
  const seen = new Set<string>();
  const roots: DirectoryEntry[] = [];
  for (const candidate of candidates) {
    const rootPath = path.resolve(expandHome(candidate.path));
    const key = normalizedProjectPath(rootPath);
    if (seen.has(key)) continue;
    seen.add(key);
    const info = await stat(rootPath).catch(() => undefined);
    if (info?.isDirectory()) roots.push({ name: candidate.name, path: rootPath });
  }
  return roots;
}

function isAllowedDirectoryPath(directoryPath: string, roots: DirectoryEntry[]): boolean {
  return roots.some((root) => pathInsideOrEqual(root.path, directoryPath));
}

function mimeTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if ([".png"].includes(ext)) return "image/png";
  if ([".jpg", ".jpeg"].includes(ext)) return "image/jpeg";
  if ([".webp"].includes(ext)) return "image/webp";
  if ([".gif"].includes(ext)) return "image/gif";
  if ([".json"].includes(ext)) return "application/json";
  if ([".md", ".markdown"].includes(ext)) return "text/markdown";
  if ([".html", ".htm"].includes(ext)) return "text/html";
  if ([".css"].includes(ext)) return "text/css";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "text/javascript";
  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) return "text/typescript";
  if ([".txt", ".log", ".yml", ".yaml", ".xml", ".csv", ".env", ".toml", ".ini", ".sql", ".py", ".rb", ".go", ".rs", ".java", ".cs", ".cpp", ".c", ".h", ".php", ".sh", ".ps1"].includes(ext)) {
    return "text/plain";
  }
  return "application/octet-stream";
}

function attachmentExtension(mimeType: string, fallbackName: string): string {
  const ext = path.extname(fallbackName).replace(/^\./, "").toLowerCase();
  if (ext) return ext.replace(/[^a-z0-9]/g, "").slice(0, 12) || "bin";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType.includes("/")) return mimeType.split("/")[1].replace(/[^a-z0-9]/g, "").slice(0, 12) || "bin";
  return "bin";
}

async function listProjectFiles(project: Project, query = "", limit = 500): Promise<ProjectFileEntry[]> {
  const root = path.resolve(project.path);
  const normalizedQuery = query.trim().toLowerCase();
  const results: ProjectFileEntry[] = [];
  const stack = [root];

  while (stack.length > 0 && results.length < limit) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }))) {
      const absolutePath = path.join(current, entry.name);
      const relativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        if (!ignoredContextDirs.has(entry.name)) stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (normalizedQuery && !relativePath.toLowerCase().includes(normalizedQuery)) continue;
      const info = await stat(absolutePath).catch(() => undefined);
      if (!info?.isFile()) continue;
      results.push({
        path: relativePath,
        name: entry.name,
        size: info.size,
        modifiedAt: info.mtime.toISOString()
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

async function requestSupervisor(command: "restart" | "shutdown"): Promise<void> {
  await mkdir(controlDir, { recursive: true });
  await writeFile(controlPath, `${JSON.stringify({ command, requestedAt: new Date().toISOString(), pid: process.pid }, null, 2)}\n`, "utf8");
}

function gitStatusLabel(code: string): string {
  if (code.includes("?")) return "untracked";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("U")) return "conflict";
  return code.trim() || "changed";
}

function parseGitStatus(output: string): GitStatus {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const header = lines.find((line) => line.startsWith("## "));
  let branch: string | undefined;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  if (header) {
    const details = header.slice(3);
    const [branchPart, flagsPart = ""] = details.split(" [");
    const [nextBranch, nextUpstream] = branchPart.split("...");
    branch = nextBranch;
    upstream = nextUpstream;
    const aheadMatch = flagsPart.match(/ahead (\d+)/);
    const behindMatch = flagsPart.match(/behind (\d+)/);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
  }

  const files: GitChangedFile[] = lines
    .filter((line) => !line.startsWith("## "))
    .map((line) => {
      const code = line.slice(0, 2);
      const pathValue = line.slice(3).trim();
      return {
        path: pathValue,
        status: gitStatusLabel(code)
      };
    });

  return {
    isRepo: true,
    branch,
    upstream,
    ahead,
    behind,
    files
  };
}

function parseGitWorktrees(output: string, currentPath: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = undefined;
      continue;
    }
    const [key, ...valueParts] = line.split(" ");
    const value = valueParts.join(" ");
    if (key === "worktree") {
      if (current) worktrees.push(current);
      current = { path: value };
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) worktrees.push(current);

  const normalizedCurrent = normalizedProjectPath(currentPath);
  return worktrees.map((worktree) => {
    const project = projects.find((candidate) => normalizedProjectPath(candidate.path) === normalizedProjectPath(worktree.path));
    return {
      ...worktree,
      current: normalizedProjectPath(worktree.path) === normalizedCurrent,
      projectId: project?.id
    };
  });
}

interface GitCommandOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMessage?: string;
}

function gitCommand(target: string | Project, args: string[], timeout = 15000, options: GitCommandOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const command = typeof target !== "string" && isWslProject(target) ? "wsl.exe" : process.env.GIT_PATH || "git";
    const commandArgs = typeof target !== "string" && isWslProject(target) ? wslCommandArgs(target, "git", args) : args;
    const cwd = typeof target === "string" ? target : target.path;
    execFile(command, commandArgs, { cwd, timeout, windowsHide: true, env: { ...process.env, ...options.env } }, (error, stdout, stderr) => {
      if (error) {
        const timedOut = "killed" in error && error.killed;
        const output = [stderr, stdout].filter(Boolean).join("\n").trim();
        reject(new Error(timedOut ? options.timeoutMessage || output || error.message || "Git command timed out." : output || error.message || "Git command failed."));
        return;
      }
      resolve(stdout);
    });
  });
}

function wslExec(project: Project, command: string, args: string[] = [], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", wslCommandArgs(project, command, args), { cwd: project.path, timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "WSL command failed.").trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseWslDistroOutput(output: string): string[] {
  return output
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter(Boolean);
}

function listWslDistros(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", ["-l", "-q"], { timeout: 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "Unable to list WSL distros.").replace(/\0/g, "").trim()));
        return;
      }
      resolve(parseWslDistroOutput(stdout));
    });
  });
}

function safeWorktreeBranchName(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, "");
}

function defaultWorktreePath(project: Project, branch: string): string {
  const safeBranch = safeWorktreeBranchName(branch).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
  if (isWslProject(project)) {
    const baseName = path.posix.basename(wslProjectPath(project));
    return path.posix.join(path.posix.dirname(wslProjectPath(project)), `${baseName}-worktrees`, safeBranch);
  }
  return path.join(path.dirname(project.path), `${path.basename(project.path)}-worktrees`, safeBranch);
}

function configuredProjectAgentDirs(projectPath: string): Array<{ source: string; relative: string }> {
  return [agentDirs.claude, agentDirs.codex, agentDirs.openai]
    .map((configuredDir) => {
      const expanded = expandHome(configuredDir);
      const source = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(projectPath, expanded);
      const relative = path.relative(path.resolve(projectPath), source);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
      return { source, relative };
    })
    .filter((entry): entry is { source: string; relative: string } => Boolean(entry));
}

async function copyLocalAgentFiles(projectPath: string, targetPath: string): Promise<void> {
  for (const agentDir of configuredProjectAgentDirs(projectPath)) {
    const sourceInfo = await stat(agentDir.source).catch(() => undefined);
    if (!sourceInfo?.isDirectory()) continue;
    await cp(agentDir.source, path.resolve(targetPath, agentDir.relative), {
      recursive: true,
      force: false,
      errorOnExist: false
    });
  }
}

async function refreshConfiguredProjects(): Promise<Project[]> {
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths, agentDirs) : [];
  return projects;
}

async function ensureProjectPath(projectPath: string): Promise<Project | null> {
  const project = await scanProject(projectPath, agentDirs);
  if (!project) return null;
  const projectPaths = Array.from(new Set([...(config.projectPaths || []), project.path]));
  config = await writeConfig({ ...config, projectPaths });
  await refreshConfiguredProjects();
  return projects.find((candidate) => candidate.id === project.id) || project;
}

async function removeProjectPath(projectPath: string): Promise<void> {
  const closePath = normalizedProjectPath(projectPath);
  const project = projects.find((candidate) => normalizedProjectPath(candidate.path) === closePath);
  if (project) {
    runtime.clearAll(project.id);
    terminals.closeProject(project.id);
  }
  const projectPaths = (config.projectPaths || []).filter((candidate) => normalizedProjectPath(candidate) !== closePath);
  config = await writeConfig({ ...config, projectPaths });
  await refreshConfiguredProjects();
}

async function projectWorktrees(project: Project): Promise<GitWorktreeList> {
  try {
    const repoPath = (await gitCommand(project, ["rev-parse", "--show-toplevel"])).trim();
    const output = await gitCommand(project, ["worktree", "list", "--porcelain"]);
    return {
      isRepo: true,
      projectId: project.id,
      repoPath: isWslProject(project) ? wslUncPath(project.wslDistro || "Ubuntu", repoPath) : repoPath,
      currentPath: project.path,
      worktrees: parseGitWorktrees(output, isWslProject(project) ? wslProjectPath(project) : project.path).map((worktree) => {
        const worktreePath = isWslProject(project) ? wslUncPath(project.wslDistro || "Ubuntu", worktree.path) : worktree.path;
        const openProject = projects.find((candidate) => normalizedProjectPath(candidate.path) === normalizedProjectPath(worktreePath));
        return {
          ...worktree,
          path: worktreePath,
          projectId: openProject?.id
        };
      })
    };
  } catch (error) {
    return {
      isRepo: false,
      projectId: project.id,
      worktrees: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function createProjectWorktree(project: Project, request: GitWorktreeCreateRequest): Promise<{ projects: Project[]; worktrees: GitWorktreeList }> {
  const branch = safeWorktreeBranchName(request.branch);
  if (!branch) throw new Error("Branch name is required.");
  const rawTargetPath = request.path?.trim() || defaultWorktreePath(project, branch);
  const targetPath = isWslProject(project)
    ? normalizeWslPath(parseWslUncPath(rawTargetPath)?.wslPath || rawTargetPath)
    : path.resolve(expandHome(rawTargetPath));
  const projectPathToStore = isWslProject(project) ? wslUncPath(project.wslDistro || "Ubuntu", targetPath) : targetPath;
  if (projects.some((candidate) => normalizedProjectPath(candidate.path) === normalizedProjectPath(projectPathToStore))) {
    throw new Error("That worktree is already open as a project.");
  }
  if (!isWslProject(project)) {
    await mkdir(path.dirname(targetPath), { recursive: true });
    const parentInfo = await stat(path.dirname(targetPath)).catch(() => undefined);
    if (!parentInfo?.isDirectory()) throw new Error("Worktree parent folder does not exist.");
    const existing = await stat(targetPath).catch(() => undefined);
    if (existing) throw new Error("Worktree path already exists.");
  } else {
    await wslExec(project, "mkdir", ["-p", path.posix.dirname(targetPath)]);
    const existing = await wslExec(project, "test", ["-e", targetPath])
      .then(() => true)
      .catch(() => false);
    if (existing) throw new Error("Worktree path already exists.");
  }

  const args = ["worktree", "add"];
  if (request.createBranch !== false) args.push("-b", branch, targetPath, request.base?.trim() || "HEAD");
  else args.push(targetPath, branch);
  await gitCommand(project, args, 120000);
  if (request.copyLocalAgentFiles && !isWslProject(project)) await copyLocalAgentFiles(project.path, targetPath);
  await ensureProjectPath(projectPathToStore);
  return { projects, worktrees: await projectWorktrees(project) };
}

async function mergeProjectWorktree(project: Project, request: GitWorktreeMergeRequest): Promise<GitWorktreeList> {
  const sourcePath = isWslProject(project)
    ? wslUncPath(project.wslDistro || "Ubuntu", normalizeWslPath(parseWslUncPath(request.sourcePath)?.wslPath || request.sourcePath))
    : path.resolve(expandHome(request.sourcePath));
  const worktrees = await projectWorktrees(project);
  const source = worktrees.worktrees.find((worktree) => normalizedProjectPath(worktree.path) === normalizedProjectPath(sourcePath));
  if (!source) throw new Error("Worktree was not found for this repository.");
  if (source.current) throw new Error("Choose a different worktree to merge into the current project.");
  if (!source.branch) throw new Error("Detached worktrees cannot be merged from the dashboard.");
  const dirty = (await gitCommand(project, ["status", "--porcelain"])).trim();
  if (dirty) throw new Error("Current project has uncommitted changes. Commit, stash, or discard them before merging.");
  await gitCommand(project, ["merge", source.branch], 120000);
  return projectWorktrees(project);
}

async function removeProjectWorktree(project: Project, request: GitWorktreeRemoveRequest): Promise<{ projects: Project[]; worktrees: GitWorktreeList }> {
  const targetPath = isWslProject(project)
    ? wslUncPath(project.wslDistro || "Ubuntu", normalizeWslPath(parseWslUncPath(request.path)?.wslPath || request.path))
    : path.resolve(expandHome(request.path));
  const worktrees = await projectWorktrees(project);
  const target = worktrees.worktrees.find((worktree) => normalizedProjectPath(worktree.path) === normalizedProjectPath(targetPath));
  if (!target) throw new Error("Worktree was not found for this repository.");
  if (target.current) throw new Error("The current project worktree cannot be removed from this view.");

  const args = ["worktree", "remove"];
  if (request.force) args.push("--force");
  args.push(isWslProject(project) ? wslProjectPath({ path: target.path, wslPath: parseWslUncPath(target.path)?.wslPath }) : target.path);
  await gitCommand(project, args, 120000);
  await removeProjectPath(target.path);
  if (target.prunable) await rm(target.path, { recursive: true, force: true }).catch(() => undefined);
  return { projects, worktrees: await projectWorktrees(project) };
}

function openWithDefaultApp(filePath: string): Promise<void> {
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Invoke-Item -LiteralPath $args[0]",
        filePath
      ], {
        windowsHide: true
      }, (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message || "Unable to open path."));
          return;
        }
        resolve();
      });
    });
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  return new Promise((resolve, reject) => {
    execFile(command, [filePath], { windowsHide: true }, (error) => {
      if (error) {
        reject(new Error(error.message || "Unable to open file."));
        return;
      }
      resolve();
    });
  });
}

function isOpenablePath(filePath: string): boolean {
  if (projects.some((project) => pathInsideOrEqual(project.path, filePath))) return true;
  return pathInsideOrEqual(agentDirs.builtIn, filePath);
}

async function projectGitStatus(project: Project): Promise<GitStatus> {
  try {
    const output = await gitCommand(project, ["status", "--porcelain=v1", "--branch"]);
    return parseGitStatus(output);
  } catch (error) {
    return {
      isRepo: false,
      ahead: 0,
      behind: 0,
      files: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function ensureLaunchPluginsEnabled(request: LaunchRequest): Promise<void> {
  const project = projectById(request.projectId);
  const projectDef = project?.agents.find((agent) => agent.name === request.defName);
  const builtInDef = project?.builtInAgents?.find((agent) => agent.name === request.defName);
  const def = request.agentSource === "builtIn" ? builtInDef || projectDef : projectDef || builtInDef;
  const plugins = def?.plugins || [];
  if (plugins.length === 0) return;
  const provider = request.provider || def?.provider || "claude";
  if (!supportsPluginProvider(provider)) {
    throw new Error("OpenAI API sessions do not support local AgentControl plugins.");
  }

  const installed = await listPlugins(provider);
  const byName = new Map(installed.map((plugin) => [plugin.name, plugin]));
  for (const plugin of plugins) {
    const current = byName.get(plugin);
    if (!current) throw new Error(`Plugin ${plugin} is selected for ${def?.name || request.defName} but is not installed.`);
    if (!current.enabled) await enablePlugin(plugin, provider);
  }
}

function requestPluginProvider(value: unknown): ReturnType<typeof normalizePluginProvider> {
  if (value === "openai") throw new Error("OpenAI API sessions do not expose a local plugin catalog.");
  return normalizePluginProvider(value);
}

const runtime = new AgentRuntimeManager(
  () => projects,
  broadcast,
  () => capabilities,
  () => resolveClaudeRuntime(config),
  () => (Array.isArray(config.permissionAllowRules) ? config.permissionAllowRules : [])
);
await runtime.loadPersistedState();
const terminals = new TerminalManager(() => projects, broadcast);

app.use(express.json({ limit: "20mb" }));
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin) ? origin || false : false);
    }
  })
);

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get("/api/auth/token", (request, response) => {
  if (!canIssueToken(request)) {
    response.status(403).json({ error: "Origin is not allowed." });
    return;
  }
  setAuthCookie(response);
  response.json({ token: appAuthToken });
});

app.use((request, response, next) => {
  if (request.path === "/api/health" || request.path === "/api/auth/token" || request.path === "/api/permissions/request") {
    next();
    return;
  }
  if (!request.path.startsWith("/api/")) {
    setAuthCookie(response);
    next();
    return;
  }
  if (isAuthenticatedRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ error: "AgentControl API authentication is required." });
});

app.get("/api/projects", (_request, response) => {
  response.json(projects);
});

app.get("/api/projects/:id/agents", (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  response.json(project.agents);
});

app.put("/api/projects/:id/agents/:name/plugins", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  const plugins = Array.isArray(request.body?.plugins)
    ? request.body.plugins
        .filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item: string) => item.trim())
    : [];
  try {
    const agent = project.agents.find((item) => item.name === request.params.name);
    if (agent?.sourcePath) await updateAgentPluginsFile(agent.sourcePath, plugins);
    else await updateAgentPlugins(project.path, request.params.name, plugins, agentDirs);
    await refreshConfiguredProjects();
    response.json(projects);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/projects/:id/built-in-agents", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  const body = request.body as Partial<AgentDef> & { originalName?: string };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    response.status(400).json({ error: "Agent name is required." });
    return;
  }
  const agent: AgentDef = {
    name,
    description: typeof body.description === "string" && body.description.trim() ? body.description.trim() : undefined,
    color: typeof body.color === "string" && body.color.trim() ? body.color.trim() : "#ffffff",
    provider: body.provider === "codex" || body.provider === "openai" || body.provider === "claude" ? body.provider : "claude",
    defaultModel: typeof body.defaultModel === "string" && body.defaultModel.trim() ? body.defaultModel.trim() : undefined,
    tools: Array.isArray(body.tools) ? body.tools.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    plugins: Array.isArray(body.plugins) ? body.plugins.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [],
    systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : "",
    builtIn: true
  };
  try {
    await upsertBuiltInAgent(project.path, agent, typeof body.originalName === "string" ? body.originalName : undefined, agentDirs);
    await refreshConfiguredProjects();
    response.json(projects);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/projects/:id/built-in-agents/:name", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  try {
    await deleteBuiltInAgent(project.path, request.params.name, agentDirs);
    await refreshConfiguredProjects();
    response.json(projects);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/projects/:id/files", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    const query = typeof request.query.query === "string" ? request.query.query : "";
    response.json(await listProjectFiles(project, query));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/projects/:id/context", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  const relativePath = typeof request.body?.path === "string" ? request.body.path.trim() : "";
  if (!relativePath) {
    response.status(400).json({ error: "File path is required." });
    return;
  }

  const root = path.resolve(project.path);
  const absolutePath = path.resolve(root, relativePath);
  if (!pathInside(root, absolutePath)) {
    response.status(400).json({ error: "Context file must be inside the project." });
    return;
  }

  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      response.status(400).json({ error: "Context path must be a file." });
      return;
    }
    const normalizedRelativePath = path.relative(root, absolutePath).replace(/\\/g, "/");
    const attachment: MessageAttachment = {
      id: nanoid(12),
      name: path.basename(absolutePath),
      mimeType: mimeTypeForPath(absolutePath),
      size: info.size,
      kind: "context",
      path: absolutePath,
      relativePath: normalizedRelativePath
    };
    response.json(attachment);
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/refresh", async (_request, response) => {
  await refreshConfiguredProjects();
  response.json(projects);
});

app.post("/api/projects", async (request, response) => {
  const runtime = request.body?.runtime === "wsl" ? "wsl" : "local";
  const wslDistroName = typeof request.body?.wslDistro === "string" ? request.body.wslDistro.trim() : "";
  const bodyWslPath = typeof request.body?.wslPath === "string" ? request.body.wslPath.trim() : "";
  const bodyPath = typeof request.body?.path === "string" ? request.body.path.trim() : "";
  if (runtime === "wsl" && !bodyWslPath && !bodyPath) {
    response.status(400).json({ error: "WSL project path is required." });
    return;
  }
  const projectPath =
    runtime === "wsl"
      ? wslUncPath(wslDistroName || "Ubuntu", normalizeWslPath(bodyWslPath || parseWslUncPath(bodyPath)?.wslPath || bodyPath))
      : bodyPath;
  if (!projectPath) {
    response.status(400).json({ error: "Project path is required." });
    return;
  }

  const project = await scanProject(projectPath, agentDirs);
  if (!project) {
    response.status(404).json({ error: "Project path was not found or is not a directory." });
    return;
  }

  const projectPaths = Array.from(new Set([...(config.projectPaths || []), project.path]));
  config = await writeConfig({ ...config, projectPaths });
  projects = await scanConfiguredProjects(projectPaths, agentDirs);
  response.json(projects);
});

app.delete("/api/projects/:id", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  runtime.clearAll(project.id);
  terminals.closeProject(project.id);

  const closePath = normalizedProjectPath(project.path);
  const projectPaths = (config.projectPaths || []).filter((projectPath) => normalizedProjectPath(projectPath) !== closePath);
  config = await writeConfig({ ...config, projectPaths });
  projects = await scanConfiguredProjects(projectPaths, agentDirs);
  response.json(projects);
});

app.get("/api/projects/:id/git/status", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  response.json(await projectGitStatus(project));
});

app.post("/api/projects/:id/git/push", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  const status = await projectGitStatus(project);
  if (!status.isRepo) {
    response.status(400).json({ error: status.message || "Project is not a Git repository." });
    return;
  }
  if (status.ahead <= 0) {
    response.json(status);
    return;
  }

  try {
    await gitCommand(project, ["push", "--porcelain"], 120000, {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMessage: "Git push timed out. Git may be waiting for credentials or remote interaction that AgentControl cannot display."
    });
    response.json(await projectGitStatus(project));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/projects/:id/git/worktrees", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  response.json(await projectWorktrees(project));
});

app.post("/api/projects/:id/git/worktrees", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    response.json(await createProjectWorktree(project, request.body as GitWorktreeCreateRequest));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/projects/:id/git/worktrees/merge", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    response.json(await mergeProjectWorktree(project, request.body as GitWorktreeMergeRequest));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/projects/:id/git/worktrees", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    response.json(await removeProjectWorktree(project, request.body as GitWorktreeRemoveRequest));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/wsl/distros", async (_request, response) => {
  try {
    const distros = await listWslDistros();
    response.json({ defaultDistro: distros[0] || "Ubuntu", distros });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/filesystem/directories", async (request, response) => {
  const runtime = request.query.runtime === "wsl" ? "wsl" : "local";
  if (runtime === "wsl") {
    const distro = typeof request.query.distro === "string" && request.query.distro.trim() ? request.query.distro.trim() : "Ubuntu";
    const requestedPath = typeof request.query.path === "string" && request.query.path.trim() ? request.query.path.trim() : "/home";
    const linuxPath = normalizeWslPath(requestedPath);
    const directoryPath = wslUncPath(distro, linuxPath);
    try {
      const info = await stat(directoryPath);
      if (!info.isDirectory()) {
        response.status(400).json({ error: "Selected WSL path is not a directory." });
        return;
      }

      const entries = await readdir(directoryPath, { withFileTypes: true });
      const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          name: entry.name,
          path: path.posix.join(linuxPath, entry.name)
        }))
        .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
      const parentPath = path.posix.dirname(linuxPath);

      response.json({
        path: linuxPath,
        parentPath: parentPath !== linuxPath ? parentPath : undefined,
        homePath: "/home",
        roots: [
          { name: "/", path: "/" },
          { name: "home", path: "/home" },
          { name: "mnt", path: "/mnt" }
        ],
        entries: directories
      });
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const roots = await allowedDirectoryRoots();
  const requestedPath = typeof request.query.path === "string" && request.query.path.trim() ? request.query.path.trim() : roots[0]?.path || projectsRoot;
  const directoryPath = path.resolve(expandHome(requestedPath));
  if (!isAllowedDirectoryPath(directoryPath, roots)) {
    response.status(403).json({ error: "Folder browsing is limited to your home folder, configured projects, and agent directories." });
    return;
  }

  try {
    const info = await stat(directoryPath);
    if (!info.isDirectory()) {
      response.status(400).json({ error: "Selected path is not a directory." });
      return;
    }

    const entries = await readdir(directoryPath, { withFileTypes: true });
    const directories = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        name: entry.name,
        path: path.join(directoryPath, entry.name)
      }))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    const parentPath = path.dirname(directoryPath);

    response.json({
      path: directoryPath,
      parentPath: parentPath !== directoryPath && isAllowedDirectoryPath(parentPath, roots) ? parentPath : undefined,
      homePath: os.homedir(),
      roots,
      entries: directories
    });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/filesystem/open", async (request, response) => {
  const requestedPath = typeof request.body?.path === "string" ? request.body.path.trim() : "";
  if (!requestedPath) {
    response.status(400).json({ error: "File path is required." });
    return;
  }

  const filePath = path.resolve(requestedPath);
  if (!isOpenablePath(filePath)) {
    response.status(400).json({ error: "Path must be inside an open project or the built-in agent directory." });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile() && !info.isDirectory()) {
      response.status(400).json({ error: "Path must be a file or directory." });
      return;
    }
    await openWithDefaultApp(filePath);
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.use("/api/attachments", express.static(attachmentsDir));

app.post("/api/attachments", async (request, response) => {
  const name = typeof request.body?.name === "string" && request.body.name.trim() ? request.body.name.trim() : "attachment";
  const mimeType = typeof request.body?.mimeType === "string" ? request.body.mimeType : "";
  const dataUrl = typeof request.body?.dataUrl === "string" ? request.body.dataUrl : "";
  const match = dataUrl.match(/^data:([^;]+);base64,([\s\S]+)$/);

  if (!match || !mimeType || mimeType !== match[1]) {
    response.status(400).json({ error: "Attachment data is invalid." });
    return;
  }

  const mediaType =
    match[1] === "image/jpg"
      ? "image/jpeg"
      : match[1] === "application/octet-stream"
        ? mimeTypeForPath(name)
        : match[1];
  const data = Buffer.from(match[2], "base64");
  if (data.length > 10 * 1024 * 1024) {
    response.status(413).json({ error: "Attachment is larger than 10 MB." });
    return;
  }

  const ext = attachmentExtension(mediaType, name);
  const id = nanoid(12);
  const fileName = `${id}.${ext}`;
  const filePath = path.join(attachmentsDir, fileName);
  await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
  await chmod(attachmentsDir, 0o700).catch(() => undefined);
  await writeFile(filePath, data, { mode: 0o600 });
  await chmod(filePath, 0o600).catch(() => undefined);

  const attachment: MessageAttachment = {
    id,
    name,
    mimeType: mediaType,
    size: data.length,
    kind: mediaType.startsWith("image/") ? "image" : "file",
    path: filePath,
    url: `/api/attachments/${fileName}`
  };
  response.json(attachment);
});

app.get("/api/agents", (_request, response) => {
  response.json(runtime.listAgents());
});

app.get("/api/agents/:id/raw-stream", (request, response) => {
  response.type("text/plain").send(runtime.rawLines(request.params.id).join("\n"));
});

app.post("/api/permissions/request", async (request, response) => {
  const agentId = typeof request.body?.agentId === "string" ? request.body.agentId : "";
  const toolName = typeof request.body?.toolName === "string" ? request.body.toolName : "tool";
  const toolUseId = typeof request.body?.toolUseId === "string" ? request.body.toolUseId : "";
  const token = typeof request.body?.token === "string" ? request.body.token : undefined;
  if (!agentId || !toolUseId) {
    response.status(400).json({ error: "Permission request is missing an agent or tool use id." });
    return;
  }

  try {
    response.json(
      await runtime.requestPermission(agentId, {
        token,
        toolName,
        toolUseId,
        input: request.body?.input ?? {}
      })
    );
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/capabilities", (_request, response) => {
  response.json(capabilities);
});

app.get("/api/models/latest", async (request, response) => {
  try {
    const provider = typeof request.query.provider === "string" ? request.query.provider : "";
    if (provider === "claude" || provider === "codex" || provider === "openai") {
      response.json(await fetchPublishedProviderModels(provider));
      return;
    }
    response.json(await fetchPublishedModels());
  } catch (error) {
    response.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/admin/status", (_request, response) => {
  response.json({ supervised, pid: process.pid });
});

app.post("/api/admin/restart", async (_request, response) => {
  if (!supervised) {
    response.status(409).json({ error: "Restart requires starting AgentControl with npm run dev:supervised." });
    return;
  }
  await requestSupervisor("restart");
  response.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

app.post("/api/admin/shutdown", async (_request, response) => {
  if (supervised) await requestSupervisor("shutdown");
  response.json({ ok: true });
  setTimeout(() => process.exit(0), 300);
});

app.get("/api/settings", (_request, response) => {
  response.json({
    projectsRoot,
    projectPaths: config.projectPaths || [],
    models: resolveModels(config),
    modelProfiles: resolveModelProfiles(config),
    gitPath: config.gitPath || process.env.GIT_PATH || "git",
    claudePath: config.claudePath || process.env.CLAUDE_CODE_CLI || process.env.AGENTCONTROL_CLAUDE_PATH || "",
    claudeRuntime: resolveClaudeRuntime(config),
    codexPath: config.codexPath || process.env.CODEX_CLI || process.env.AGENTCONTROL_CODEX_PATH || "",
    claudeAgentDir: agentDirs.claude,
    codexAgentDir: agentDirs.codex,
    openaiAgentDir: agentDirs.openai,
    builtInAgentDir: agentDirs.builtIn,
    anthropicKeySaved: Boolean(secrets.anthropicApiKey),
    openaiKeySaved: Boolean(secrets.openaiApiKey),
    anthropicKeySource: process.env.ANTHROPIC_API_KEY ? (secrets.anthropicApiKey === process.env.ANTHROPIC_API_KEY ? "local" : "env") : "missing",
    openaiKeySource: process.env.OPENAI_API_KEY ? (secrets.openaiApiKey === process.env.OPENAI_API_KEY ? "local" : "env") : "missing",
    autoApprove: config.autoApprove || "off",
    permissionAllowRules: Array.isArray(config.permissionAllowRules) ? config.permissionAllowRules : [],
    defaultAgentMode: resolveDefaultAgentMode(config),
    tileHeight: resolveTileHeight(config),
    tileColumns: resolveTileColumns(config),
    menuDisplay: resolveMenuDisplay(config),
    sidebarWidth: resolveSidebarWidth(config),
    pinLastSentMessage: resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(config),
    themeMode: resolveThemeMode(config),
    capabilities
  });
});

app.get("/api/plugins", async (request, response) => {
  try {
    response.json(await listPlugins(requestPluginProvider(request.query.provider)));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/plugins/catalog", async (request, response) => {
  try {
    response.json(await pluginCatalog(requestPluginProvider(request.query.provider)));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/plugins/:plugin/enable", async (request, response) => {
  try {
    response.json(await enablePlugin(request.params.plugin, requestPluginProvider(request.query.provider)));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/plugins/install", async (request, response) => {
  const body = request.body as { plugin?: string; scope?: string; provider?: unknown };
  if (!body.plugin?.trim()) {
    response.status(400).json({ error: "Plugin is required." });
    return;
  }
  try {
    response.json(await installPlugin(body.plugin.trim(), body.scope, requestPluginProvider(body.provider)));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/plugins/marketplaces", async (request, response) => {
  const body = request.body as { source?: string; provider?: unknown };
  if (!body.source?.trim()) {
    response.status(400).json({ error: "Marketplace source is required." });
    return;
  }
  try {
    response.json(await addMarketplace(body.source.trim(), requestPluginProvider(body.provider)));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/settings", async (request, response) => {
  const body = request.body as DashboardConfig & { anthropicApiKey?: string; openaiApiKey?: string; clearAnthropicApiKey?: boolean; clearOpenaiApiKey?: boolean };
  if (typeof body.anthropicApiKey === "string" || typeof body.openaiApiKey === "string" || body.clearAnthropicApiKey || body.clearOpenaiApiKey) {
    secrets = await writeSecrets({
      anthropicApiKey: body.clearAnthropicApiKey ? undefined : body.anthropicApiKey?.trim() || secrets.anthropicApiKey,
      openaiApiKey: body.clearOpenaiApiKey ? undefined : body.openaiApiKey?.trim() || secrets.openaiApiKey
    });
    if (body.clearAnthropicApiKey) delete process.env.ANTHROPIC_API_KEY;
    if (body.clearOpenaiApiKey) delete process.env.OPENAI_API_KEY;
  }
  const requestedProjectPaths = Array.isArray(body.projectPaths) ? body.projectPaths : config.projectPaths;
  const openProjectPaths = projects.map((project) => project.path).filter(Boolean);
  const projectPaths = Array.from(new Set([...(requestedProjectPaths || []), ...openProjectPaths]));
  config = await writeConfig({
    projectsRoot: typeof body.projectsRoot === "string" ? body.projectsRoot : config.projectsRoot,
    projectPaths,
    models: Array.isArray(body.models) ? body.models : config.models,
    modelProfiles: Array.isArray(body.modelProfiles) ? body.modelProfiles : config.modelProfiles,
    gitPath: typeof body.gitPath === "string" ? body.gitPath.trim() : config.gitPath,
    claudePath: typeof body.claudePath === "string" ? body.claudePath.trim() : config.claudePath,
    claudeRuntime: resolveClaudeRuntime(body.claudeRuntime ? body : config),
    codexPath: typeof body.codexPath === "string" ? body.codexPath.trim() : config.codexPath,
    claudeAgentDir: typeof body.claudeAgentDir === "string" ? body.claudeAgentDir.trim() : config.claudeAgentDir,
    codexAgentDir: typeof body.codexAgentDir === "string" ? body.codexAgentDir.trim() : config.codexAgentDir,
    openaiAgentDir: typeof body.openaiAgentDir === "string" ? body.openaiAgentDir.trim() : config.openaiAgentDir,
    builtInAgentDir: typeof body.builtInAgentDir === "string" ? body.builtInAgentDir.trim() : config.builtInAgentDir,
    autoApprove: body.autoApprove || config.autoApprove,
    permissionAllowRules: Array.isArray(body.permissionAllowRules) ? body.permissionAllowRules : config.permissionAllowRules,
    defaultAgentMode: resolveDefaultAgentMode(body.defaultAgentMode ? body : config),
    tileHeight: typeof body.tileHeight === "number" ? resolveTileHeight(body) : resolveTileHeight(config),
    tileColumns: typeof body.tileColumns === "number" ? resolveTileColumns(body) : resolveTileColumns(config),
    menuDisplay: resolveMenuDisplay(body.menuDisplay ? body : config),
    sidebarWidth: typeof body.sidebarWidth === "number" ? resolveSidebarWidth(body) : resolveSidebarWidth(config),
    pinLastSentMessage: typeof body.pinLastSentMessage === "boolean" ? body.pinLastSentMessage : resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(body.terminalDock ? body : config),
    themeMode: resolveThemeMode(body.themeMode ? body : config)
  });
  if (config.claudePath) process.env.AGENTCONTROL_CLAUDE_PATH = config.claudePath;
  else delete process.env.AGENTCONTROL_CLAUDE_PATH;
  if (config.codexPath) process.env.AGENTCONTROL_CODEX_PATH = config.codexPath;
  else delete process.env.AGENTCONTROL_CODEX_PATH;
  if (config.gitPath) process.env.GIT_PATH = config.gitPath;
  agentDirs = resolveAgentDirs(config);
  if (!process.env.ANTHROPIC_API_KEY || secrets.anthropicApiKey) {
    if (secrets.anthropicApiKey) process.env.ANTHROPIC_API_KEY = secrets.anthropicApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
  }
  if (!process.env.OPENAI_API_KEY || secrets.openaiApiKey) {
    if (secrets.openaiApiKey) process.env.OPENAI_API_KEY = secrets.openaiApiKey;
    else delete process.env.OPENAI_API_KEY;
  }
  capabilities = await detectCapabilities();
  projectsRoot = resolveProjectsRoot(config);
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths, agentDirs) : [];
  response.json({
    projectsRoot,
    projectPaths: config.projectPaths || [],
    models: resolveModels(config),
    modelProfiles: resolveModelProfiles(config),
    gitPath: config.gitPath || process.env.GIT_PATH || "git",
    claudePath: config.claudePath || process.env.CLAUDE_CODE_CLI || process.env.AGENTCONTROL_CLAUDE_PATH || "",
    claudeRuntime: resolveClaudeRuntime(config),
    codexPath: config.codexPath || process.env.CODEX_CLI || process.env.AGENTCONTROL_CODEX_PATH || "",
    claudeAgentDir: agentDirs.claude,
    codexAgentDir: agentDirs.codex,
    openaiAgentDir: agentDirs.openai,
    builtInAgentDir: agentDirs.builtIn,
    anthropicKeySaved: Boolean(secrets.anthropicApiKey),
    openaiKeySaved: Boolean(secrets.openaiApiKey),
    anthropicKeySource: process.env.ANTHROPIC_API_KEY ? (secrets.anthropicApiKey === process.env.ANTHROPIC_API_KEY ? "local" : "env") : "missing",
    openaiKeySource: process.env.OPENAI_API_KEY ? (secrets.openaiApiKey === process.env.OPENAI_API_KEY ? "local" : "env") : "missing",
    autoApprove: config.autoApprove || "off",
    permissionAllowRules: Array.isArray(config.permissionAllowRules) ? config.permissionAllowRules : [],
    defaultAgentMode: resolveDefaultAgentMode(config),
    tileHeight: resolveTileHeight(config),
    tileColumns: resolveTileColumns(config),
    menuDisplay: resolveMenuDisplay(config),
    sidebarWidth: resolveSidebarWidth(config),
    pinLastSentMessage: resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(config),
    themeMode: resolveThemeMode(config),
    capabilities
  });
});

const distPath = path.resolve(__dirname, "../../web/dist");
app.use(express.static(distPath));
app.get("*", (request, response, next) => {
  if (request.path.startsWith("/api/")) {
    next();
    return;
  }
  response.sendFile(path.join(distPath, "index.html"), (error) => {
    if (error) next();
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  if (!isAuthenticatedWebSocket(request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", (ws) => {
  clients.add(ws);
  send(ws, { type: "agent.snapshot", snapshot: runtime.snapshot() });
  send(ws, { type: "terminal.snapshot", snapshot: terminals.snapshot() });

  ws.on("message", (raw) => {
    let command: WsClientCommand;
    try {
      command = JSON.parse(raw.toString()) as WsClientCommand;
    } catch {
      send(ws, { type: "agent.error", message: "Invalid WebSocket command." });
      return;
    }

    try {
      switch (command.type) {
        case "snapshot":
          send(ws, { type: "agent.snapshot", snapshot: runtime.snapshot() });
          send(ws, { type: "terminal.snapshot", snapshot: terminals.snapshot() });
          break;
        case "launch":
          void (async () => {
            await ensureLaunchPluginsEnabled(command.request);
            await runtime.launch(command.request);
          })().catch((error: unknown) => {
            send(ws, { type: "agent.error", message: error instanceof Error ? error.message : String(error) });
          });
          break;
        case "userMessage":
          runtime.userMessage(command.id, command.text, undefined, command.attachments);
          break;
        case "kill":
          runtime.kill(command.id);
          break;
        case "interrupt":
          runtime.interrupt(command.id);
          break;
        case "setModel":
          runtime.setModel(command.id, command.model);
          break;
        case "setPlanMode":
          runtime.setPlanMode(command.id, command.planMode);
          break;
        case "setPermissionMode":
          runtime.setPermissionMode(command.id, command.permissionMode);
          break;
        case "setEffort":
          runtime.setEffort(command.id, command.effort);
          break;
        case "setThinking":
          runtime.setThinking(command.id, command.thinking);
          break;
        case "nativeStatus":
          runtime.nativeStatus(command.id);
          break;
        case "enablePlugin":
          void enablePlugin(command.plugin).catch((error: unknown) => {
            send(ws, { type: "agent.error", message: error instanceof Error ? error.message : String(error) });
          });
          break;
        case "sendTo":
          runtime.sendTo(command.command);
          break;
        case "permission":
          runtime.permission(command.id, command.toolUseId, command.decision);
          break;
        case "answerQuestions":
          runtime.answerQuestions(command.id, command.eventId, command.answers);
          break;
        case "answerPlan":
          runtime.answerPlan(command.id, command.eventId, command.decision, command.response);
          break;
        case "clear":
          runtime.clear(command.id);
          break;
        case "clearAll":
          runtime.clearAll(command.projectId);
          break;
        case "resume":
          runtime.resume(command.id);
          break;
        case "restart":
          runtime.restart(command.id);
          break;
        case "terminalStart":
          terminals.start(command.projectId, undefined, undefined, command.command, command.title);
          break;
        case "terminalInput":
          terminals.input(command.id, command.input);
          break;
        case "terminalResize":
          terminals.resize(command.id, command.cols, command.rows);
          break;
        case "terminalKill":
          terminals.kill(command.id);
          break;
        case "terminalClear":
          terminals.clear(command.id);
          break;
        case "terminalClose":
          terminals.close(command.id);
          break;
        case "terminalRename":
          terminals.rename(command.id, command.title);
          break;
      }
    } catch (error) {
      send(ws, {
        type: "agent.error",
        message: error instanceof Error ? error.message : String(error)
      });
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
  });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(`AgentControl web app available at http://${displayHost}:${PORT}`);
  console.log(`AgentControl API/WebSocket server listening on http://${HOST}:${PORT}`);
  console.log("AgentControl API/WebSocket authentication is enabled.");
  console.log(`Configured projects=${config.projectPaths?.length || 0}`);
});
