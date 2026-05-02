/**
 * Bridge between the existing LangChain `StructuredToolInterface[]` tool layer
 * and the Claude Agent SDK in-process MCP server.
 *
 * Why an in-process MCP server (over a stdio child) for the first cut:
 *   1. Every existing tool factory closes over per-request state — agent id,
 *      user id, thread id, group id. Spawning a separate MCP server process
 *      would require us to either re-resolve all of that on the other side
 *      (duplicating service code) or pass it across an RPC boundary on every
 *      tool call. Keeping the tools in-process avoids both.
 *   2. The session-file ledger (`drainSessionFileLedger`) lives in the same
 *      Node process — a forked MCP server would not be able to reach it.
 *   3. DB connections and Sequelize models are already initialized here.
 *
 * If we ever want to share the same tools with non-Anthropic vendors via the
 * legacy LangChain path AND with the Agent SDK path simultaneously, we can
 * later promote this to a real subprocess MCP server (per `agentsSdkMigration.md`
 * §10). Until then the legacy path keeps using the raw `StructuredToolInterface[]`
 * and the SDK path sees the same instances re-presented as MCP tools — one
 * source of truth for tool behavior.
 */

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";

import { loadClaudeAgentSdk } from "./agentSdkLoader";
import { logger } from "../../logger";

/**
 * Server name used in the SDK's `mcpServers` map. Tool names exposed to the
 * model are therefore `mcp__agent_tools__<tool_name>` — that prefix is what
 * the runner uses to build `allowedTools`.
 */
export const AGENT_TOOLS_MCP_SERVER_NAME = "agent_tools";

/** Max characters for a single tool result before we truncate. Mirrors the
 * legacy loop's `MAX_TOOL_RESULT_CHARS` so behavior parity is preserved. */
const MAX_TOOL_RESULT_CHARS = 10_000;

/**
 * Sanitizes a tool result string before passing it back to the model:
 * - Truncates excessively long results to prevent context bloat.
 * - Detects error-shaped responses and prefixes them clearly so the model
 *   does not hallucinate from them.
 *
 * Same policy as `sanitizeToolResult` in `basicGraph/nodes/callModel.ts` — kept
 * in sync intentionally.
 */
function sanitizeToolResultText(content: string, toolName: string): string {
  const looksLikeError =
    /^(Error:|ERROR:|HTTP\s+[45]\d\d|status\s*:\s*[45]\d\d|ECONNREFUSED|ETIMEDOUT|ENOTFOUND)/i.test(
      content.trim(),
    );
  if (looksLikeError && !content.startsWith("[TOOL ERROR]")) {
    content = `[TOOL ERROR] ${content}`;
  }

  if (content.length > MAX_TOOL_RESULT_CHARS) {
    const truncated = content.slice(0, MAX_TOOL_RESULT_CHARS);
    content =
      truncated +
      `\n\n[TRUNCATED — result was ${content.length.toLocaleString()} chars, showing first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}. ` +
      `Tool: ${toolName}. If you need more detail, narrow your query.]`;
  }

  return content;
}

/**
 * Renders any non-string tool return value into a string the model can
 * consume. Mirrors the shape-coercion rules used in the legacy tool loop:
 *   - string                    → as-is
 *   - [string, artifacts]       → first element (MCP tools return tuples)
 *   - object                    → JSON.stringify
 *   - other                     → String(value)
 */
function coerceToolResultToString(rawResult: unknown): string {
  if (typeof rawResult === "string") return rawResult;
  if (
    Array.isArray(rawResult) &&
    rawResult.length > 0 &&
    typeof rawResult[0] === "string"
  ) {
    return rawResult[0];
  }
  if (rawResult != null && typeof rawResult === "object") {
    try {
      return JSON.stringify(rawResult);
    } catch {
      return String(rawResult);
    }
  }
  return String(rawResult ?? "");
}

