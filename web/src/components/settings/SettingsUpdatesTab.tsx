import { FolderOpen, HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { AppUpdateStatus } from "@agent-hero/shared";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

interface SettingsUpdatesTabProps {
  updateChecksEnabled: boolean;
  setUpdateChecksEnabled: (value: boolean) => void;
  checkingUpdates: boolean;
  settingsUpdateStatus?: AppUpdateStatus;
  onCheckUpdatesNow: () => void;
  agentControlProjectPath: string;
  setAgentHeroProjectPath: (value: string) => void;
  onBrowseProjectPath: () => void;
  isWindowsClient: boolean;
  onRunWindowsServiceScript: (action: "install" | "uninstall") => void;
  windowsServiceStatus: string;
  updateCommandsText: string;
  setUpdateCommandsText: (value: string) => void;
}

export function SettingsUpdatesTab({
  updateChecksEnabled,
  setUpdateChecksEnabled,
  checkingUpdates,
  settingsUpdateStatus,
  onCheckUpdatesNow,
  agentControlProjectPath,
  setAgentHeroProjectPath,
  onBrowseProjectPath,
  isWindowsClient,
  onRunWindowsServiceScript,
  windowsServiceStatus,
  updateCommandsText,
  setUpdateCommandsText
}: SettingsUpdatesTabProps) {
  return (
    <>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">Auto-update</h3>
            <p className="text-xs text-muted-foreground">Check GitHub on startup and show update status.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onCheckUpdatesNow} disabled={checkingUpdates}>
            {checkingUpdates ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check Now
          </Button>
        </div>
        {settingsUpdateStatus && (
          <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {settingsUpdateStatus.isRepo
              ? `${settingsUpdateStatus.updateAvailable ? "Updates available" : "No updates found"} at ${new Date(settingsUpdateStatus.checkedAt).toLocaleString()}.`
              : settingsUpdateStatus.message || "Update status unavailable."}
          </div>
        )}
        <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={updateChecksEnabled}
            onChange={(event) => setUpdateChecksEnabled(event.target.checked)}
          />
          <span>
            <span className="block font-medium">Check for updates on startup</span>
          </span>
        </label>
      </section>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Project</h3>
          <p className="text-xs text-muted-foreground">Choose the AgentHero project folder used by update and service commands.</p>
        </div>
        <label className="grid gap-1.5 text-sm">
          AgentHero project location
          <div className="flex gap-2">
            <Input
              value={agentControlProjectPath}
              onChange={(event) => setAgentHeroProjectPath(event.target.value)}
              placeholder="AgentHero project folder"
            />
            <Button type="button" variant="outline" onClick={onBrowseProjectPath}>
              <FolderOpen className="h-4 w-4" />
              Browse
            </Button>
          </div>
        </label>
      </section>
      {isWindowsClient && (
        <section className="grid gap-2 rounded-md border border-border p-3">
          <div>
            <h3 className="text-sm font-medium">Service</h3>
            <p className="text-xs text-muted-foreground">Install or remove the AgentHero Windows service using the project location above.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => onRunWindowsServiceScript("install")}>
              <HardDrive className="h-4 w-4" />
              Install / Reinstall
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => onRunWindowsServiceScript("uninstall")}>
              <Trash2 className="h-4 w-4" />
              Uninstall
            </Button>
          </div>
          {windowsServiceStatus && <div className="text-xs text-muted-foreground">{windowsServiceStatus}</div>}
        </section>
      )}
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Update commands</h3>
          <p className="text-xs text-muted-foreground">Run these shell commands from a terminal when applying updates.</p>
        </div>
        <label className="grid gap-1.5 text-sm">
          Commands
          <Textarea
            value={updateCommandsText}
            onChange={(event) => setUpdateCommandsText(event.target.value)}
            rows={5}
            className="font-mono text-xs"
            placeholder="powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\start-update.ps1"
          />
        </label>
      </section>
    </>
  );
}
