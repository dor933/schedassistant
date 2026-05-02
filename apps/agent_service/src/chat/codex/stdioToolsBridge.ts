/**
 * Stdio MCP server that Codex CLI spawns as a subprocess to expose this
 * agent's per-turn tool list to the model.
 *
 * Background
 * ----------
 * Codex CLI 0.128's rmcp client cannot complete a streamable_http MCP
 * handshake against `@modelcontextprotocol/sdk`'s server transport
 * (`Deserialize error: data did not match any variant of untagged enum
 * JsonRpcMessage` on the very first `initialize` response), so the
 * historical `apps/mcp_server` HTTP bridge never delivered any tools to
 * the model. This stdio variant sidesteps the broken HTTP path: Codex
 * spawns this script directly, MCP frames flow over its stdin/stdout,
 * and the rmcp client's stdio transport is well-tested and works.
 *
 * Wiring
 * ------
 * `codexSdkRunner.runOpenAiCodexSdk` mints a per-turn JWT, registers
 * the live `StructuredToolInterface[]` in the in-process tool registry,
 * and configures Codex with:
 *
 *   [mcp_servers.agent_tools]
 *   command = "node"
 *   args    = [".../dist/chat/codex/stdioToolsBridge.js"]
 *   env     = { MCP_BRIDGE_JWT = "<jwt>" }
 *
 * The spawned process reads the JWT from `process.env.MCP_BRIDGE_JWT`,
 * advertises an MCP server over `StdioServerTransport`, and forwards
 * `tools/list` / `tools/call` to the agent_service back-channel
 * (`/internal/tools/*`). Same JWT, same registry lookup, same per-turn
 * authorization — only the transport between Codex and this process
 * changed.
 *
 * Why not import the existing `mcp_server/src/agentServiceClient`?
 * ----------------------------------------------------------------
 * That package is a separate workspace targeting its own container
 * image. Duplicating the small fetch wrapper here keeps this file free
 * of a workspace import and lets the `mcp_server` package be deleted
 * cleanly once stdio adoption is complete.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

const SERVER_INFO = {
  name: "scheduling-agent-tool-bridge",
  version: "1.0.0",
};

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://127.0.0.1:3001";

interface ListToolsResponse {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: {
      type: "object";
      properties?: Record<string, object>;
      required?: string[];
      [k: string]: unknown;
    };
  }>;
}

interface CallToolResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/**
 * Maps a back-channel HTTP failure to a JSON-RPC error code. The codes
 * mirror what `apps/mcp_server`'s HTTP bridge produced so existing
 * client-side error handling on the Codex side keeps working.
 */
type ErrKind = "unauthorized" | "registry_expired" | "forbidden" | "transport";

class BackchannelError extends Error {
  readonly kind: ErrKind;
  readonly status: number | null;
  constructor(kind: ErrKind, status: number | null, msg: string) {
    super(msg);
    this.kind = kind;
    this.status = status;
  }
}

function classify(status: number, body: string): BackchannelError {
  if (status === 401) return new BackchannelError("unauthorized", status, body);
  if (status === 403) return new BackchannelError("forbidden", status, body);
  if (status === 410)
    return new BackchannelError("registry_expired", status, body);
  return new BackchannelError("transport", status, body);
}

function toJsonRpcError(err: BackchannelError): { code: number; message: string } {
  switch (err.kind) {
    case "unauthorized":
      return { code: -32001, message: "Unauthorized" };
    case "forbidden":
      return { code: -32001, message: "Forbidden: tool not allowed" };
    case "registry_expired":
      return {
        code: -32000,
        message: "Tool registry expired — the originating turn has ended.",
      };
    case "transport":
    default:
      return {
        code: -32000,
        message: `Bridge transport error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`,
      };
  }
}

async function postJson<T>(
  path: string,
  bearer: string,
  body: Record<string, unknown>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${AGENT_SERVICE_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new BackchannelError(
      "transport",
      null,
      err instanceof Error ? err.message : String(err),
    );
  }
  const text = await res.text();
  if (!res.ok) throw classify(res.status, text || res.statusText);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BackchannelError(
      "transport",
      res.status,
      `agent_service returned non-JSON response from ${path}`,
    );
  }
}

function getBearer(): string {
  const t = process.env.MCP_BRIDGE_JWT;
  if (!t || typeof t !== "string" || t.length === 0) {
    // Stderr is captured by Codex into its own log but never reaches the
    // model. Exit non-zero so Codex marks the server as failed-to-launch
    // rather than letting it deadlock waiting for stdin frames.
    process.stderr.write(
      "[stdioToolsBridge] MCP_BRIDGE_JWT env not set — refusing to start.\n",
    );
    process.exit(1);
  }
  return t;
}

function buildServer(bearer: string): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(
    ListToolsRequestSchema,
    async (): Promise<ListToolsResult> => {
      try {
        const { tools } = await postJson<ListToolsResponse>(
          "/internal/tools/list",
          bearer,
          {},
        );
        // Same defensive normalisation `apps/mcp_server` did: zod-to-json-schema
        // for empty objects can omit `type:"object"`. MCP's tool schema validator
        // rejects that, so re-inject it.
        const normalised: ListToolsResult["tools"] = tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema:
            t.inputSchema && t.inputSchema.type === "object"
              ? t.inputSchema
              : { ...(t.inputSchema ?? {}), type: "object" as const },
        }));
        return { tools: normalised };
      } catch (err) {
        if (err instanceof BackchannelError) {
          const { code, message } = toJsonRpcError(err);
          throw Object.assign(new Error(message), { code });
        }
        throw err;
      }
    },
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await postJson<CallToolResponse>(
          "/internal/tools/call",
          bearer,
          { name, arguments: args },
        );
        return {
          content: result.content,
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (err) {
        if (err instanceof BackchannelError) {
          const { code, message } = toJsonRpcError(err);
          throw Object.assign(new Error(message), { code });
        }
        throw err;
      }
    },
  );

  return server;
}

async function main(): Promise<void> {
  const bearer = getBearer();
  const server = buildServer(bearer);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Lifetime: Codex closes our stdin when the turn ends. The SDK's
  // StdioServerTransport handles that by ending the process implicitly
  // — no manual cleanup needed.
}

main().catch((err) => {
  process.stderr.write(
    `[stdioToolsBridge] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
