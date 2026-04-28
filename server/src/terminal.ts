import os from "node:os";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { spawn as spawnPty, type IPty } from "node-pty";
import type { Project, TerminalSession, TerminalSnapshot, WsServerEvent } from "@agent-control/shared";

const MAX_OUTPUT_CHUNKS = 2000;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const terminalHistoryDir = path.join(os.homedir(), ".agent-dashboard", "terminal-history");

interface ShellSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface TerminalState {
  session: TerminalSession;
  process: IPty;
  output: string[];
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

function historyPathForProject(projectId?: string): string {
  mkdirSync(terminalHistoryDir, { recursive: true });
  return path.join(terminalHistoryDir, `${projectId || "global"}.history`);
}

function defaultShell(historyPath: string): ShellSpec {
  if (process.platform === "win32") {
    const command = process.env.AGENT_CONTROL_SHELL || process.env.SHELL || "powershell.exe";
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
  const command = process.env.AGENT_CONTROL_SHELL || process.env.SHELL || "bash";
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

  start(projectId?: string, cols = DEFAULT_COLS, rows = DEFAULT_ROWS): TerminalSession {
    const project = projectId ? this.projects().find((candidate) => candidate.id === projectId) : undefined;
    const shell = defaultShell(historyPathForProject(project?.id || projectId));
    const timestamp = now();
    const session: TerminalSession = {
      id: nanoid(10),
      projectId: project?.id,
      projectName: project?.name,
      cwd: project?.path || process.cwd(),
      shell: shell.command,
      cols,
      rows,
      status: "running",
      startedAt: timestamp,
      updatedAt: timestamp
    };
    const pty = spawnPty(shell.command, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: session.cwd,
      env: { ...envForPty(), ...shell.env }
    });
    const state: TerminalState = {
      session,
      process: pty,
      output: [`\x1b[36m${shell.command} started in ${session.cwd}${os.EOL}\x1b[0m`]
    };
    this.terminals.set(session.id, state);

    pty.onData((chunk) => {
      state.output.push(chunk);
      if (state.output.length > MAX_OUTPUT_CHUNKS) {
        state.output.splice(0, state.output.length - MAX_OUTPUT_CHUNKS);
      }
      state.session.updatedAt = now();
      this.broadcast({ type: "terminal.output", id: session.id, chunk });
    });

    pty.onExit(({ exitCode, signal }) => {
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
    state.output = [];
    state.session.updatedAt = now();
    this.broadcast({ type: "terminal.cleared", id });
  }

  close(id: string): void {
    const state = this.terminals.get(id);
    if (!state) return;
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
