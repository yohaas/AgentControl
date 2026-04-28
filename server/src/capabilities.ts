import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AuthMethod, Capabilities, ProviderCapability } from "@agent-control/shared";

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
  const configured = process.env.CLAUDE_CODE_CLI || process.env.AGENTCONTROL_CLAUDE_PATH;
  if (configured) {
    return process.platform === "win32" ? resolveWindowsClaudeCommand(configured) : configured;
  }
  if (process.platform !== "win32") return "claude";

  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : path.join(os.homedir(), "AppData", "Roaming", "npm");
  const packagedExe = path.join(npmDir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  if (existsSync(packagedExe)) return packagedExe;

  const cmdShim = path.join(npmDir, "claude.cmd");
  if (existsSync(cmdShim)) return resolveWindowsClaudeCommand(cmdShim);

  return "claude.cmd";
}

export function resolveCodexCommand(): string {
  const configured = process.env.CODEX_CLI || process.env.AGENTCONTROL_CODEX_PATH;
  if (configured) return configured;
  if (process.platform !== "win32") return "codex";
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : path.join(os.homedir(), "AppData", "Roaming", "npm");
  const cmdShim = path.join(npmDir, "codex.cmd");
  if (existsSync(cmdShim)) return cmdShim;
  return "codex.cmd";
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

function nodeCommandForNpmShim(shimPath: string): string {
  const nodePath = path.join(path.dirname(shimPath), "node.exe");
  return existsSync(nodePath) ? nodePath : process.platform === "win32" ? "node.exe" : "node";
}

function codexScriptForShim(shimPath: string): string | undefined {
  const scriptPath = path.join(path.dirname(shimPath), "node_modules", "@openai", "codex", "bin", "codex.js");
  return existsSync(scriptPath) ? scriptPath : undefined;
}

export function resolveCodexInvocation(): CommandInvocation {
  const command = resolveCodexCommand();
  const lower = command.toLowerCase();
  if (lower.endsWith(".js")) return { command: process.execPath, args: [command] };
  if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".ps1"))) {
    const scriptPath = codexScriptForShim(command);
    if (scriptPath) return { command: nodeCommandForNpmShim(command), args: [scriptPath] };
  }
  return { command, args: [] };
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

  let claudeAvailable = false;
  try {
    const { stdout, stderr } = await execFileAsync(claudeCommand, ["--version"], { timeout: 4000 });
    cliVersion = parseVersion(`${stdout}\n${stderr}`);
    claudeAvailable = true;
  } catch {
    // Continue with non-Claude providers.
  }

  if (claudeAvailable) {
    try {
      const { stdout, stderr } = await execFileAsync(claudeCommand, ["auth", "status"], { timeout: 4000 });
      authMethod = parseAuthMethod(`${stdout}\n${stderr}`);
    } catch {
      try {
        const { stdout, stderr } = await execFileAsync(claudeCommand, ["/status"], { timeout: 4000 });
        authMethod = parseAuthMethod(`${stdout}\n${stderr}`);
      } catch {
        authMethod = process.env.ANTHROPIC_API_KEY ? "api-key" : "unknown";
      }
    }
  }

  const versionOk = cliVersion ? compareVersions(cliVersion, "2.1.51") >= 0 : false;
  const supportsRemoteControl = claudeAvailable && versionOk && authMethod === "claude.ai";
  const reason = !claudeAvailable
    ? "Claude Code CLI was not found."
    : !versionOk
    ? "Remote Control requires Claude Code CLI 2.1.51 or newer."
    : authMethod !== "claude.ai"
      ? "Remote Control requires claude.ai authentication."
      : undefined;

  const providers: ProviderCapability[] = [
    {
      provider: "claude",
      label: "Claude Code",
      available: claudeAvailable,
      version: cliVersion,
      authMethod,
      command: claudeCommand,
      reason: claudeAvailable ? undefined : "Claude Code CLI was not found.",
      supportsRemoteControl,
      supportsStreaming: true,
      supportsImages: true,
      supportsTools: true,
      supportsMcp: true,
      supportsPlugins: true,
      supportsResume: true
    },
    await detectCodexCapability(),
    {
      provider: "openai",
      label: "OpenAI API",
      available: Boolean(process.env.OPENAI_API_KEY),
      authMethod: process.env.OPENAI_API_KEY ? "openai-api" : "unknown",
      reason: process.env.OPENAI_API_KEY ? undefined : "OPENAI_API_KEY is not set.",
      supportsStreaming: true,
      supportsImages: true,
      supportsTools: true,
      supportsMcp: false,
      supportsPlugins: false,
      supportsResume: false
    }
  ];

  return {
    cliVersion,
    supportsRemoteControl,
    authMethod,
    remoteControlReason: reason,
    providers
  };
}

async function detectCodexCapability(): Promise<ProviderCapability> {
  const codexCommand = resolveCodexCommand();
  const codexInvocation = resolveCodexInvocation();
  try {
    const { stdout, stderr } = await execFileAsync(codexInvocation.command, [...codexInvocation.args, "--version"], { timeout: 4000 });
    const supportsPlugins = await execFileAsync(codexInvocation.command, [...codexInvocation.args, "plugin", "--help"], { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    return {
      provider: "codex",
      label: "Codex CLI",
      available: true,
      version: parseVersion(`${stdout}\n${stderr}`),
      authMethod: process.env.OPENAI_API_KEY ? "openai-api" : "chatgpt",
      command: codexCommand,
      supportsStreaming: true,
      supportsImages: false,
      supportsTools: true,
      supportsMcp: true,
      supportsPlugins,
      supportsResume: false
    };
  } catch {
    return {
      provider: "codex",
      label: "Codex CLI",
      available: false,
      command: codexCommand,
      reason: "Codex CLI was not found or could not be executed.",
      supportsStreaming: false
    };
  }
}
