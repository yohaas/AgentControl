import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { appendFile, chmod, cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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
  AgentSnapshot,
  AppUpdateAsset,
  AppUpdateStatus,
  AppVersionMetadata,
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
  ProjectDiffResponse,
  ProjectFileEntry,
  ProjectFileResponse,
  ProjectPathInfo,
  ProjectTreeEntry,
  ProjectTreeResponse,
  QueuedMessage,
  WsClientCommand,
  WsServerEvent
} from "@agent-hero/shared";
import { detectCapabilities } from "./capabilities.js";
import {
  expandHome,
  readConfig,
  readSecrets,
  resolveAgentHeroProjectPath,
  resolveChatFontFamily,
  resolveChatFontSize,
  resolveChatTranscriptDetail,
  resolveClaudeRuntime,
  resolveDefaultAgentMode,
  resolveAgentDirs,
  resolveExternalEditor,
  resolveFileExplorerDock,
  resolveGitFetchIntervalMinutes,
  resolveInputNotificationsEnabled,
  resolveInstallMode,
  resolveModelProfiles,
  resolveModels,
  resolveMenuDisplay,
  resolvePinLastSentMessage,
  resolveProjectsRoot,
  resolveSidebarWidth,
  resolveTerminalDock,
  resolveThemeMode,
  resolveTileScrolling,
  resolveTileColumns,
  resolveTileHeight,
  resolveUpdateChecksEnabled,
  resolveUpdateCommands,
  resolveUpdateManifestUrl,
  writeConfig,
  writeSecrets
} from "./config.js";
import { addMarketplace, enablePlugin, installPlugin, listPlugins, normalizePluginProvider, pluginCatalog, supportsPluginProvider } from "./plugins.js";
import { AgentRuntimeManager } from "./runtime.js";
import { deleteBuiltInAgent, scanConfiguredProjects, scanProject, updateAgentPlugins, updateAgentPluginsFile, upsertBuiltInAgent } from "./scanner.js";
import { STATE_DIR, migrateLegacyStateDir, statePath } from "./storage.js";
import { TerminalManager } from "./terminal.js";
import { canonicalWslProjectKey, isWslProject, normalizeWslPath, parseWslUncPath, wslCommandArgs, wslProjectPath, wslUncPath } from "./wsl.js";

