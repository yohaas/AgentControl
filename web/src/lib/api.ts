import type { Capabilities, ClaudePlugin, ClaudePluginCatalog, DirectoryListing, GitStatus, MessageAttachment, Project, ProjectFileEntry } from "@agent-control/shared";
import type { SettingsState } from "../store/app-store";

let authToken: string | undefined;
let authTokenPromise: Promise<string> | undefined;

function endpointPath(input: RequestInfo): string {
  return typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
}

export async function agentControlToken(): Promise<string> {
  if (authToken) return authToken;
  authTokenPromise ??= fetch("/api/auth/token", { credentials: "same-origin" })
    .then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      const body = (await response.json()) as { token?: string };
      if (!body.token) throw new Error("AgentControl auth token was not returned.");
      authToken = body.token;
      return body.token;
    })
    .finally(() => {
      authTokenPromise = undefined;
    });
  return authTokenPromise;
}

async function withAuth(input: RequestInfo, init?: RequestInit): Promise<RequestInit | undefined> {
  if (endpointPath(input).startsWith("/api/auth/")) return init;
  const token = await agentControlToken();
  const headers = new Headers(init?.headers);
  headers.set("X-Agent-Control-Token", token);
  return { ...init, credentials: "same-origin", headers };
}

async function authedFetch(input: RequestInfo, init?: RequestInit, retry = true): Promise<Response> {
  const response = await fetch(input, await withAuth(input, init));
  if (response.status === 401 && retry) {
    authToken = undefined;
    return authedFetch(input, init, false);
  }
  return response;
}

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await authedFetch(input, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export const api = {
  projects: () => json<Project[]>("/api/projects"),
  rawAgentStream: async (id: string) => {
    const response = await authedFetch(`/api/agents/${encodeURIComponent(id)}/raw-stream`);
    if (!response.ok) throw new Error(await response.text());
    return response.text();
  },
  addProject: (path: string) =>
    json<Project[]>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    }),
  closeProject: (id: string) => json<Project[]>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  gitStatus: (id: string) => json<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/status`),
  gitPush: (id: string) => json<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/push`, { method: "POST" }),
  projectFiles: (id: string, query?: string) =>
    json<ProjectFileEntry[]>(
      `/api/projects/${encodeURIComponent(id)}/files${query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`
    ),
  saveAgentPlugins: (projectId: string, agentName: string, plugins: string[]) =>
    json<Project[]>(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}/plugins`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugins })
    }),
  addProjectContext: (id: string, path: string) =>
    json<MessageAttachment>(`/api/projects/${encodeURIComponent(id)}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    }),
  directories: (path?: string) =>
    json<DirectoryListing>(`/api/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  openFile: (path: string) =>
    json<{ ok: boolean }>("/api/filesystem/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    }),
  refresh: () => json<Project[]>("/api/refresh", { method: "POST" }),
  capabilities: () => json<Capabilities>("/api/capabilities"),
  adminStatus: () => json<{ supervised: boolean; pid: number }>("/api/admin/status"),
  restartApp: () => json<{ ok: boolean }>("/api/admin/restart", { method: "POST" }),
  shutdownApp: () => json<{ ok: boolean }>("/api/admin/shutdown", { method: "POST" }),
  settings: () => json<SettingsState>("/api/settings"),
  plugins: () => json<ClaudePlugin[]>("/api/plugins"),
  pluginCatalog: () => json<ClaudePluginCatalog>("/api/plugins/catalog"),
  enablePlugin: (plugin: string) => json<ClaudePlugin[]>(`/api/plugins/${encodeURIComponent(plugin)}/enable`, { method: "POST" }),
  installPlugin: (plugin: string, scope: string) =>
    json<ClaudePluginCatalog>("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin, scope })
    }),
  addPluginMarketplace: (source: string) =>
    json<ClaudePluginCatalog>("/api/plugins/marketplaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source })
    }),
  uploadAttachment: (payload: { name: string; mimeType: string; dataUrl: string }) =>
    json<MessageAttachment>("/api/attachments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  saveSettings: (settings: SettingsState) =>
    json<SettingsState>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    })
};
