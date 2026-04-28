import http from "node:http";
import { access, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import type { DashboardConfig } from "./config.js";
import type { Capabilities, DirectoryEntry, MessageAttachment, Project, WsClientCommand, WsServerEvent } from "@agent-control/shared";
import { detectCapabilities } from "./capabilities.js";
import { readConfig, resolveModels, resolveProjectsRoot, resolveTileColumns, resolveTileHeight, writeConfig } from "./config.js";
import { enablePlugin, listPlugins } from "./plugins.js";
import { AgentRuntimeManager } from "./runtime.js";
import { scanConfiguredProjects, scanProject } from "./scanner.js";
import { TerminalManager } from "./terminal.js";

const PORT = Number(process.env.PORT || 4317);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const attachmentsDir = path.join(os.homedir(), ".agent-dashboard", "attachments");

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
  const project = projects.find((candidate) => candidate.id === request.params.id);
  if (!project) {
    response.status(404).json({ error: "Project not found." });
    return;
  }
  response.json(project.agents);
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
  const name = typeof request.body?.name === "string" ? request.body.name : "pasted-image";
  const mimeType = typeof request.body?.mimeType === "string" ? request.body.mimeType : "";
  const dataUrl = typeof request.body?.dataUrl === "string" ? request.body.dataUrl : "";
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([\s\S]+)$/);

  if (!mimeType.startsWith("image/") || !match) {
    response.status(400).json({ error: "Only pasted image attachments are supported." });
    return;
  }

  const mediaType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  const data = Buffer.from(match[2], "base64");
  if (data.length > 10 * 1024 * 1024) {
    response.status(413).json({ error: "Pasted image is larger than 10 MB." });
    return;
  }

  const ext = mediaType === "image/jpeg" ? "jpg" : mediaType.split("/")[1];
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
    path: filePath,
    url: `/api/attachments/${fileName}`
  };
  response.json(attachment);
});

app.get("/api/agents", (_request, response) => {
  response.json(runtime.listAgents());
});

app.get("/api/capabilities", (_request, response) => {
  response.json(capabilities);
});

app.get("/api/settings", (_request, response) => {
  response.json({
    projectsRoot,
    projectPaths: config.projectPaths || [],
    models: resolveModels(config),
    autoApprove: config.autoApprove || "off",
    tileHeight: resolveTileHeight(config),
    tileColumns: resolveTileColumns(config),
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

app.post("/api/plugins/:plugin/enable", async (request, response) => {
  try {
    response.json(await enablePlugin(request.params.plugin));
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
    tileHeight: typeof body.tileHeight === "number" ? resolveTileHeight(body) : resolveTileHeight(config),
    tileColumns: typeof body.tileColumns === "number" ? resolveTileColumns(body) : resolveTileColumns(config)
  });
  projectsRoot = resolveProjectsRoot(config);
  projects = config.projectPaths?.length ? await scanConfiguredProjects(config.projectPaths) : [];
  response.json({
    projectsRoot,
    projectPaths: config.projectPaths || [],
    models: resolveModels(config),
    autoApprove: config.autoApprove || "off",
    tileHeight: resolveTileHeight(config),
    tileColumns: resolveTileColumns(config),
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
        case "setModel":
          runtime.setModel(command.id, command.model);
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
          terminals.start(command.projectId);
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
