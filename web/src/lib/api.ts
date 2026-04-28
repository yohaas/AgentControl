import type { Capabilities, ClaudePlugin, MessageAttachment, Project } from "@agent-control/shared";
import type { SettingsState } from "../store/app-store";

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export const api = {
  projects: () => json<Project[]>("/api/projects"),
  addProject: (path: string) =>
    json<Project[]>("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path })
    }),
  refresh: () => json<Project[]>("/api/refresh", { method: "POST" }),
  capabilities: () => json<Capabilities>("/api/capabilities"),
  settings: () => json<SettingsState>("/api/settings"),
  plugins: () => json<ClaudePlugin[]>("/api/plugins"),
  enablePlugin: (plugin: string) => json<ClaudePlugin[]>(`/api/plugins/${encodeURIComponent(plugin)}/enable`, { method: "POST" }),
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
