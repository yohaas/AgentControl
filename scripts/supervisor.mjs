import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const stateDir = path.join(os.homedir(), ".agent-control");
const legacyStateDir = path.join(os.homedir(), ".agent-dashboard");
const controlPath = path.join(stateDir, "control.json");
const legacyControlPath = path.join(legacyStateDir, "control.json");
const npmCommand = "npm";

let child;
const lastControlMtimes = new Map();
let stopping = false;

function start() {
  console.log("[supervisor] starting AgentControl dev stack");
  child = spawn(npmCommand, ["run", "dev"], {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_CONTROL_SUPERVISED: "1" },
    stdio: "inherit",
    shell: process.platform === "win32"
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    console.log(`[supervisor] dev stack exited (${code ?? signal ?? "unknown"}), waiting for command`);
  });
}

function stopChild() {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", shell: true });
    return;
  }
  child.kill("SIGTERM");
}

async function readControlCommand(controlFilePath) {
  try {
    const info = await stat(controlFilePath);
    if (info.mtimeMs <= (lastControlMtimes.get(controlFilePath) || 0)) return undefined;
    lastControlMtimes.set(controlFilePath, info.mtimeMs);
    const raw = await readFile(controlFilePath, "utf8");
    await rm(controlFilePath, { force: true });
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function pollControl() {
  const command = (await readControlCommand(controlPath)) || (await readControlCommand(legacyControlPath));
  if (!command) return;

  if (command.command === "shutdown") {
    console.log("[supervisor] shutting down AgentControl");
    stopping = true;
    stopChild();
    setTimeout(() => process.exit(0), 750);
    return;
  }

  if (command.command === "restart") {
    console.log("[supervisor] restarting AgentControl");
    stopChild();
    setTimeout(start, 1200);
  }
}

await mkdir(stateDir, { recursive: true });
await rm(controlPath, { force: true });
await rm(legacyControlPath, { force: true });
start();
setInterval(() => void pollControl(), 500);

process.on("SIGINT", () => {
  stopping = true;
  stopChild();
  process.exit(0);
});

process.on("SIGTERM", () => {
  stopping = true;
  stopChild();
  process.exit(0);
});
