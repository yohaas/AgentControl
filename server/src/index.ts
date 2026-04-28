import http from "node:http";
import { execFile } from "node:child_process";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import type { DashboardConfig } from "./config.js";
import type { Capabilities, DirectoryEntry, GitChangedFile, GitStatus, MessageAttachment, Project, ProjectFileEntry, WsClientCommand, WsServerEvent } from "@agent-control/shared";
import { detectCapabilities } from "./capabilities.js";
import {
  expandHome,
  readConfig,
  resolveDefaultAgentMode,
  resolveModels,
  resolvePinLastSentMessage,
  resolveProjectsRoot,
  resolveSidebarWidth,
  resolveTerminalDock,
  resolveTileColumns,
  resolveTileHeight,
  writeConfig
} from "./config.js";
import { addMarketplace, enablePlugin, installPlugin, listPlugins, pluginCatalog } from "./plugins.js";
import { AgentRuntimeManager } from "./runtime.js";
import { scanConfiguredProjects, scanProject, updateAgentPlugins } from "./scanner.js";
import { TerminalManager } from "./terminal.js";

const PORT = Number(process.env.PORT || 4317);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const attachmentsDir = path.join(os.homedir(), ".agent-dashboard", "attachments");
const controlDir = path.join(os.homedir(), ".agent-dashboard");
const controlPath = path.join(controlDir, "control.json");
const supervised = process.env.AGENT_CONTROL_SUPERVISED === "1";
const ignoredContextDirs = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", ".cache", "coverage"]);

let config = await readConfig();
let projectsRoot = resolveProjectsRoot(config);
let projects: Project[] = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths) : [];
let capabilities: Capabilities = await detectCapabilities();

const app = express();
const server = http.createServer(app);
const clients = new Set<WebSocket>();

function send(ws: WebSocket, event: WsServerEvent): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function broadcast(event: WsServerEvent): void {
  for (const client of clients) send(client, event);
}

async function filesystemRoots(): Promise<DirectoryEntry[]> {
  if (process.platform !== "win32") return [{ name: "/", path: "/" }];
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const roots = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        await access(root);
        return { name: root, path: root };
      } catch {
        return undefined;
      }
    })
  );
  return roots.filter((root): root is DirectoryEntry => Boolean(root));
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

function gitCommand(cwd: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "Git command failed.").trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

async function projectGitStatus(project: Project): Promise<GitStatus> {
  try {
    const output = await gitCommand(project.path, ["status", "--porcelain=v1", "--branch"]);
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

const runtime = new AgentRuntimeManager(
  () => projects,
  broadcast,
  () => capabilities
);
await runtime.loadPersistedState();
const terminals = new TerminalManager(() => projects, broadcast);

app.use(express.json({ limit: "20mb" }));
app.use(
  cors({
    origin: process.env.NODE_ENV === "production" ? false : "http://localhost:4318"
  })
);

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
    await updateAgentPlugins(project.path, request.params.name, plugins);
    projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths) : [];
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
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths) : [];
  response.json(projects);
});

app.post("/api/projects", async (request, response) => {
  const projectPath = typeof request.body?.path === "string" ? request.body.path.trim() : "";
  if (!projectPath) {
    response.status(400).json({ error: "Project path is required." });
    return;
  }

  const project = await scanProject(projectPath);
  if (!project) {
    response.status(404).json({ error: "Project path was not found or is not a directory." });
    return;
  }

  const projectPaths = Array.from(new Set([...(config.projectPaths || []), project.path]));
  config = await writeConfig({ ...config, projectPaths });
  projects = await scanConfiguredProjects(projectPaths);
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
  projects = await scanConfiguredProjects(projectPaths);
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
    await gitCommand(project.path, ["push"], 120000);
    response.json(await projectGitStatus(project));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/filesystem/directories", async (request, response) => {
  const requestedPath = typeof request.query.path === "string" && request.query.path.trim() ? request.query.path.trim() : os.homedir();
  const directoryPath = path.resolve(requestedPath);

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
      parentPath: parentPath !== directoryPath ? parentPath : undefined,
      homePath: os.homedir(),
      roots: await filesystemRoots(),
      entries: directories
    });
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
  await mkdir(attachmentsDir, { recursive: true });
  await writeFile(filePath, data);

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
    autoApprove: config.autoApprove || "off",
    defaultAgentMode: resolveDefaultAgentMode(config),
    tileHeight: resolveTileHeight(config),
    tileColumns: resolveTileColumns(config),
    sidebarWidth: resolveSidebarWidth(config),
    pinLastSentMessage: resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(config),
    capabilities
  });
});

app.get("/api/plugins", async (_request, response) => {
  try {
    response.json(await listPlugins());
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/plugins/catalog", async (_request, response) => {
  try {
    response.json(await pluginCatalog());
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/plugins/:plugin/enable", async (request, response) => {
  try {
    response.json(await enablePlugin(request.params.plugin));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/plugins/install", async (request, response) => {
  const body = request.body as { plugin?: string; scope?: string };
  if (!body.plugin?.trim()) {
    response.status(400).json({ error: "Plugin is required." });
    return;
  }
  try {
    response.json(await installPlugin(body.plugin.trim(), body.scope));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/plugins/marketplaces", async (request, response) => {
  const body = request.body as { source?: string };
  if (!body.source?.trim()) {
    response.status(400).json({ error: "Marketplace source is required." });
    return;
  }
  try {
    response.json(await addMarketplace(body.source.trim()));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/settings", async (request, response) => {
  const body = request.body as DashboardConfig;
  config = await writeConfig({
    projectsRoot: typeof body.projectsRoot === "string" ? body.projectsRoot : config.projectsRoot,
    projectPaths: Array.isArray(body.projectPaths) ? body.projectPaths : config.projectPaths,
    models: Array.isArray(body.models) ? body.models : config.models,
    autoApprove: body.autoApprove || config.autoApprove,
    defaultAgentMode: resolveDefaultAgentMode(body.defaultAgentMode ? body : config),
    tileHeight: typeof body.tileHeight === "number" ? resolveTileHeight(body) : resolveTileHeight(config),
    tileColumns: typeof body.tileColumns === "number" ? resolveTileColumns(body) : resolveTileColumns(config),
    sidebarWidth: typeof body.sidebarWidth === "number" ? resolveSidebarWidth(body) : resolveSidebarWidth(config),
    pinLastSentMessage: typeof body.pinLastSentMessage === "boolean" ? body.pinLastSentMessage : resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(body.terminalDock ? body : config)
  });
  projectsRoot = resolveProjectsRoot(config);
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths) : [];
  response.json({
    projectsRoot,
    projectPaths: config.projectPaths || [],
    models: resolveModels(config),
    autoApprove: config.autoApprove || "off",
    defaultAgentMode: resolveDefaultAgentMode(config),
    tileHeight: resolveTileHeight(config),
    tileColumns: resolveTileColumns(config),
    sidebarWidth: resolveSidebarWidth(config),
    pinLastSentMessage: resolvePinLastSentMessage(config),
    terminalDock: resolveTerminalDock(config),
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

const wss = new WebSocketServer({ server, path: "/ws" });

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
          void runtime.launch(command.request).catch((error: unknown) => {
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
        case "clear":
          runtime.clear(command.id);
          break;
        case "clearAll":
          runtime.clearAll(command.projectId);
          break;
        case "resume":
          runtime.resume(command.id);
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

server.listen(PORT, () => {
  console.log(`Agent dashboard server listening on http://localhost:${PORT}`);
  console.log(`Configured projects=${config.projectPaths?.length || 0}`);
});
