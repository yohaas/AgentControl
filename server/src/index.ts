import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { WebSocketServer, type WebSocket } from "ws";
import type { DashboardConfig } from "./config.js";
import type { Capabilities, Project, WsClientCommand, WsServerEvent } from "@agent-control/shared";
import { detectCapabilities } from "./capabilities.js";
import { readConfig, resolveModels, resolveProjectsRoot, writeConfig } from "./config.js";
import { AgentRuntimeManager } from "./runtime.js";
import { scanProjects } from "./scanner.js";

const PORT = Number(process.env.PORT || 4317);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let config = await readConfig();
let projectsRoot = resolveProjectsRoot(config);
let projects: Project[] = await scanProjects(projectsRoot);
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

const runtime = new AgentRuntimeManager(
  () => projects,
  broadcast,
  () => capabilities
);
await runtime.loadPersistedState();

app.use(express.json({ limit: "2mb" }));
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
  projects = await scanProjects(projectsRoot);
  response.json(projects);
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
    models: resolveModels(config),
    autoApprove: config.autoApprove || "off",
    capabilities
  });
});

app.put("/api/settings", async (request, response) => {
  const body = request.body as DashboardConfig;
  config = await writeConfig({
    projectsRoot: typeof body.projectsRoot === "string" ? body.projectsRoot : config.projectsRoot,
    models: Array.isArray(body.models) ? body.models : config.models,
    autoApprove: body.autoApprove || config.autoApprove
  });
  projectsRoot = resolveProjectsRoot(config);
  projects = await scanProjects(projectsRoot);
  response.json({
    projectsRoot,
    models: resolveModels(config),
    autoApprove: config.autoApprove || "off",
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
          break;
        case "launch":
          void runtime.launch(command.request).catch((error: unknown) => {
            send(ws, { type: "agent.error", message: error instanceof Error ? error.message : String(error) });
          });
          break;
        case "userMessage":
          runtime.userMessage(command.id, command.text);
          break;
        case "kill":
          runtime.kill(command.id);
          break;
        case "setModel":
          runtime.setModel(command.id, command.model);
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
          runtime.clearAll();
          break;
        case "resume":
          runtime.resume(command.id);
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
  console.log(`PROJECTS_ROOT=${projectsRoot}`);
});
