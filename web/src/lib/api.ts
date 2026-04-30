import type {
  Capabilities,
  AppUpdateStatus,
  ClaudePlugin,
  ClaudePluginCatalog,
  DirectoryListing,
  GitStatus,
  GitWorktreeCreateRequest,
  GitWorktreeList,
  GitWorktreeMergeRequest,
  GitWorktreeRemoveRequest,
  MessageAttachment,
  ModelProfile,
  Project,
  ProjectDiffResponse,
  ProjectFileEntry,
  ProjectFileResponse,
  ProjectTreeResponse
} from "@agent-control/shared";
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
  if (!response.ok) {
    const text = await response.text();
    try {
      const body = JSON.parse(text) as { error?: string };
      throw new Error(body.error || text);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(text);
      throw error;
    }
  }
  return response.json() as Promise<T>;
}

export const api = {
  projects: () => json<Project[]>("/api/projects"),
  rawAgentStream: async (id: string) => {
    const response = await authedFetch(`/api/agents/${encodeURIComponent(id)}/raw-stream`);
    if (!response.ok) throw new Error(await response.text());
    return response.text();
  },
  addProject: (path: string, options?: { runtime?: "local" | "wsl"; wslDistro?: string; wslPath?: string }) =>
    json<Project[]>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, ...options })
    }),
  closeProject: (id: string) => json<Project[]>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  gitStatus: (id: string) => json<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/status`),
  gitPush: (id: string) => json<GitStatus>(`/api/projects/${encodeURIComponent(id)}/git/push`, { method: "POST" }),
  gitWorktrees: (id: string) => json<GitWorktreeList>(`/api/projects/${encodeURIComponent(id)}/git/worktrees`),
  createGitWorktree: (id: string, payload: GitWorktreeCreateRequest) =>
    json<{ projects: Project[]; worktrees: GitWorktreeList }>(`/api/projects/${encodeURIComponent(id)}/git/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  mergeGitWorktree: (id: string, payload: GitWorktreeMergeRequest) =>
    json<GitWorktreeList>(`/api/projects/${encodeURIComponent(id)}/git/worktrees/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  removeGitWorktree: (id: string, payload: GitWorktreeRemoveRequest) =>
    json<{ projects: Project[]; worktrees: GitWorktreeList }>(`/api/projects/${encodeURIComponent(id)}/git/worktrees`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }),
  projectFiles: (id: string, query?: string) =>
    json<ProjectFileEntry[]>(
      `/api/projects/${encodeURIComponent(id)}/files${query?.trim() ? `?query=${encodeURIComponent(query.trim())}` : ""}`
    ),
  projectTree: (id: string, path?: string) =>
    json<ProjectTreeResponse>(
      `/api/projects/${encodeURIComponent(id)}/tree${path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : ""}`
    ),
  projectFile: (id: string, path: string, full = false) =>
    json<ProjectFileResponse>(
      `/api/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}${full ? "&full=1" : ""}`
    ),
  projectDiff: (id: string, path: string) =>
    json<ProjectDiffResponse>(`/api/projects/${encodeURIComponent(id)}/diff?path=${encodeURIComponent(path)}`),
  saveAgentPlugins: (projectId: string, agentName: string, plugins: string[]) =>
    json<Project[]>(`/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentName)}/plugins`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugins })
    }),
  saveBuiltInAgent: (projectId: string, agent: Partial<Project["agents"][number]> & { originalName?: string }) =>
    json<Project[]>(`/api/projects/${encodeURIComponent(projectId)}/built-in-agents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(agent)
    }),
  deleteBuiltInAgent: (projectId: string, agentName: string) =>
    json<Project[]>(`/api/projects/${encodeURIComponent(projectId)}/built-in-agents/${encodeURIComponent(agentName)}`, { method: "DELETE" }),
  addProjectContext: (id: string, path: string) =>
    json<MessageAttachment>(`/api/projects/${encodeURIComponent(id)}/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    }),
  directories: (path?: string, options?: { runtime?: "local" | "wsl"; distro?: string }) => {
    const params = new URLSearchParams();
    if (path) params.set("path", path);
    if (options?.runtime) params.set("runtime", options.runtime);
    if (options?.distro) params.set("distro", options.distro);
    const query = params.toString();
    return json<DirectoryListing>(`/api/filesystem/directories${query ? `?${query}` : ""}`);
  },
  wslDistros: () => json<{ defaultDistro: string; distros: string[] }>("/api/wsl/distros"),
  openFile: (path: string, mode?: "containingFolder" | "openWith") =>
    json<{ ok: boolean }>("/api/filesystem/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, mode })
    }),
  openProjectFile: (projectId: string, path: string, mode?: "containingFolder" | "openWith") =>
    json<{ ok: boolean }>("/api/filesystem/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, path, mode })
    }),
  refresh: () => json<Project[]>("/api/refresh", { method: "POST" }),
  capabilities: () => json<Capabilities>("/api/capabilities"),
  latestModels: (provider?: ModelProfile["provider"]) =>
    json<{
      fetchedAt: string;
      sourceUrls: Partial<Record<ModelProfile["provider"], string>>;
      providers: Partial<Record<ModelProfile["provider"], ModelProfile[]>>;
    }>(`/api/models/latest${provider ? `?provider=${encodeURIComponent(provider)}` : ""}`),
  adminStatus: () => json<{ supervised: boolean; pid: number }>("/api/admin/status"),
  appUpdates: () => json<AppUpdateStatus>("/api/admin/updates"),
  restartApp: () => json<{ ok: boolean }>("/api/admin/restart", { method: "POST" }),
  shutdownApp: () => json<{ ok: boolean }>("/api/admin/shutdown", { method: "POST" }),
  settings: () => json<SettingsState>("/api/settings"),
  plugins: (provider: ModelProfile["provider"] = "claude") => json<ClaudePlugin[]>(`/api/plugins?provider=${encodeURIComponent(provider)}`),
  pluginCatalog: (provider: ModelProfile["provider"] = "claude") =>
    json<ClaudePluginCatalog>(`/api/plugins/catalog?provider=${encodeURIComponent(provider)}`),
  enablePlugin: (plugin: string, provider: ModelProfile["provider"] = "claude") =>
    json<ClaudePlugin[]>(`/api/plugins/${encodeURIComponent(plugin)}/enable?provider=${encodeURIComponent(provider)}`, { method: "POST" }),
  installPlugin: (plugin: string, scope: string, provider: ModelProfile["provider"] = "claude") =>
    json<ClaudePluginCatalog>("/api/plugins/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plugin, scope, provider })
    }),
  addPluginMarketplace: (source: string, provider: ModelProfile["provider"] = "claude") =>
    json<ClaudePluginCatalog>("/api/plugins/marketplaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, provider })
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
