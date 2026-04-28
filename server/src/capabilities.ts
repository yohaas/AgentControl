import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AuthMethod, Capabilities } from "@agent-control/shared";

const execFileAsync = promisify(execFile);

function resolveWindowsCmdShim(shimPath: string): string | undefined {
  try {
    const shim = readFileSync(shimPath, "utf8");
    const match = shim.match(/"([^"]+claude\.exe)"/i);
    if (!match) return undefined;

    const commandPath = match[1].replace(/%dp0%/gi, path.dirname(shimPath));
    return existsSync(commandPath) ? commandPath : undefined;
  } catch {
    return undefined;
  }
}

function resolveWindowsClaudeCommand(commandPath: string): string {
  if (commandPath.toLowerCase().endsWith(".cmd")) {
    return resolveWindowsCmdShim(commandPath) || commandPath;
  }
  return commandPath;
}

export function resolveClaudeCommand(): string {
  if (process.env.CLAUDE_CODE_CLI) {
    return process.platform === "win32" ? resolveWindowsClaudeCommand(process.env.CLAUDE_CODE_CLI) : process.env.CLAUDE_CODE_CLI;
  }
  if (process.platform !== "win32") return "claude";

  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : path.join(os.homedir(), "AppData", "Roaming", "npm");
  const packagedExe = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (existsSync(packagedExe)) return packagedExe;

  const cmdShim = path.join(npmDir, "claude.cmd");
  if (existsSync(cmdShim)) return resolveWindowsClaudeCommand(cmdShim);

  return "claude.cmd";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

function parseAuthMethod(output: string): AuthMethod {
  try {
    const parsed = JSON.parse(output) as { authMethod?: unknown };
    if (parsed.authMethod === "claude.ai") return "claude.ai";
    if (parsed.authMethod === "api-key" || parsed.authMethod === "api key") return "api-key";
  } catch {
    // Fall back to loose text matching for older CLI output.
  }

  const lower = output.toLowerCase();
  if (lower.includes("claude.ai")) return "claude.ai";
  if (lower.includes("api key") || lower.includes("api-key") || lower.includes("anthropic_api_key")) return "api-key";
  return "unknown";
}

export async function detectCapabilities(): Promise<Capabilities> {
  let cliVersion: string | undefined;
  let authMethod: AuthMethod = "unknown";
  const claudeCommand = resolveClaudeCommand();

  try {
    const { stdout, stderr } = await execFileAsync(claudeCommand, ["--version"], { timeout: 4000 });
    cliVersion = parseVersion(`${stdout}\n${stderr}`);
  } catch {
    return {
      supportsRemoteControl: false,
      authMethod,
      remoteControlReason: "Claude Code CLI was not found."
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync(claudeCommand, ["auth", "status"], { timeout: 4000 });
    authMethod = parseAuthMethod(`${stdout}\n${stderr}`);
  } catch {
    try {
      const { stdout, stderr } = await execFileAsync(claudeCommand, ["/status"], { timeout: 4000 });
      authMethod = parseAuthMethod(`${stdout}\n${stderr}`);
    } catch {
      authMethod = "unknown";
    }
  }

  const versionOk = cliVersion ? compareVersions(cliVersion, "2.1.51") >= 0 : false;
  const supportsRemoteControl = versionOk && authMethod === "claude.ai";
  const reason = !versionOk
    ? "Remote Control requires Claude Code CLI 2.1.51 or newer."
    : authMethod !== "claude.ai"
      ? "Remote Control requires claude.ai authentication."
      : undefined;

  return {
    cliVersion,
    supportsRemoteControl,
    authMethod,
    remoteControlReason: reason
  };
}
