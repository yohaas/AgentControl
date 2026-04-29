import { readFileSync } from "node:fs";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const agentId = process.env.AGENTCONTROL_AGENT_ID || "";
const token = process.env.AGENTCONTROL_PERMISSION_TOKEN || "";
const permissionUrl = process.env.AGENTCONTROL_PERMISSION_URL || "http://127.0.0.1:4317/api/permissions/request";

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: JsonRpcMessage["id"], value: unknown): void {
  write({ jsonrpc: "2.0", id, result: value });
}

function error(id: JsonRpcMessage["id"], code: number, message: string): void {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

function textResult(text: string) {
  return {
    content: [
      {
        type: "text",
        text
      }
    ]
  };
}

async function requestPermission(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const toolName = typeof args.tool_name === "string" ? args.tool_name : typeof args.toolName === "string" ? args.toolName : "tool";
  const toolUseId =
    typeof args.tool_use_id === "string" ? args.tool_use_id : typeof args.toolUseId === "string" ? args.toolUseId : "";
  const input = args.input ?? {};
  if (!agentId || !token || !toolUseId) {
    return {
      behavior: "deny",
      message: "AgentControl permission prompt was not initialized."
    };
  }

  const body = JSON.stringify({
    agentId,
    token,
    toolName,
    toolUseId,
    input
  });
  const response = await postPermissionRequest(body);
  if (!response.ok) {
    return {
      behavior: "deny",
      message: `AgentControl permission prompt failed with HTTP ${response.status}.`
    };
  }
  return (await response.json()) as Record<string, unknown>;
}

async function postPermissionRequest(body: string): Promise<Response> {
  const urls = permissionRequestUrls(permissionUrl);
  const errors: string[] = [];
  for (const url of urls) {
    try {
      return await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body
      });
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`AgentControl permission callback failed. Tried ${errors.join("; ")}`);
}

function permissionRequestUrls(primary: string): string[] {
  const urls = new Set<string>([primary]);
  let parsed: URL;
  try {
    parsed = new URL(primary);
  } catch {
    return [...urls];
  }

  const hosts = ["127.0.0.1", "localhost", "::1", "host.docker.internal", wslHostIp()].filter((host): host is string => Boolean(host));
  for (const host of hosts) {
    const next = new URL(parsed);
    next.hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
    urls.add(next.toString());
  }
  return [...urls];
}

function wslHostIp(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const resolv = readFileSync("/etc/resolv.conf", "utf8");
    return resolv.match(/^nameserver\s+([^\s]+)/m)?.[1];
  } catch {
    return undefined;
  }
}

async function handle(message: JsonRpcMessage): Promise<void> {
  if (message.id === undefined || message.id === null) return;

  switch (message.method) {
    case "initialize":
      result(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "agentcontrol-permissions",
          version: "0.1.0"
        }
      });
      return;
    case "tools/list":
      result(message.id, {
        tools: [
          {
            name: "approval_prompt",
            description: "Ask AgentControl to approve or deny a Claude Code tool permission request.",
            inputSchema: {
              type: "object",
              properties: {
                tool_name: { type: "string" },
                input: { type: "object" },
                tool_use_id: { type: "string" }
              },
              required: ["tool_name", "input", "tool_use_id"]
            }
          }
        ]
      });
      return;
    case "tools/call": {
      const params = message.params || {};
      const name = typeof params.name === "string" ? params.name : "";
      if (name !== "approval_prompt") {
        error(message.id, -32602, "Unknown tool.");
        return;
      }
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      const decision = await requestPermission(args).catch((requestError: unknown) => ({
        behavior: "deny",
        message: requestError instanceof Error ? requestError.message : String(requestError)
      }));
      result(message.id, textResult(JSON.stringify(decision)));
      return;
    }
    default:
      error(message.id, -32601, "Method not found.");
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      void handle(JSON.parse(trimmed) as JsonRpcMessage);
    } catch (parseError) {
      error(null, -32700, parseError instanceof Error ? parseError.message : String(parseError));
    }
  }
});