const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "../..");
const attachmentsDir = statePath("attachments");
const controlDir = STATE_DIR;
const controlPath = path.join(controlDir, "control.json");
const openPathLogPath = path.join(controlDir, "open-path.log");
const supervised = process.env.AGENT_HERO_SUPERVISED === "1" || process.env.AGENT_CONTROL_SUPERVISED === "1";
const ignoredContextDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage"]);
const authCookieName = "agent_hero_token";
const legacyAuthCookieName = "agent_control_token";
const anthropicModelsApiUrl = "https://api.anthropic.com/v1/models";
const anthropicModelsDocUrl = "https://docs.anthropic.com/en/docs/about-claude/models/overview";
const anthropicOpus47NewsUrl = "https://www.anthropic.com/news/claude-opus-4-7";
const openAiModelsDocUrl = "https://developers.openai.com/api/docs/models";
const codexModelsDocUrl = "https://developers.openai.com/codex/models";
const fallbackClaudeModelIds = ["claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];

await migrateLegacyStateDir();
let config = await readConfig();
let secrets = await readSecrets();
if (config.claudePath) process.env.AGENTHERO_CLAUDE_PATH = config.claudePath;
if (config.codexPath) process.env.AGENTHERO_CODEX_PATH = config.codexPath;
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
let messageQueues: Record<string, QueuedMessage[]> = {};

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function configuredAllowedOrigins(): string[] {
  return (process.env.AGENTHERO_ALLOWED_ORIGINS || process.env.AGENTCONTROL_ALLOWED_ORIGINS || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustedDefaultOrigins(): string[] {
  const serverPort = String(PORT);
  const devPort = process.env.AGENTHERO_WEB_PORT || process.env.AGENTCONTROL_WEB_PORT || "4318";
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
      "User-Agent": "AgentHero model updater",
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
      "User-Agent": "AgentHero model updater"
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

function originMatchesRequestHost(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    const requestHost = host.split(",")[0]?.trim().toLowerCase();
    return Boolean(requestHost) && parsed.host.toLowerCase() === requestHost;
  } catch {
    return false;
  }
}

function requestRefererOrigin(request: express.Request): string | undefined {
  const referer = request.header("referer");
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

function isAllowedOrigin(origin: string | undefined, requestHost?: string): boolean {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    if (originMatchesRequestHost(parsed.origin, requestHost)) return true;
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
  const header = request.header("x-agent-hero-token") || request.header("x-agent-control-token");
  if (header) return header;
  const authorization = request.header("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  const cookies = parseCookies(request.header("cookie"));
  return cookies[authCookieName] || cookies[legacyAuthCookieName];
}

function configuredAccessToken(): string | undefined {
  return process.env.AGENTHERO_ACCESS_TOKEN || process.env.AGENTHERO_AUTH_TOKEN || process.env.AGENTCONTROL_ACCESS_TOKEN || process.env.AGENTCONTROL_AUTH_TOKEN || secrets.accessToken;
}

function accessTokenEnabled(): boolean {
  return config.accessTokenEnabled === true;
}

function accessTokenConfigured(): boolean {
  return Boolean(configuredAccessToken());
}

function tokensEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthenticatedRequest(request: express.Request): boolean {
  if (!accessTokenEnabled()) return isAllowedOrigin(request.header("origin"), request.header("host"));
  return isAllowedOrigin(request.header("origin"), request.header("host")) && tokensEqual(requestToken(request), configuredAccessToken());
}

function isAuthExemptApiPath(pathname: string): boolean {
  return (
    pathname === "/api/health" ||
    pathname === "/api/auth/status" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/logout" ||
    pathname === "/api/auth/setup" ||
    pathname === "/api/permissions/request"
  );
}

function canIssueToken(request: express.Request): boolean {
  const origin = request.header("origin") || requestRefererOrigin(request);
  if (origin) return isAllowedOrigin(origin, request.header("host"));
  return isLoopbackAddress(request.socket.remoteAddress);
}

function webSocketToken(request: http.IncomingMessage): string | undefined {
  const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const queryToken = requestUrl.searchParams.get("token");
  if (queryToken) return queryToken;
  const header = request.headers["x-agent-hero-token"] || request.headers["x-agent-control-token"];
  if (typeof header === "string") return header;
  const authorization = request.headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  const cookies = parseCookies(request.headers.cookie);
  return cookies[authCookieName] || cookies[legacyAuthCookieName];
}

function isAuthenticatedWebSocket(request: http.IncomingMessage): boolean {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  const host = typeof request.headers.host === "string" ? request.headers.host : undefined;
  if (!accessTokenEnabled()) return isAllowedOrigin(origin, host);
  return isAllowedOrigin(origin, host) && tokensEqual(webSocketToken(request), configuredAccessToken());
}

function setAuthCookie(response: express.Response, token: string): void {
  response.cookie(authCookieName, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    path: "/"
  });
}

function clearAuthCookie(response: express.Response): void {
  response.clearCookie(authCookieName, {
    sameSite: "strict",
    secure: false,
    path: "/"
  });
  response.clearCookie(legacyAuthCookieName, {
    sameSite: "strict",
    secure: false,
    path: "/"
  });
}

function authStatus(request: express.Request) {
  const enabled = accessTokenEnabled();
  const configured = accessTokenConfigured();
  return {
    accessTokenEnabled: enabled,
    accessTokenConfigured: configured,
    authenticated: !enabled || (configured && isAuthenticatedRequest(request)),
    setupRequired: enabled && !configured
  };
}

function send(ws: WebSocket, event: WsServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function broadcast(event: WsServerEvent): void {
  for (const client of clients) send(client, event);
}

function normalizeQueuedMessage(value: unknown): QueuedMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as Partial<QueuedMessage>;
  if (typeof message.id !== "string" || typeof message.text !== "string") return undefined;
  return {
    id: message.id,
    text: message.text,
    attachments: Array.isArray(message.attachments) ? (message.attachments as MessageAttachment[]) : []
  };
}

function normalizeMessageQueues(value: unknown): Record<string, QueuedMessage[]> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([agentId, queue]) => [
        agentId,
        Array.isArray(queue) ? queue.map(normalizeQueuedMessage).filter((message): message is QueuedMessage => Boolean(message)) : []
      ])
      .filter(([, queue]) => queue.length > 0)
  );
}

function pruneMessageQueuesForAgents(queues: Record<string, QueuedMessage[]>, agents: { id: string }[]): Record<string, QueuedMessage[]> {
  const agentIds = new Set(agents.map((agent) => agent.id));
  return Object.fromEntries(Object.entries(queues).filter(([agentId]) => agentIds.has(agentId)));
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
  const wslKey = canonicalWslProjectKey(projectPath);
  if (wslKey) return wslKey;
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
        modifiedAt: info.mtime.toISOString(),
        ...pathInfoForProject(project, relativePath)
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

function projectRootPath(project: Project): string {
  return path.resolve(project.path);
}

function projectRuntimeRoot(project: Project): string {
  return isWslProject(project) ? wslProjectPath(project) : project.path;
}

function projectHostRoot(project: Project): string {
  return isWslProject(project) ? wslUncPath(project.wslDistro || parseWslUncPath(project.path)?.distro || "Ubuntu", wslProjectPath(project)) : project.path;
}

function normalizeProjectRelativePath(input: unknown): string {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value || value === "." || value === "/") return "";
  return path.posix.normalize(value.replace(/\\/g, "/")).replace(/^\/+/, "");
}

function projectAbsolutePath(project: Project, relativePath: string): string {
  return path.resolve(projectRootPath(project), relativePath);
}

function assertProjectPath(project: Project, input: unknown): { relativePath: string; absolutePath: string } {
  const relativePath = normalizeProjectRelativePath(input);
  const absolutePath = projectAbsolutePath(project, relativePath);
  if (!pathInsideOrEqual(projectRootPath(project), absolutePath)) throw new Error("Path must be inside the project.");
  return { relativePath, absolutePath };
}

function pathInfoForProject(project: Project, relativePath: string): ProjectPathInfo {
  const normalizedRelative = normalizeProjectRelativePath(relativePath);
  const runtimeRoot = projectRuntimeRoot(project);
  const hostRoot = projectHostRoot(project);
  return {
    displayPath: normalizedRelative || ".",
    runtimePath: isWslProject(project) ? path.posix.join(runtimeRoot, normalizedRelative) : projectAbsolutePath(project, normalizedRelative),
    hostOpenPath: isWslProject(project) ? path.win32.join(hostRoot, normalizedRelative.replace(/\//g, "\\")) : projectAbsolutePath(project, normalizedRelative)
  };
}

function looksBinary(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.3;
}

async function projectTree(project: Project, input: unknown): Promise<ProjectTreeResponse> {
  const { relativePath, absolutePath } = assertProjectPath(project, input);
  const info = await stat(absolutePath);
  if (!info.isDirectory()) throw new Error("Tree path must be a directory.");
  const entries = await readdir(absolutePath, { withFileTypes: true });
  const treeEntries: ProjectTreeEntry[] = [];
  for (const entry of entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  })) {
    const childRelative = path.posix.join(relativePath, entry.name);
    const childAbsolute = path.join(absolutePath, entry.name);
    const childInfo = await stat(childAbsolute).catch(() => undefined);
    if (!entry.isDirectory() && !entry.isFile()) continue;
    treeEntries.push({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      relativePath: childRelative,
      size: childInfo?.isFile() ? childInfo.size : undefined,
      modifiedAt: childInfo?.mtime.toISOString(),
      ...pathInfoForProject(project, childRelative)
    });
  }
  return {
    relativePath,
    ...pathInfoForProject(project, relativePath),
    entries: treeEntries
  };
}

async function projectFile(project: Project, input: unknown, full = false): Promise<ProjectFileResponse> {
  const { relativePath, absolutePath } = assertProjectPath(project, input);
  const info = await stat(absolutePath);
  if (!info.isFile()) throw new Error("Preview path must be a file.");
  const maxBytes = full ? 1024 * 1024 : 256 * 1024;
  const buffer = await readFile(absolutePath);
  const binary = looksBinary(buffer);
  const truncated = !binary && buffer.length > maxBytes;
  return {
    relativePath,
    name: path.basename(absolutePath),
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    mimeType: mimeTypeForPath(absolutePath),
    binary,
    truncated,
    content: binary ? undefined : buffer.subarray(0, maxBytes).toString("utf8"),
    ...pathInfoForProject(project, relativePath)
  };
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

function parseGitUnpushedCommits(output: string): GitStatus["unpushedCommits"] {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, authorName, committedAt] = line.split("\x1f");
      return {
        hash,
        subject,
        authorName,
        committedAt
      };
    })
    .filter((commit) => commit.hash && commit.subject);
}

