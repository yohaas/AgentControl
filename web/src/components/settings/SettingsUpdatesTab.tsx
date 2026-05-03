import { FolderOpen, HardDrive, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { AppInstallMode, AppUpdateStatus } from "@agent-hero/shared";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
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
  installMode: AppInstallMode;
  setInstallMode: (value: AppInstallMode) => void;
  updateManifestUrl: string;
  setUpdateManifestUrl: (value: string) => void;
  updateCommandsText: string;
  setUpdateCommandsText: (value: string) => void;
}

function compareDottedVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
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
  installMode,
  setInstallMode,
  updateManifestUrl,
  setUpdateManifestUrl,
  updateCommandsText,
  setUpdateCommandsText
}: SettingsUpdatesTabProps) {
  const localVersion = settingsUpdateStatus?.localVersion;
  const latestVersion = settingsUpdateStatus?.latestVersion;
  const manifestVersionOlder =
    latestVersion?.version && localVersion?.version ? compareDottedVersions(latestVersion.version, localVersion.version) < 0 : false;

  return (
    <>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">Auto-update</h3>
            <p className="text-xs text-muted-foreground">Check for checkout or installed release updates on startup.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onCheckUpdatesNow} disabled={checkingUpdates}>
            {checkingUpdates ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Check Now
          </Button>
        </div>
        {settingsUpdateStatus && (
          <div className="grid gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{settingsUpdateStatus.installMode}</Badge>
              <span>
                {settingsUpdateStatus.updateAvailable ? "Updates available" : "No updates found"} at{" "}
                {new Date(settingsUpdateStatus.checkedAt).toLocaleString()}.
              </span>
            </div>
            {localVersion?.version && (
              <div>
                Current: <span className="font-mono">{localVersion.releaseTag || localVersion.version}</span>
                {localVersion.commitSha && <span className="font-mono"> ({localVersion.commitSha.slice(0, 12)})</span>}
              </div>
            )}
            {latestVersion?.version && (
              <div>
                {manifestVersionOlder ? "Manifest" : "Latest"}: <span className="font-mono">{latestVersion.releaseTag || latestVersion.version}</span>
              </div>
            )}
            {settingsUpdateStatus.updateAsset && (
              <div className="font-mono">
                Asset: {settingsUpdateStatus.updateAsset.type || "full"} / {settingsUpdateStatus.updateAsset.platform}
              </div>
            )}
            {settingsUpdateStatus.message && <div>{settingsUpdateStatus.message}</div>}
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
          <h3 className="text-sm font-medium">Install mode</h3>
          <p className="text-xs text-muted-foreground">
            Checkout mode updates from Git. Installed mode updates from a release manifest and must run as the interactive Windows user.
          </p>
        </div>
        <label className="grid gap-1.5 text-sm">
          Mode
          <Select value={installMode} onValueChange={(value) => setInstallMode(value as AppInstallMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="checkout">Checkout</SelectItem>
              <SelectItem value="installed">Installed</SelectItem>
            </SelectContent>
          </Select>
        </label>
        {installMode === "installed" && (
          <label className="grid gap-1.5 text-sm">
            Release manifest URL
            <Input value={updateManifestUrl} onChange={(event) => setUpdateManifestUrl(event.target.value)} placeholder="https://example.com/agent-hero/manifest.json" />
          </label>
        )}
      </section>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Project</h3>
          <p className="text-xs text-muted-foreground">Choose the AgentHero folder used by checkout update and service commands.</p>
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
