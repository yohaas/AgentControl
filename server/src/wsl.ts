import os from "node:os";
import path from "node:path";
import type { Project } from "@agent-control/shared";

export function isWslProject(project?: Pick<Project, "runtime">): boolean {
  return project?.runtime === "wsl";
}

export function wslUncPath(distro: string, linuxPath: string): string {
  const cleanDistro = distro.trim();
  const cleanPath = normalizeWslPath(linuxPath);
  return `\\\\wsl.localhost\\${cleanDistro}${cleanPath.replace(/\//g, "\\")}`;
}

export function parseWslUncPath(input: string): { distro: string; wslPath: string } | undefined {
  const normalized = input.replace(/\//g, "\\");
  const match = normalized.match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(?:\\(.*))?$/i);
  if (!match) return undefined;
  return {
    distro: match[1],
    wslPath: normalizeWslPath(match[2] ? `/${match[2].replace(/\\/g, "/")}` : "/")
  };
}

export function normalizeWslPath(input: string): string {
  const trimmed = input.trim() || "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return path.posix.normalize(withSlash);
}

export function canonicalWslProjectKey(input: string): string | undefined {
  const parsed = parseWslUncPath(input);
  if (!parsed) return undefined;
  return `wsl:${parsed.distro.toLowerCase()}:${normalizeWslPath(parsed.wslPath)}`;
}

export function wslProjectPath(project: Pick<Project, "path" | "wslPath">): string {
  return project.wslPath || parseWslUncPath(project.path)?.wslPath || project.path;
}

export function wslDistro(project: Pick<Project, "path" | "wslDistro">): string {
  return project.wslDistro || parseWslUncPath(project.path)?.distro || "Ubuntu";
}

export function wslCommandArgs(project: Pick<Project, "path" | "wslDistro" | "wslPath">, command: string, args: string[] = []): string[] {
  const script = [
    'if [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
    'export PATH="$HOME/.local/npm-global/bin:$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$HOME/.volta/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"',
    'for node_bin in "$HOME"/.nvm/versions/node/*/bin; do if [ -d "$node_bin" ]; then PATH="$node_bin:$PATH"; fi; done',
    'exec "$0" "$@"'
  ].join("; ");
  return ["-d", wslDistro(project), "--cd", wslProjectPath(project), "--exec", "bash", "-lc", script, command, ...args];
}

export function windowsPathToWslPath(input: string): string {
  const resolved = path.resolve(input);
  const parsed = path.parse(resolved);
  const drive = parsed.root.match(/^([a-zA-Z]):\\/);
  if (drive) {
    const rest = resolved.slice(parsed.root.length).replace(/\\/g, "/");
    return `/mnt/${drive[1].toLowerCase()}${rest ? `/${rest}` : ""}`;
  }
  const home = os.homedir();
  if (resolved.toLowerCase().startsWith(home.toLowerCase())) {
    const rest = path.relative(home, resolved).replace(/\\/g, "/");
    return `/mnt/${home[0].toLowerCase()}${home.slice(2).replace(/\\/g, "/")}${rest ? `/${rest}` : ""}`;
  }
  return resolved.replace(/\\/g, "/");
}
