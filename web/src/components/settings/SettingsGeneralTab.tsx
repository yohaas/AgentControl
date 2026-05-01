import type { RefObject, Dispatch, SetStateAction } from "react";
import { Clipboard, FolderOpen, KeyRound, X } from "lucide-react";
import type { SettingsState } from "../../store/app-store";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface SettingsGeneralTabProps {
  settings: SettingsState;
  projectPaths: string[];
  setProjectPaths: Dispatch<SetStateAction<string[]>>;
  gitPath: string;
  setGitPath: (value: string) => void;
  accessTokenEnabled: boolean;
  setAccessTokenEnabled: (value: boolean) => void;
  accessToken: string;
  setAccessToken: (value: string) => void;
  importInputRef: RefObject<HTMLInputElement | null>;
  onAddProjectFolder: () => void;
  onExportConfig: () => void;
  onImportConfig: (file: File) => void;
}

export function SettingsGeneralTab({
  settings,
  projectPaths,
  setProjectPaths,
  gitPath,
  setGitPath,
  accessTokenEnabled,
  setAccessTokenEnabled,
  accessToken,
  setAccessToken,
  importInputRef,
  onAddProjectFolder,
  onExportConfig,
  onImportConfig
}: SettingsGeneralTabProps) {
  return (
    <>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-medium">Project folders</h3>
            <p className="text-xs text-muted-foreground">Choose folders to load into AgentHero.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={onAddProjectFolder}>
            <FolderOpen className="h-4 w-4" />
            Add Folder
          </Button>
        </div>
        <div className="grid gap-1.5">
          {projectPaths.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-sm text-muted-foreground">
              No project folders selected.
            </p>
          ) : (
            projectPaths.map((projectPath) => (
              <div key={projectPath} className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-background/50 px-2 py-2">
                <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={projectPath}>
                  {projectPath}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  title="Remove project folder"
                  onClick={() => setProjectPaths((current) => current.filter((item) => item !== projectPath))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))
          )}
        </div>
      </section>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Paths</h3>
          <p className="text-xs text-muted-foreground">Leave blank to auto-detect from PATH or environment variables.</p>
        </div>
        <label className="grid gap-1.5 text-sm">
          Git path
          <Input value={gitPath} onChange={(event) => setGitPath(event.target.value)} placeholder="git" />
        </label>
      </section>
      <section className="grid gap-3 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Security</h3>
          <p className="text-xs text-muted-foreground">Require an access token before the browser can use the API or WebSocket.</p>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-border bg-background/50 p-3 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={accessTokenEnabled}
            onChange={(event) => setAccessTokenEnabled(event.target.checked)}
          />
          <span>
            <span className="block font-medium">Require access token</span>
            <span className="block text-xs text-muted-foreground">
              {settings.accessTokenSaved ? "A token is saved. Enter a new token to replace it." : "No access token is saved yet."}
            </span>
          </span>
        </label>
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <label className="grid min-w-0 gap-1.5 text-sm">
            Access token
            <Input
              type="text"
              value={accessToken}
              onChange={(event) => setAccessToken(event.target.value)}
              placeholder={settings.accessTokenSaved ? "Leave blank to keep current token" : "Enter or generate a token"}
            />
          </label>
          <Button type="button" variant="outline" className="self-end" onClick={() => setAccessToken(generateAccessToken())}>
            <KeyRound className="h-4 w-4" />
            Generate Token
          </Button>
        </div>
      </section>
      <section className="grid gap-2 rounded-md border border-border p-3">
        <div>
          <h3 className="text-sm font-medium">Configuration</h3>
          <p className="text-xs text-muted-foreground">Export or import this app's settings.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onExportConfig}>
            <Clipboard className="h-4 w-4" />
            Export Config
          </Button>
          <Button variant="outline" onClick={() => importInputRef.current?.click()}>
            <FolderOpen className="h-4 w-4" />
            Import Config
          </Button>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onImportConfig(file);
          }}
        />
      </section>
    </>
  );
}