/**
 * Best-effort extraction of the schema "shape" object that `tool()` from the
 * Agent SDK expects. The SDK signature wants `Record<string, ZodType>` (the
 * raw Zod object shape). Two real-world inputs we have to handle:
 *
 *  - **`ZodObject`** — typical for our hand-built tool factories
 *    (`ConsultAgentTool`, `DelegateToDeepAgentTool`, etc.). We read its
 *    `.shape` directly.
 *
 *  - **Raw JSON Schema** (`{ type: "object", properties, required }`) —
 *    `@langchain/mcp-adapters` puts the JSON Schema from MCP's `tools/list`
 *    response into `tool.schema` AS-IS, even though the
 *    `StructuredToolInterface` typings say it should be a Zod type. The
 *    SDK can't introspect a JSON Schema as a Zod shape, so the model sees
 *    no required fields and produces ad-hoc args, which LangChain's own
 *    internal validation then rejects with "Received tool input did not
 *    match expected schema". We convert the JSON Schema's `properties`
 *    into a corresponding Zod shape so the model gets the real field
 *    spec and LangChain accepts the resulting args.
 *
 *  - Anything else → empty shape + warn. The tool will receive `{}` and
 *    must handle defensively.
 */
function extractZodShape(
  schema: unknown,
  toolName: string,
): Record<string, z.ZodTypeAny> {
  if (
    schema != null &&
    typeof schema === "object" &&
    "shape" in (schema as Record<string, unknown>)
  ) {
    const shape = (schema as { shape: unknown }).shape;
    if (shape != null && typeof shape === "object") {
      return shape as Record<string, z.ZodTypeAny>;
    }
  }
  if (
    schema != null &&
    typeof schema === "object" &&
    (schema as Record<string, unknown>).type === "object" &&
    typeof (schema as Record<string, unknown>).properties === "object"
  ) {
    return jsonSchemaObjectToZodShape(schema as Record<string, unknown>);
  }
  logger.warn("Agent SDK adapter: tool schema is not a ZodObject or JSON Schema — registering with empty shape", {
    toolName,
  });
  return {};
}

/**
 * Converts a JSON Schema `object` (with `properties` and `required`) into a
 * `Record<string, ZodType>` shape suitable for the Agent SDK's `tool()`.
 * Recursively handles nested object/array properties. Keeps unknown keyword
 * cases permissive (`z.unknown()`) so a quirky MCP server schema doesn't
 * crash the registration — the tool's own server-side validation is the
 * authoritative check on tool-call values.
 */
function jsonSchemaObjectToZodShape(
  jsonSchema: Record<string, unknown>,
): Record<string, z.ZodTypeAny> {
  const props = (jsonSchema.properties as Record<string, unknown>) ?? {};
  const required = new Set(
    Array.isArray(jsonSchema.required) ? (jsonSchema.required as string[]) : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, def] of Object.entries(props)) {
    const baseType = jsonSchemaPropertyToZod(def);
    shape[key] = required.has(key) ? baseType : baseType.optional();
  }
  return shape;
}

function jsonSchemaPropertyToZod(def: unknown): z.ZodTypeAny {
  if (!def || typeof def !== "object") return z.unknown();
  const d = def as Record<string, unknown>;
  const description =
    typeof d.description === "string" ? d.description : undefined;

  // Some MCP schemas use `enum` with a string list. Map those to z.enum
  // (LangChain validates strictly so the enum form matches the actual
  // tool's expectations).
  if (Array.isArray(d.enum) && d.enum.every((v) => typeof v === "string")) {
    const values = d.enum as [string, ...string[]];
    if (values.length > 0) {
      const zod = z.enum(values as [string, ...string[]]);
      return description ? zod.describe(description) : zod;
    }
  }

  let zod: z.ZodTypeAny;
  switch (d.type) {
    case "string":
      zod = z.string();
      break;
    case "number":
      zod = z.number();
      break;
    case "integer":
      zod = z.number().int();
      break;
    case "boolean":
      zod = z.boolean();
      break;
    case "array":
      zod = z.array(jsonSchemaPropertyToZod(d.items));
      break;
    case "object":
      if (d.properties && typeof d.properties === "object") {
        zod = z.object(jsonSchemaObjectToZodShape(d)).passthrough();
      } else {
        zod = z.record(z.unknown());
      }
      break;
    case "null":
      zod = z.null();
      break;
    default:
      // No type or unrecognized type — accept anything. The tool's own
      // server-side validation is the source of truth.
      zod = z.unknown();
  }
  return description ? zod.describe(description) : zod;
}