function parseGithubRemote(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  const sshMatch = trimmed.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (sshMatch) return sshMatch[1];
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    const repo = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
    return repo.split("/").length >= 2 ? repo.split("/").slice(0, 2).join("/") : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLatestGithubRelease(repo: string): Promise<AppUpdateStatus["latestRelease"] | undefined> {
  const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "AgentHero update checker"
    }
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GitHub releases returned ${response.status}.`);
  const body = (await response.json()) as { name?: string; tag_name?: string; html_url?: string; published_at?: string };
  if (!body.tag_name) return undefined;
  return {
    name: body.name,
    tagName: body.tag_name,
    htmlUrl: body.html_url,
    publishedAt: body.published_at
  };
}

interface AppUpdateManifest {
  version?: string;
  releaseTag?: string;
  commitSha?: string;
  platform?: string;
  arch?: string;
  builtAt?: string;
  latest?: AppVersionMetadata;
  releaseNotesUrl?: string;
  assets?: AppUpdateAsset[];
}

function normalizeUpdatePlatform(platform = process.platform): string {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  return platform;
}

function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.replace(/^v/i, "").split(/[.-]/).map((part) => Number(part) || 0);
  const rightParts = right.replace(/^v/i, "").split(/[.-]/).map((part) => Number(part) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function installedReleaseAvailable(localVersion: AppVersionMetadata | undefined, latestVersion: AppVersionMetadata | undefined): boolean {
  if (!latestVersion) return false;
  if (!localVersion) return true;
  if (latestVersion.version && localVersion.version) {
    const versionDelta = compareVersionStrings(latestVersion.version, localVersion.version);
    return versionDelta > 0;
  }
  if (latestVersion.releaseTag && localVersion.releaseTag && latestVersion.releaseTag !== localVersion.releaseTag) return true;
  if (latestVersion.commitSha && localVersion.commitSha && latestVersion.commitSha !== localVersion.commitSha) return true;
  return false;
}

function manifestIsOlderThanLocal(localVersion: AppVersionMetadata | undefined, latestVersion: AppVersionMetadata | undefined): boolean {
  if (!latestVersion?.version || !localVersion?.version) return false;
  return compareVersionStrings(latestVersion.version, localVersion.version) < 0;
}

function manifestVersion(manifest: AppUpdateManifest): AppVersionMetadata | undefined {
  if (manifest.latest?.version) return manifest.latest;
  if (!manifest.version) return undefined;
  return {
    version: manifest.version,
    releaseTag: manifest.releaseTag,
    commitSha: manifest.commitSha,
    platform: manifest.platform,
    arch: manifest.arch,
    builtAt: manifest.builtAt
  };
}

async function readLocalVersionMetadata(): Promise<AppVersionMetadata | undefined> {
  const roots = Array.from(new Set([appRoot, process.cwd()]));
  for (const root of roots) {
    const rawVersion = await readFile(path.join(root, "version.json"), "utf8").catch(() => "");
    if (rawVersion.trim()) {
      try {
        const parsed = JSON.parse(rawVersion.replace(/^\uFEFF/, "")) as AppVersionMetadata;
        if (parsed.version) return parsed;
      } catch {
        // Continue to package.json. Older Windows bundles may have written version.json with an encoding marker.
      }
    }
  }

  for (const root of roots) {
    const rawPackage = await readFile(path.join(root, "package.json"), "utf8").catch(() => "");
    if (!rawPackage.trim()) continue;
    try {
      const parsedPackage = JSON.parse(rawPackage.replace(/^\uFEFF/, "")) as { version?: string };
      if (parsedPackage.version) return { version: parsedPackage.version };
    } catch {
      continue;
    }
  }

  return undefined;
}

async function fetchUpdateManifest(manifestUrl: string): Promise<AppUpdateManifest> {
  const response = await fetch(manifestUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "AgentHero update checker"
    }
  });
  if (!response.ok) throw new Error(`Update manifest returned ${response.status}.`);
  return (await response.json()) as AppUpdateManifest;
}

function assetMatchesRuntime(asset: AppUpdateAsset): boolean {
  const expectedPlatform = normalizeUpdatePlatform();
  const expectedArch = process.arch;
  const platform = asset.platform.toLowerCase();
  const arch = asset.arch?.toLowerCase();
  return (platform === "any" || platform === expectedPlatform) && (!arch || arch === "any" || arch === expectedArch);
}

function assetVersion(asset: AppUpdateAsset, latestVersion: AppVersionMetadata | undefined): string | undefined {
  return asset.version || latestVersion?.version;
}

function selectUpdateAsset(
  assets: AppUpdateAsset[] | undefined,
  localVersion: AppVersionMetadata | undefined,
  latestVersion: AppVersionMetadata | undefined
): AppUpdateAsset | undefined {
  const matchingAssets = (assets || []).filter(assetMatchesRuntime);
  const targetVersion = latestVersion?.version;
  const patchAsset = localVersion?.version
    ? matchingAssets.find((asset) => {
        const type = asset.type || "full";
        return (
          type === "patch" &&
          asset.fromVersion === localVersion.version &&
          (!targetVersion || assetVersion(asset, latestVersion) === targetVersion)
        );
      })
    : undefined;
  if (patchAsset) return patchAsset;
  return matchingAssets.find((asset) => {
    const type = asset.type || "full";
    return type === "full" && (!targetVersion || !asset.version || asset.version === targetVersion);
  });
}

async function gitRefExists(target: string, ref: string): Promise<boolean> {
  return gitCommand(target, ["rev-parse", "--verify", "--quiet", ref])
    .then(() => true)
    .catch(() => false);
}

async function gitRefIsAncestor(target: string, ancestor: string, descendant: string): Promise<boolean> {
  return gitCommand(target, ["merge-base", "--is-ancestor", ancestor, descendant])
    .then(() => true)
    .catch(() => false);
}

async function appUpdateStatus(): Promise<AppUpdateStatus> {
  const checkedAt = new Date().toISOString();
  const installMode = resolveInstallMode(config);
  const localVersion = await readLocalVersionMetadata().catch(() => undefined);

  if (installMode === "installed") {
    const manifestUrl = resolveUpdateManifestUrl(config);
    if (!manifestUrl) {
      return {
        installMode,
        isRepo: false,
        checkedAt,
        localVersion,
        releaseAvailable: false,
        updateAvailable: false,
        commits: [],
        message: "Add a release manifest URL in Settings before running installed updates."
      };
    }

    try {
      const manifest = await fetchUpdateManifest(manifestUrl);
      const latestVersion = manifestVersion(manifest);
      const updateAsset = selectUpdateAsset(manifest.assets, localVersion, latestVersion);
      const releaseAvailable = installedReleaseAvailable(localVersion, latestVersion);
      const manifestOlder = manifestIsOlderThanLocal(localVersion, latestVersion);
      return {
        installMode,
        isRepo: false,
        checkedAt,
        localVersion,
        latestVersion,
        updateAsset,
        releaseNotesUrl: manifest.releaseNotesUrl,
        releaseAvailable,
        updateAvailable: releaseAvailable && Boolean(updateAsset),
        commits: [],
        message: manifestOlder
          ? "Your installed version is newer than the update manifest."
          : updateAsset || !releaseAvailable
            ? undefined
            : !localVersion?.version
              ? "AgentHero could not read the installed version, so it cannot choose a patch update."
              : "A newer release exists, but this platform has no matching update asset."
      };
    } catch (error) {
      return {
        installMode,
        isRepo: false,
        checkedAt,
        localVersion,
        releaseAvailable: false,
        updateAvailable: false,
        commits: [],
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  try {
    const isRepo = (await gitCommand(appRoot, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
    if (!isRepo) {
      return { installMode, isRepo: false, checkedAt, localVersion, releaseAvailable: false, updateAvailable: false, commits: [], message: "AgentHero is not running from a Git repository." };
    }

    const remoteUrl = (await gitCommand(appRoot, ["remote", "get-url", "origin"])).trim();
    await gitCommand(appRoot, ["fetch", "--prune", "--tags", "origin"], 120000);
    const currentHash = (await gitCommand(appRoot, ["rev-parse", "--short", "HEAD"])).trim();
    const branch = (await gitCommand(appRoot, ["branch", "--show-current"])).trim() || undefined;
    const upstream = (await gitCommand(appRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).catch(() => "")).trim() || undefined;
    const compareRef = upstream || (branch ? `origin/${branch}` : undefined);
    const commits =
      compareRef && (await gitRefExists(appRoot, compareRef))
        ? parseGitUnpushedCommits(await gitCommand(appRoot, ["log", "--pretty=format:%h%x1f%s%x1f%an%x1f%cI", `HEAD..${compareRef}`])) || []
        : [];
    const githubRepo = parseGithubRemote(remoteUrl);
    const latestRelease = githubRepo ? await fetchLatestGithubRelease(githubRepo) : undefined;
    const releaseAvailable = latestRelease ? !(await gitRefIsAncestor(appRoot, latestRelease.tagName, "HEAD")) : false;
    return {
      installMode,
      isRepo: true,
      checkedAt,
      localVersion,
      currentHash,
      branch,
      upstream: compareRef,
      remoteUrl,
      githubRepo,
      latestRelease,
      releaseAvailable,
      updateAvailable: commits.length > 0 || releaseAvailable,
      commits
    };
  } catch (error) {
    return {
      installMode,
      isRepo: false,
      checkedAt,
      localVersion,
      releaseAvailable: false,
      updateAvailable: false,
      commits: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
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

function gitCredentialPromptMessage(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/terminal prompts (have been )?disabled|could not read Username|Authentication failed/i.test(message)) return undefined;
  return [
    "Git push needs credentials, but AgentHero cannot show interactive Git prompts.",
    "Configure Git credentials in a terminal, then retry push.",
    "For HTTPS remotes on Windows, use Git Credential Manager or run `gh auth login`; SSH remotes also work once your key is configured."
  ].join(" ");
}

function gitPullCredentialMessage(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/terminal prompts (have been )?disabled|could not read Username|Authentication failed/i.test(message)) return undefined;
  return [
    "Git pull needs credentials, but AgentHero cannot show interactive Git prompts.",
    "Configure Git credentials in a terminal, then retry pull.",
    "For HTTPS remotes on Windows, use Git Credential Manager or run `gh auth login`; SSH remotes also work once your key is configured."
  ].join(" ");
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

class WslCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number
  ) {
    super(message);
  }
}

function wslExecAt(distro: string, cwd: string, command: string, args: string[] = [], timeout = 15000): Promise<string> {
  const project = { path: wslUncPath(distro, cwd), wslDistro: distro, wslPath: cwd };
  return new Promise((resolve, reject) => {
    execFile("wsl.exe", wslCommandArgs(project, command, args), { timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const execError = error as Error & { code?: number | string | null };
        const exitCode = typeof execError.code === "number" ? execError.code : undefined;
        reject(new WslCommandError((stderr || error.message || "WSL command failed.").replace(/\0/g, "").trim(), exitCode));
        return;
      }
      resolve(stdout);
    });
  });
}

async function listWslDirectories(distro: string, linuxPath: string): Promise<DirectoryEntry[]> {
  const script = [
    'target="$1"',
    'if [ ! -d "$target" ]; then exit 64; fi',
    'find "$target" -mindepth 1 -maxdepth 1 -type d -printf "%f\\0"'
  ].join("\n");
  const output = await wslExecAt(distro, "/", "sh", ["-c", script, "sh", linuxPath]);
  return output
    .split("\0")
    .filter(Boolean)
    .map((name) => ({
      name,
      path: path.posix.join(linuxPath, name)
    }))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
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
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths, agentDirs, projects) : [];
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

function logOpenPath(message: string, level: "info" | "error" = "info"): void {
  const line = `[${new Date().toISOString()}] [open-path] ${message}`;
  if (level === "error") console.error(line);
  else console.info(line);
  void mkdir(controlDir, { recursive: true, mode: 0o700 })
    .then(() => appendFile(openPathLogPath, `${line}\n`, { encoding: "utf8", mode: 0o600 }))
    .catch((error: unknown) => console.error(`[open-path] failed to write log file: ${error instanceof Error ? error.message : String(error)}`));
}

function spawnDetached(command: string, args: string[]): Promise<void> {
  try {
    logOpenPath(`spawn detached command=${command} args=${JSON.stringify(args)}`);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });
    child.on("error", (error) => {
      logOpenPath(`detached spawn error command=${command}: ${error.message}`, "error");
    });
    child.unref();
    return Promise.resolve();
  } catch (error) {
    logOpenPath(`detached spawn threw command=${command}: ${error instanceof Error ? error.stack || error.message : String(error)}`, "error");
    return Promise.reject(error);
  }
}

function openWindowsFolder(folderPath: string): Promise<void> {
  logOpenPath(`spawning explorer.exe for folder: ${folderPath}`);
  return spawnDetached("explorer.exe", [folderPath]);
}

function openWindowsFileChooser(filePath: string): Promise<void> {
  logOpenPath(`spawning Open With dialog for file: ${filePath}`);
  return spawnDetached("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", filePath]);
}

function openWithDefaultApp(filePath: string, options: { file?: boolean; openWith?: boolean } = {}): Promise<void> {
  if (process.platform === "win32") {
    if (options.openWith) return openWindowsFileChooser(filePath);
    if (!options.file) {
      return openWindowsFolder(filePath);
    }
    return new Promise((resolve, reject) => {
      execFile("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "$target = $env:AGENTHERO_OPEN_PATH; if (-not $target) { $target = $env:AGENTCONTROL_OPEN_PATH }; if (-not $target) { throw 'Open path was not provided.' }; Invoke-Item -LiteralPath $target"
      ], {
        env: { ...process.env, AGENTHERO_OPEN_PATH: filePath, AGENTCONTROL_OPEN_PATH: filePath },
        windowsHide: true
      }, (error, _stdout, stderr) => {
        if (error) {
          openWindowsFileChooser(filePath).then(resolve).catch((openWithError: unknown) => {
            reject(
              new Error(
                stderr.trim() ||
                  error.message ||
                  (openWithError instanceof Error ? openWithError.message : String(openWithError)) ||
                  "Unable to open path."
              )
            );
          });
        } else {
          resolve();
        }
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
    const status = parseGitStatus(output);
    if (status.ahead > 0) {
      const commits = await gitCommand(project, ["log", "--pretty=format:%h%x1f%s%x1f%an%x1f%cI", "@{upstream}..HEAD"]).catch(() => "");
      status.unpushedCommits = parseGitUnpushedCommits(commits);
    }
    if (status.behind > 0) {
      const commits = await gitCommand(project, ["log", "--pretty=format:%h%x1f%s%x1f%an%x1f%cI", "HEAD..@{upstream}"]).catch(() => "");
      status.incomingCommits = parseGitUnpushedCommits(commits);
    }
    return status;
  } catch (error) {
    return {
      isRepo: false,
      ahead: 0,
      behind: 0,
      unpushedCommits: [],
      incomingCommits: [],
      files: [],
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

async function projectFileDiff(project: Project, input: unknown): Promise<ProjectDiffResponse> {
  const relativePath = normalizeProjectRelativePath(input);
  if (!relativePath) throw new Error("Diff file path is required.");
  const absolutePath = projectAbsolutePath(project, relativePath);
  if (!pathInsideOrEqual(projectRootPath(project), absolutePath)) throw new Error("Path must be inside the project.");
  const status = await projectGitStatus(project);
  if (!status.isRepo) throw new Error(status.message || "Project is not a Git repository.");
  const fileStatus = status.files.find((file) => file.path === relativePath || file.path.endsWith(` -> ${relativePath}`))?.status;
  const info = await stat(absolutePath).catch(() => undefined);
  const binary = info?.isFile() ? looksBinary(await readFile(absolutePath)) : false;
  if (fileStatus === "untracked") {
    const preview = info?.isFile() ? await projectFile(project, relativePath) : undefined;
    return {
      relativePath,
      status: fileStatus,
      binary: preview?.binary || false,
      content: preview?.content,
      ...pathInfoForProject(project, relativePath)
    };
  }
  const args = ["diff", "--", relativePath];
  let diff = await gitCommand(project, args, 15000).catch(() => "");
  if (!diff.trim()) diff = await gitCommand(project, ["diff", "--cached", "--", relativePath], 15000).catch(() => "");
  return {
    relativePath,
    status: fileStatus,
    binary,
    diff,
    ...pathInfoForProject(project, relativePath)
  };
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
    throw new Error("OpenAI API sessions do not support local AgentHero plugins.");
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

function agentSnapshot(): AgentSnapshot {
  const snapshot = runtime.snapshot();
  messageQueues = pruneMessageQueuesForAgents(messageQueues, snapshot.agents);
  return { ...snapshot, messageQueues };
}

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

app.get("/api/auth/status", (request, response) => {
  response.json(authStatus(request));
});

app.post("/api/auth/login", (request, response) => {
  if (!canIssueToken(request)) {
    response.status(403).json({ error: "Origin is not allowed." });
    return;
  }
  if (!accessTokenEnabled()) {
    clearAuthCookie(response);
    response.json(authStatus(request));
    return;
  }
  if (!accessTokenConfigured()) {
    response.status(409).json({ error: "Access token setup is required." });
    return;
  }
  const token = typeof request.body?.token === "string" ? request.body.token : "";
  if (!tokensEqual(token, configuredAccessToken())) {
    response.status(401).json({ error: "Access token is incorrect." });
    return;
  }
  setAuthCookie(response, token);
  response.json({ ...authStatus(request), authenticated: true });
});

app.post("/api/auth/logout", (_request, response) => {
  clearAuthCookie(response);
  response.json({ ok: true });
});

app.post("/api/auth/setup", async (request, response) => {
  if (!canIssueToken(request)) {
    response.status(403).json({ error: "Origin is not allowed." });
    return;
  }
  if (!accessTokenEnabled()) {
    response.status(409).json({ error: "Access tokens are not enabled." });
    return;
  }
  if (accessTokenConfigured()) {
    response.status(409).json({ error: "Access token is already configured." });
    return;
  }
  const token = typeof request.body?.token === "string" ? request.body.token.trim() : "";
  if (!token) {
    response.status(400).json({ error: "Access token is required." });
    return;
  }
  secrets = await writeSecrets({ ...secrets, accessToken: token });
  setAuthCookie(response, token);
  response.json({ ...authStatus(request), authenticated: true });
});

app.use((request, response, next) => {
  if (isAuthExemptApiPath(request.path)) {
    next();
    return;
  }
  if (!request.path.startsWith("/api/")) {
    next();
    return;
  }
  if (isAuthenticatedRequest(request)) {
    next();
    return;
  }
  response.status(401).json({ error: "AgentHero API authentication is required." });
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

app.get("/api/projects/:id/tree", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    response.json(await projectTree(project, request.query.path));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/projects/:id/file", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    response.json(await projectFile(project, request.query.path, request.query.full === "1"));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/projects/:id/diff", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }

  try {
    response.json(await projectFileDiff(project, request.query.path));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
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
  projects = await scanConfiguredProjects(projectPaths, agentDirs, projects);
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
  projects = await scanConfiguredProjects(projectPaths, agentDirs, projects);
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
      timeoutMessage: "Git push timed out. Git may be waiting for credentials or remote interaction that AgentHero cannot display."
    });
    response.json(await projectGitStatus(project));
  } catch (error) {
    response.status(500).json({ error: gitCredentialPromptMessage(error) || (error instanceof Error ? error.message : String(error)) });
  }
});

app.post("/api/projects/:id/git/fetch", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  try {
    await gitCommand(project, ["fetch"], 120000, {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMessage: "Git fetch timed out."
    });
    response.json({ ok: true });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/projects/:id/git/pull", async (request, response) => {
  const project = projectById(request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  try {
    await gitCommand(project, ["pull"], 120000, {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMessage: "Git pull timed out. Git may be waiting for credentials or remote interaction that AgentHero cannot display."
    });
    response.json(await projectGitStatus(project));
  } catch (error) {
    response.status(500).json({ error: gitPullCredentialMessage(error) || (error instanceof Error ? error.message : String(error)) });
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
    try {
      const directories = await listWslDirectories(distro, linuxPath);
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
      if (error instanceof WslCommandError && error.exitCode === 64) {
        response.status(400).json({ error: "Selected WSL path is not a directory." });
        return;
      }
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
  const requestedProjectId = typeof request.body?.projectId === "string" ? request.body.projectId : "";
  const requestedMode = typeof request.body?.mode === "string" ? request.body.mode : "path";
  logOpenPath(`request mode=${requestedMode} projectId=${requestedProjectId || "(none)"} path=${requestedPath || "(project root)"}`);
  if (!requestedPath && !requestedProjectId) {
    response.status(400).json({ error: "File path is required." });
    return;
  }

  const mode =
    request.body?.mode === "containingFolder" ? "containingFolder" : request.body?.mode === "openWith" ? "openWith" : "path";
  if (requestedProjectId) {
    const project = projectById(requestedProjectId);
    if (!project) {
      response.status(404).json({ error: "Project not found." });
      return;
    }
    try {
      const { relativePath } = assertProjectPath(project, requestedPath);
      const projectPath = pathInfoForProject(project, relativePath).hostOpenPath;
      const openPath = mode === "containingFolder" ? path.dirname(projectPath) : projectPath;
      logOpenPath(`resolved project=${project.name} relative=${relativePath || "."} host=${projectPath} open=${openPath}`);
      const info = await stat(openPath);
      logOpenPath(`stat file=${info.isFile()} directory=${info.isDirectory()} size=${info.size}`);
      if (!info.isFile() && !info.isDirectory()) {
        response.status(400).json({ error: "Path must be a file or directory." });
        return;
      }
      await openWithDefaultApp(openPath, { file: info.isFile(), openWith: mode === "openWith" });
      logOpenPath(`launched ok open=${openPath}`);
      response.json({ ok: true });
    } catch (error) {
      logOpenPath(`failed: ${error instanceof Error ? error.stack || error.message : String(error)}`, "error");
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  const filePath = path.resolve(requestedPath);
  const openPath = mode === "containingFolder" ? path.dirname(filePath) : filePath;
  logOpenPath(`resolved direct file=${filePath} open=${openPath}`);
  if (!isOpenablePath(openPath)) {
    response.status(400).json({ error: "Path must be inside an open project or the built-in agent directory." });
    return;
  }

  try {
    const info = await stat(openPath);
    logOpenPath(`stat file=${info.isFile()} directory=${info.isDirectory()} size=${info.size}`);
    if (!info.isFile() && !info.isDirectory()) {
      response.status(400).json({ error: "Path must be a file or directory." });
      return;
    }
    await openWithDefaultApp(openPath, { file: info.isFile(), openWith: mode === "openWith" });
    logOpenPath(`launched ok open=${openPath}`);
    response.json({ ok: true });
  } catch (error) {
    logOpenPath(`failed: ${error instanceof Error ? error.stack || error.message : String(error)}`, "error");
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

app.get("/api/agent-snapshot", (_request, response) => {
  response.json(agentSnapshot());
});

app.post("/api/agents/launch", async (request, response) => {
  try {
    const launchRequest = request.body as LaunchRequest;
    await ensureLaunchPluginsEnabled(launchRequest);
    const agent = await runtime.launch(launchRequest);
    response.json({ agent, snapshot: agentSnapshot() });
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/agents/:id/message", (request, response) => {
  const text = typeof request.body?.text === "string" ? request.body.text : "";
  const attachments = Array.isArray(request.body?.attachments) ? (request.body.attachments as MessageAttachment[]) : [];
  if (!text.trim() && attachments.length === 0) {
    response.status(400).json({ error: "Message text or attachments are required." });
    return;
  }
  runtime.userMessage(request.params.id, text, undefined, attachments);
  response.json({ ok: true });
});

app.post("/api/agents/:id/interrupt", (request, response) => {
  runtime.interrupt(request.params.id);
  response.json({ ok: true });
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
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Permission request token is invalid.") {
      response.status(401).json({ error: message });
      return;
    }
    if (message === "Agent not found.") {
      response.status(404).json({ error: message });
      return;
    }
    response.status(500).json({ error: message });
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

app.get("/api/admin/updates", async (_request, response) => {
  response.json(await appUpdateStatus());
});

app.post("/api/admin/restart", async (_request, response) => {
  if (!supervised) {
    response.status(409).json({ error: "Restart requires starting AgentHero with npm run dev:supervised." });
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
    gitFetchIntervalMinutes: resolveGitFetchIntervalMinutes(config),
    claudePath: config.claudePath || process.env.CLAUDE_CODE_CLI || process.env.AGENTHERO_CLAUDE_PATH || process.env.AGENTCONTROL_CLAUDE_PATH || "",
    claudeRuntime: resolveClaudeRuntime(config),
    codexPath: config.codexPath || process.env.CODEX_CLI || process.env.AGENTHERO_CODEX_PATH || process.env.AGENTCONTROL_CODEX_PATH || "",
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
    tileScrolling: resolveTileScrolling(config),
    chatTranscriptDetail: resolveChatTranscriptDetail(config),
    chatFontFamily: resolveChatFontFamily(config),
    chatFontSize: resolveChatFontSize(config),
    menuDisplay: resolveMenuDisplay(config),
    sidebarWidth: resolveSidebarWidth(config),
    pinLastSentMessage: resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(config),
    fileExplorerDock: resolveFileExplorerDock(config),
    themeMode: resolveThemeMode(config),
    agentControlProjectPath: resolveAgentHeroProjectPath(config),
    installMode: resolveInstallMode(config),
    updateChecksEnabled: resolveUpdateChecksEnabled(config),
    updateCommands: resolveUpdateCommands(config),
    updateManifestUrl: resolveUpdateManifestUrl(config) || "",
    inputNotificationsEnabled: resolveInputNotificationsEnabled(config),
    externalEditor: resolveExternalEditor(config),
    externalEditorUrlTemplate: config.externalEditorUrlTemplate || "",
    accessTokenEnabled: accessTokenEnabled(),
    accessTokenSaved: accessTokenConfigured(),
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
  const body = request.body as DashboardConfig & {
    anthropicApiKey?: string;
    openaiApiKey?: string;
    accessToken?: string;
    clearAnthropicApiKey?: boolean;
    clearOpenaiApiKey?: boolean;
  };
  if (
    typeof body.anthropicApiKey === "string" ||
    typeof body.openaiApiKey === "string" ||
    typeof body.accessToken === "string" ||
    body.clearAnthropicApiKey ||
    body.clearOpenaiApiKey
  ) {
    secrets = await writeSecrets({
      anthropicApiKey: body.clearAnthropicApiKey ? undefined : body.anthropicApiKey?.trim() || secrets.anthropicApiKey,
      openaiApiKey: body.clearOpenaiApiKey ? undefined : body.openaiApiKey?.trim() || secrets.openaiApiKey,
      accessToken: body.accessToken?.trim() || secrets.accessToken
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
    gitFetchIntervalMinutes:
      typeof body.gitFetchIntervalMinutes === "number" ? resolveGitFetchIntervalMinutes(body) : resolveGitFetchIntervalMinutes(config),
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
    tileScrolling: resolveTileScrolling(body.tileScrolling ? body : config),
    chatTranscriptDetail: resolveChatTranscriptDetail(body.chatTranscriptDetail ? body : config),
    chatFontFamily: typeof body.chatFontFamily === "string" ? resolveChatFontFamily(body) : resolveChatFontFamily(config),
    chatFontSize: typeof body.chatFontSize === "number" ? resolveChatFontSize(body) : resolveChatFontSize(config),
    menuDisplay: resolveMenuDisplay(body.menuDisplay ? body : config),
    sidebarWidth: typeof body.sidebarWidth === "number" ? resolveSidebarWidth(body) : resolveSidebarWidth(config),
    pinLastSentMessage: typeof body.pinLastSentMessage === "boolean" ? body.pinLastSentMessage : resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(body.terminalDock ? body : config),
    fileExplorerDock: resolveFileExplorerDock(body.fileExplorerDock ? body : config),
    themeMode: resolveThemeMode(body.themeMode ? body : config),
    agentControlProjectPath:
      typeof body.agentControlProjectPath === "string" ? body.agentControlProjectPath.trim() : resolveAgentHeroProjectPath(config),
    installMode: body.installMode === "installed" || body.installMode === "checkout" ? body.installMode : resolveInstallMode(config),
    updateChecksEnabled: typeof body.updateChecksEnabled === "boolean" ? body.updateChecksEnabled : resolveUpdateChecksEnabled(config),
    updateCommands: Array.isArray(body.updateCommands) ? body.updateCommands.map((command) => command.trim()).filter(Boolean) : config.updateCommands,
    updateManifestUrl: typeof body.updateManifestUrl === "string" ? body.updateManifestUrl.trim() : resolveUpdateManifestUrl(config),
    inputNotificationsEnabled:
      typeof body.inputNotificationsEnabled === "boolean" ? body.inputNotificationsEnabled : resolveInputNotificationsEnabled(config),
    externalEditor: resolveExternalEditor(body.externalEditor ? body : config),
    externalEditorUrlTemplate:
      typeof body.externalEditorUrlTemplate === "string" ? body.externalEditorUrlTemplate.trim() : config.externalEditorUrlTemplate,
    accessTokenEnabled: typeof body.accessTokenEnabled === "boolean" ? body.accessTokenEnabled : config.accessTokenEnabled
  });
  if (config.claudePath) process.env.AGENTHERO_CLAUDE_PATH = config.claudePath;
  else delete process.env.AGENTHERO_CLAUDE_PATH;
  if (config.codexPath) process.env.AGENTHERO_CODEX_PATH = config.codexPath;
  else delete process.env.AGENTHERO_CODEX_PATH;
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
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths, agentDirs, projects) : [];
  response.json({
    projectsRoot,
    projectPaths: config.projectPaths || [],
    models: resolveModels(config),
    modelProfiles: resolveModelProfiles(config),
    gitPath: config.gitPath || process.env.GIT_PATH || "git",
    gitFetchIntervalMinutes: resolveGitFetchIntervalMinutes(config),
    claudePath: config.claudePath || process.env.CLAUDE_CODE_CLI || process.env.AGENTHERO_CLAUDE_PATH || process.env.AGENTCONTROL_CLAUDE_PATH || "",
    claudeRuntime: resolveClaudeRuntime(config),
    codexPath: config.codexPath || process.env.CODEX_CLI || process.env.AGENTHERO_CODEX_PATH || process.env.AGENTCONTROL_CODEX_PATH || "",
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
    tileScrolling: resolveTileScrolling(config),
    chatTranscriptDetail: resolveChatTranscriptDetail(config),
    chatFontFamily: resolveChatFontFamily(config),
    chatFontSize: resolveChatFontSize(config),
    menuDisplay: resolveMenuDisplay(config),
    sidebarWidth: resolveSidebarWidth(config),
    pinLastSentMessage: resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(config),
    fileExplorerDock: resolveFileExplorerDock(config),
    themeMode: resolveThemeMode(config),
    agentControlProjectPath: resolveAgentHeroProjectPath(config),
    installMode: resolveInstallMode(config),
    updateChecksEnabled: resolveUpdateChecksEnabled(config),
    updateCommands: resolveUpdateCommands(config),
    updateManifestUrl: resolveUpdateManifestUrl(config) || "",
    inputNotificationsEnabled: resolveInputNotificationsEnabled(config),
    externalEditor: resolveExternalEditor(config),
    externalEditorUrlTemplate: config.externalEditorUrlTemplate || "",
    accessTokenEnabled: accessTokenEnabled(),
    accessTokenSaved: accessTokenConfigured(),
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
  send(ws, { type: "agent.snapshot", snapshot: agentSnapshot() });
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
          send(ws, { type: "agent.snapshot", snapshot: agentSnapshot() });
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
        case "injectMessage":
          runtime.injectMessage(command.id, command.text, command.attachments);
          break;
        case "messageQueues":
          messageQueues = pruneMessageQueuesForAgents(normalizeMessageQueues(command.messageQueues), runtime.listAgents());
          broadcast({ type: "agent.message_queues", messageQueues });
          break;
        case "kill":
          runtime.kill(command.id);
          break;
        case "rename":
          runtime.rename(command.id, command.displayName);
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
        case "saveChat":
          runtime.saveChat(command.id);
          break;
        case "restoreSavedChat":
          runtime.restoreSavedChat(command.savedChatId);
          break;
        case "deleteSavedChat":
          runtime.deleteSavedChat(command.savedChatId);
          break;
        case "forkChat":
          runtime.forkChat(command.id);
          break;
        case "resume":
          runtime.resume(command.id);
          break;
        case "restart":
          runtime.restart(command.id);
          break;
        case "terminalStart":
          terminals.start(command.projectId, undefined, undefined, command.command, command.title, {
            cwd: command.cwd,
            requestId: command.requestId,
            commands: command.commands,
            hidden: command.hidden
          });
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
  console.log(`AgentHero web app available at http://${displayHost}:${PORT}`);
  console.log(`AgentHero API/WebSocket server listening on http://${HOST}:${PORT}`);
  console.log(`AgentHero access token ${accessTokenEnabled() ? "is enabled" : "is disabled"}.`);
  console.log(`Configured projects=${config.projectPaths?.length || 0}`);
});
