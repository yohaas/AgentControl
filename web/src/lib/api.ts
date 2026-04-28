import type { Capabilities, ClaudePlugin, ClaudePluginCatalog, DirectoryListing, GitStatus, MessageAttachment, Project } from "@agent-control/shared";
import type { SettingsState } from "../store/app-store";

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export const api = {
  projects: () => json<Project[]>("/api/projects"),
  rawAgentStream: async (id: string) => {
    const response = await fetch(`/api/agents/${encodeURIComponent(id)}/raw-stream`);
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
  directories: (path?: string) =>
    json<DirectoryListing>(`/api/filesystem/directories${path ? `?path=${encodeURIComponent(path)}` : ""}`),
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