/**
 * Optional callback invoked after every successful tool execution with the
 * (possibly-sanitized) result text. Used by the epic graph to detect the
 * `[EPIC_CONTINUATION]` marker without leaking that domain concept into the
 * runner itself.
 */
export type ToolResultObserver = (result: {
  toolName: string;
  text: string;
  argsSummary: string;
}) => void;

/**
 * Builds an Agent SDK MCP server config from a list of LangChain structured
 * tools. The returned object is suitable for spreading into the `mcpServers`
 * map passed to `query({ options })`.
 *
 * Each tool is wrapped so that:
 *  - errors during invocation are caught and surfaced as `[TOOL ERROR] ...`
 *    text content (the SDK will route them back to the model).
 *  - long results are truncated.
 *  - the optional observer is notified with the final text so callers can
 *    inspect tool output without re-running the tool.
 */
export async function createAgentToolsMcpServer(
  tools: StructuredToolInterface[],
  observer?: ToolResultObserver,
  serverName: string = AGENT_TOOLS_MCP_SERVER_NAME,
): Promise<McpSdkServerConfigWithInstance> {
  const sdk = await loadClaudeAgentSdk();
  const sdkTools = tools.map((t) =>
    sdk.tool(
      t.name,
      typeof t.description === "string" ? t.description : "",
      extractZodShape(t.schema, t.name),
      async (args: Record<string, unknown>) => {
        let text: string;
        try {
          const rawResult = await t.invoke(args ?? {});
          text = coerceToolResultToString(rawResult);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Log the args alongside the error so the operator can see what
          // the model produced when LangChain rejects with the generic
          // "Received tool input did not match expected schema" message.
          // Truncated to keep the log line bounded.
          let argsForLog: string;
          try {
            argsForLog = JSON.stringify(args ?? {});
          } catch {
            argsForLog = "(unserializable)";
          }
          if (argsForLog.length > 800) argsForLog = argsForLog.slice(0, 800) + "…";
          logger.error("Agent SDK tool invocation failed", {
            tool: t.name,
            error: msg,
            args: argsForLog,
          });
          text = `[TOOL ERROR] ${msg}`;
        }

        text = sanitizeToolResultText(text, t.name);

        if (observer) {
          let argsSummary: string;
          try {
            argsSummary = JSON.stringify(args ?? {});
          } catch {
            argsSummary = "(unserializable)";
          }
          if (argsSummary.length > 400) {
            argsSummary = argsSummary.slice(0, 400) + "…";
          }
          try {
            observer({ toolName: t.name, text, argsSummary });
          } catch (obsErr) {
            // Observer failures must never break a tool result.
            logger.warn("Agent SDK tool result observer threw", {
              tool: t.name,
              error: obsErr instanceof Error ? obsErr.message : String(obsErr),
            });
          }
        }

        return {
          content: [{ type: "text", text }],
        };
      },
    ),
  );

  return sdk.createSdkMcpServer({
    name: serverName,
    version: "1.0.0",
    tools: sdkTools,
  });
}

/**
 * Variant of `buildAllowedToolsFromTools` that targets a custom server name.
 * Used by the sub-agent builder so each sub-agent's tools are listed under
 * its own namespaced server (`mcp__sys_<id>__<tool>`), not the primary's
 * default `agent_tools` namespace.
 */
export function buildAllowedToolsForServer(
  tools: StructuredToolInterface[],
  serverName: string,
): string[] {
  return tools.map((t) => `mcp__${serverName}__${t.name}`);
}

/**
 * Builds the `allowedTools` array for a `query()` call from a list of tool
 * names. The Agent SDK enforces this allowlist server-side — tools not in
 * the list are rejected before invocation. We build it explicitly (rather
 * than using a wildcard) so the Anthropic-side surface matches exactly the
 * tools we registered in the in-process MCP server.
 */
export function buildAllowedToolsFromTools(
  tools: StructuredToolInterface[],
): string[] {
  return tools.map((t) => `mcp__${AGENT_TOOLS_MCP_SERVER_NAME}__${t.name}`);
}
