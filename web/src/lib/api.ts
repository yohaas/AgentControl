import type { Capabilities, Project } from "@agent-control/shared";
import type { SettingsState } from "../store/app-store";

async function json<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}

export const api = {
  projects: () => json<Project[]>("/api/projects"),
  refresh: () => json<Project[]>("/api/refresh", { method: "POST" }),
  capabilities: () => json<Capabilities>("/api/capabilities"),
  settings: () => json<SettingsState>("/api/settings"),
  saveSettings: (settings: SettingsState) =>
    json<SettingsState>("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings)
    })
};
