import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AuthMethod, Capabilities } from "@agent-control/shared";

const execFileAsync = promisify(execFile);

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
  const lower = output.toLowerCase();
  if (lower.includes("claude.ai")) return "claude.ai";
  if (lower.includes("api key") || lower.includes("api-key") || lower.includes("anthropic_api_key")) return "api-key";
  return "unknown";
}

export async function detectCapabilities(): Promise<Capabilities> {
  let cliVersion: string | undefined;
  let authMethod: AuthMethod = "unknown";

  try {
    const { stdout, stderr } = await execFileAsync("claude", ["--version"], { timeout: 4000 });
    cliVersion = parseVersion(`${stdout}\n${stderr}`);
  } catch {
    return {
      supportsRemoteControl: false,
      authMethod,
      remoteControlReason: "Claude Code CLI was not found."
    };
  }

  try {
    const { stdout, stderr } = await execFileAsync("claude", ["/status"], { timeout: 4000 });
    authMethod = parseAuthMethod(`${stdout}\n${stderr}`);
  } catch {
    authMethod = "unknown";
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
