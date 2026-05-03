import os from "node:os";
import { spawn as spawnChild } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { spawn as spawnPty } from "node-pty";
import type { Project, TerminalSession, TerminalSnapshot, WsServerEvent } from "@agent-hero/shared";
import { statePath } from "./storage.js";
import { isWslProject, wslProjectPath } from "./wsl.js";

const MAX_OUTPUT_CHUNKS = 2000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const OUTPUT_FLUSH_MS = 16;
const OUTPUT_FLUSH_BYTES = 64 * 1024;
const terminalHistoryDir = statePath("terminal-history");

interface ShellSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface PtyStartAttempt {
  shell: ShellSpec;
  cwd: string;
}

interface TerminalProcess {
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  kill: () => void;
  onData: (callback: (data: string) => void) => void;
  onExit: (callback: (event: { exitCode: number; signal?: string | number | null }) => void) => void;
}

interface TerminalState {
  session: TerminalSession;
  process: TerminalProcess;
  output: string[];
  pending: string;
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  flush: () => void;
}

interface TerminalStartOptions {
  cwd?: string;
  requestId?: string;
  commands?: string[];
  hidden?: boolean;
}

function now() {
  return new Date().toISOString();
}

function envForPty(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function shellName(command: string): string {
  return path.basename(command).toLowerCase();
}

function powershellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellWslCommand(project: Project): string {
  return [
    "& wsl.exe",
    "-d",
    powershellString(project.wslDistro || "Ubuntu"),
    "--cd",
    powershellString(wslProjectPath(project))
  ].join(" ");
}

function powershellSequence(commands: string[]): string {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    "try {",
    "  $commands = @(",
    ...commands.map((command) => `    ${powershellString(command)}`),
    "  )",
    "  foreach ($command in $commands) {",
    "    Write-Host \"\"",
    "    Write-Host \"> $command\" -ForegroundColor Cyan",
    "    Invoke-Expression $command",
    "    if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
    "  }",
    "} catch {",
    "  Write-Error $_",
    "  exit 1",
    "}"
  ];
  return lines.join(os.EOL);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function bashSequence(commands: string[]): string {
  const lines = ["set -e"];
  for (const command of commands) {
    lines.push(`printf '\\n> %s\\n' ${shellQuote(command)}`, command);
  }
  return lines.join(os.EOL);
}

function existingDirectory(candidate?: string): string | undefined {
  if (!candidate) return undefined;
  try {
    return statSync(candidate).isDirectory() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function ptyStartAttempts(shell: ShellSpec, cwd: string, commands: string[]): PtyStartAttempt[] {
  const home = existingDirectory(os.homedir()) || cwd;
  const attempts: PtyStartAttempt[] = [{ shell, cwd }];
  if (home !== cwd) attempts.push({ shell, cwd: home });
  if (process.platform === "darwin") {
    const fallbackArgs = commands.length ? ["-lc", bashSequence(commands)] : [];
    for (const command of ["/bin/bash", "/bin/sh"]) {
      if (command !== shell.command) {
        attempts.push({ shell: { command, args: fallbackArgs, env: shell.env }, cwd });
        if (home !== cwd) attempts.push({ shell: { command, args: fallbackArgs, env: shell.env }, cwd: home });
      }
    }
  }
  return attempts;
}

function spawnScriptFallback(shell: ShellSpec, cwd: string, env: Record<string, string>): TerminalProcess {
  const child = spawnChild("/usr/bin/script", ["-q", "/dev/null", shell.command, ...shell.args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  return {
    write: (data) => {
      child.stdin.write(data);
    },
    resize: () => undefined,
    kill: () => {
      child.kill();
    },
    onData: (callback) => {
      child.stdout.on("data", (chunk) => callback(chunk.toString()));
      child.stderr.on("data", (chunk) => callback(chunk.toString()));
    },
    onExit: (callback) => {
      child.on("exit", (code, signal) => callback({ exitCode: code ?? 0, signal }));
    }
  };
}

function commandShell(commands: string[]): ShellSpec {
  if (process.platform === "win32") {
    const command = process.env.AGENT_HERO_SHELL?.trim() || process.env.AGENT_CONTROL_SHELL?.trim() || "powershell.exe";
    const name = shellName(command);
    if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") {
      return {
        command,
        args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", powershellSequence(commands)]
      };
    }
    return {
      command,
      args: ["/d", "/s", "/c", commands.map((item) => `(${item}) || exit /b %errorlevel%`).join(" && ")]
    };
  }
  const command = process.env.AGENT_HERO_SHELL || process.env.AGENT_CONTROL_SHELL || process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "bash");
  return {
    command,
    args: ["-lc", bashSequence(commands)]
  };
}

function historyPathForProject(projectId?: string): string {
  mkdirSync(terminalHistoryDir, { recursive: true });
  return path.join(terminalHistoryDir, `${projectId || "global"}.history`);
}

function defaultShell(historyPath: string, project?: Project): ShellSpec {
  if (project && isWslProject(project)) {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoExit", "-Command", powershellWslCommand(project)]
    };
  }
  if (process.platform === "win32") {
    const command = process.env.AGENT_HERO_SHELL?.trim() || process.env.AGENT_CONTROL_SHELL?.trim() || "powershell.exe";
    const name = shellName(command);
    if (name === "powershell.exe" || name === "pwsh.exe" || name === "powershell" || name === "pwsh") {
      return {
        command,
        args: [
          "-NoLogo",
          "-NoExit",
          "-Command",
          `try { Set-PSReadLineOption -HistorySavePath ${powershellString(historyPath)} -HistorySaveStyle SaveIncrementally } catch { }`
        ]
      };
    }
    return {
      command,
      args: []
    };
  }
  const command = process.env.AGENT_HERO_SHELL || process.env.AGENT_CONTROL_SHELL || process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "bash");
  const existingPromptCommand = process.env.PROMPT_COMMAND;
  const promptCommand = existingPromptCommand
    ? `history -a; history -n; ${existingPromptCommand}`
    : "history -a; history -n";
  return {
    command,
    args: [],
    env: {
      HISTFILE: historyPath,
      HISTSIZE: "5000",
      HISTFILESIZE: "10000",
      PROMPT_COMMAND: promptCommand
    }
  };
}

export class TerminalManager {
  private terminals = new Map<string, TerminalState>();

  constructor(
    private readonly projects: () => Project[],
    private readonly broadcast: (event: WsServerEvent) => void
  ) {}

  snapshot(): TerminalSnapshot {
    return {
      sessions: Array.from(this.terminals.values()).map((state) => state.session),
      output: Object.fromEntries(Array.from(this.terminals.values()).map((state) => [state.session.id, state.output]))
    };
  }

  start(
    projectId?: string,
    cols = DEFAULT_COLS,
    rows = DEFAULT_ROWS,
    initialCommand?: string,
    title?: string,
    options: TerminalStartOptions = {}
  ): TerminalSession {
    const project = projectId ? this.projects().find((candidate) => candidate.id === projectId) : undefined;
    const commands = Array.isArray(options.commands) ? options.commands.map((command) => command.trim()).filter(Boolean) : [];
    const customCwd = options.cwd?.trim();
    const shell = commands.length ? commandShell(commands) : defaultShell(historyPathForProject(project?.id || projectId), project);
    const cwd = project && isWslProject(project)
      ? wslProjectPath(project)
      : existingDirectory(customCwd) || existingDirectory(project?.path) || existingDirectory(process.cwd()) || os.homedir();
    const timestamp = now();
    let pty: TerminalProcess | undefined;
    let startedShell = shell;
    let startedCwd = cwd;
    const errors: string[] = [];
    for (const attempt of ptyStartAttempts(shell, cwd, commands)) {
      try {
        pty = spawnPty(attempt.shell.command, attempt.shell.args, {
          name: "xterm-256color",
          cols,
          rows,
          cwd: project && isWslProject(project) ? process.cwd() : attempt.cwd,
          env: { ...envForPty(), ...attempt.shell.env }
        });
        startedShell = attempt.shell;
        startedCwd = attempt.cwd;
        break;
      } catch (error) {
        errors.push(`${attempt.shell.command} in ${attempt.cwd}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!pty) {
      if (process.platform === "darwin") {
        try {
          const fallbackEnv = { ...envForPty(), ...shell.env };
          pty = spawnScriptFallback(shell, cwd, fallbackEnv);
          startedShell = { command: "/usr/bin/script", args: [shell.command, ...shell.args], env: shell.env };
          startedCwd = cwd;
          errors.push("/usr/bin/script fallback started");
        } catch (error) {
          errors.push(`/usr/bin/script fallback in ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (!pty) {
      throw new Error(`Unable to start terminal. Tried ${errors.join("; ")}`);
    }
    const session: TerminalSession = {
      id: nanoid(10),
      requestId: options.requestId,
      hidden: options.hidden,
      title,
      projectId: project?.id,
      projectName: project?.name,
      cwd: startedCwd,
      shell: startedShell.command,
      cols,
      rows,
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp
    };
    const state: TerminalState = {
      session,
      process: pty,
      output: [`\x1b[36m${session.shell} started in ${session.cwd}${os.EOL}\x1b[0m`],
      pending: "",
      pendingBytes: 0,
      flushTimer: null,
      flush: () => {}
    };
    state.flush = () => {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (!state.pending) return;
      const chunk = state.pending;
      state.pending = "";
      state.pendingBytes = 0;
      state.output.push(chunk);
      if (state.output.length > MAX_OUTPUT_CHUNKS) {
        state.output.splice(0, state.output.length - MAX_OUTPUT_CHUNKS);
      }
      state.session.updatedAt = now();
      this.broadcast({ type: "terminal.output", id: session.id, chunk, updatedAt: state.session.updatedAt });
    };
    this.terminals.set(session.id, state);

    pty.onData((chunk) => {
      state.pending += chunk;
      state.pendingBytes += chunk.length;
      if (state.pendingBytes >= OUTPUT_FLUSH_BYTES) {
        state.flush();
        return;
      }
      if (!state.flushTimer) {
        state.flushTimer = setTimeout(state.flush, OUTPUT_FLUSH_MS);
      }
    });

    pty.onExit(({ exitCode, signal }) => {
      state.flush();
      state.session = {
        ...state.session,
        status: "exited",
        exitCode,
        signal,
        updatedAt: now()
      };
      this.broadcast({ type: "terminal.exited", id: session.id, exitCode, signal, updatedAt: state.session.updatedAt });
    });

    this.broadcast({ type: "terminal.started", session, output: state.output });
    if (!commands.length && initialCommand?.trim()) {
      pty.write(`${initialCommand.trim()}${process.platform === "win32" ? "\r" : "\n"}`);
    }
    return session;
  }

  input(id: string, input: string): void {
    const state = this.terminals.get(id);
    if (!state || state.session.status !== "running") return;
    state.process.write(input);
  }

  resize(id: string, cols: number, rows: number): void {
    const state = this.terminals.get(id);
    if (!state || state.session.status !== "running") return;
    const nextCols = Math.max(20, Math.min(400, Math.floor(cols)));
    const nextRows = Math.max(5, Math.min(120, Math.floor(rows)));
    state.process.resize(nextCols, nextRows);
    state.session = {
      ...state.session,
      cols: nextCols,
      rows: nextRows,
      updatedAt: now()
    };
  }

  kill(id: string): void {
    const state = this.terminals.get(id);
    if (!state || state.session.status !== "running") return;
    state.process.kill();
  }

  clear(id: string): void {
    const state = this.terminals.get(id);
    if (!state) return;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.pending = "";
    state.pendingBytes = 0;
    state.output = [];
    state.session.updatedAt = now();
    this.broadcast({ type: "terminal.cleared", id });
  }

  close(id: string): void {
    const state = this.terminals.get(id);
    if (!state) return;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.pending = "";
    state.pendingBytes = 0;
    this.terminals.delete(id);
    if (state.session.status === "running") {
      state.process.kill();
    }
    this.broadcast({ type: "terminal.closed", id });
  }

  closeProject(projectId: string): void {
    const ids = Array.from(this.terminals.values())
      .filter((state) => state.session.projectId === projectId)
      .map((state) => state.session.id);
    for (const id of ids) this.close(id);
  }

  rename(id: string, title?: string): void {
    const state = this.terminals.get(id);
    if (!state) return;
    const trimmed = title?.trim();
    state.session = {
      ...state.session,
      title: trimmed || undefined,
      updatedAt: now()
    };
    this.broadcast({ type: "terminal.renamed", id, title: state.session.title, updatedAt: state.session.updatedAt });
  }
}
