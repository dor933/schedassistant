/**
 * Loopback routes used by the Codex stdio bridge
 * (`chat/codex/stdioToolsBridge.ts`) to fulfil `tools/list` /
 * `tools/call` requests it receives over MCP from the spawned Codex
 * CLI subprocess.
 *
 * These endpoints are NEVER exposed to a browser — only the in-process
 * stdio bridge talks to them, over loopback (`127.0.0.1:3001`) inside
 * the agent_service container. Authentication is by per-turn JWT (see
 * `codexBridgeAuth`), not by user session: the bridge forwards the same
 * bearer token Codex was given via `mcp_servers.agent_tools.env.MCP_BRIDGE_JWT`.
 * Defense-in-depth: even with the token, the controller still cross-checks
 * `allowedToolNames` and the registry's stored context against the JWT
 * claims.
 *
 * Behavior parity with the in-process tool path
 * --------------------------------------------
 * The truncation + error-tagging logic mirrors
 * `agentSdkAdapter.sanitizeToolResultText` and
 * `coerceToolResultToString` exactly. The intent is that whether a tool
 * runs through the legacy `bindTools` loop, the in-process Anthropic
 * MCP, or this bridge, downstream code that consumes tool results sees
 * the same truncation thresholds, the same `[TOOL ERROR]` prefix, and
 * the same `[TRUNCATED]` footer. The shared regex in particular is
 * load-bearing for the epic graph (`parseContinuationMarker` runs on
 * the same text every path produces).
 */

import type { Request, Response } from "express";

import { logger } from "../logger";
import { verifyTurnToken, type TurnTokenClaims } from "../chat/codex/codexBridgeAuth";
import { lookup } from "../chat/toolRegistry";

const MAX_TOOL_RESULT_CHARS = 10_000;

/**
 * Same content-coercion rules as the legacy tool loop and the Anthropic
 * adapter. Centralised here so any new transport that lands in the
 * bridge inherits the behaviour automatically.
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
      `\n\n[TRUNCATED — result was ${content.length.toLocaleString()} chars, ` +
      `showing first ${MAX_TOOL_RESULT_CHARS.toLocaleString()}. Tool: ${toolName}. ` +
      `If you need more detail, narrow your query.]`;
  }
  return content;
}

/**
 * Extracts and verifies the bearer token. Returns `null` when missing
 * / malformed / expired — caller should respond 401 without leaking
 * details. The controller does NOT distinguish among failure modes by
 * design: a bridge that's been given a bad token shouldn't learn from
 * the response why.
 */
function authenticate(req: Request): TurnTokenClaims | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!m) return null;
  return verifyTurnToken(m[1]);
}

/**
 * Best-effort args summary for observer payloads. Same contract as
 * `agentSdkAdapter.ts:178` so observers (e.g. epic continuation
 * detection) see the same shape regardless of transport.
 */
function summariseArgs(args: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(args ?? {});
  } catch {
    s = "(unserializable)";
  }
  return s.length > 400 ? s.slice(0, 400) + "…" : s;
}

export class InternalToolsController {
  /**
   * Returns the JSON Schema for every tool the JWT is allowed to call.
   *
   * `mcp_server` calls this once per MCP `tools/list` request from the
   * Codex CLI. The response shape matches MCP's `tools/list` so
   * `mcp_server` can pass it through with minimal massaging.
   */
  
  list = async (req: Request, res: Response): Promise<void> => {
    const claims = authenticate(req);
    if (!claims) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const entry = lookup(claims.registryId);
    if (!entry) {
      // Either the runner crashed before we got here, or the bridge is
      // calling after release. Both look the same to mcp_server: a 410
      // tells it not to retry against this token.
      res.status(410).json({ error: "registry expired" });
      return;
    }

    if (
      entry.context.agentId !== claims.agentId ||
      entry.context.userId !== claims.userId ||
      entry.context.threadId !== claims.threadId ||
      entry.context.source !== claims.source
    ) {
      logger.warn(
        "internalTools.list: claims/registry context mismatch — possible token reuse",
        {
          registryId: claims.registryId,
          claimsContext: {
            agentId: claims.agentId,
            userId: claims.userId,
            threadId: claims.threadId,
            source: claims.source,
          },
          registryContext: entry.context,
        },
      );
      res.status(401).json({ error: "context mismatch" });
      return;
    }

    // Lazy-import zod-to-json-schema so cold-starts that never hit the
    // bridge don't pay the parse cost. The dep is transitively present
    // (LangChain + MCP SDK both depend on it) and pinned in the
    // workspace lockfile.
    const { zodToJsonSchema } = await import("zod-to-json-schema");

    const allowed = new Set(claims.allowedToolNames);

    // `t.schema` is either:
    //   1. A real Zod schema (every tool we hand-build via `tool(...)` —
    //      `consult_agent`, `delegate_to_deep_agent`, etc.). zodToJsonSchema
    //      converts it to JSON Schema.
    //   2. A raw JSON Schema object (every MCP-imported tool —
    //      `@langchain/mcp-adapters` puts the upstream MCP server's
    //      `tools/list` JSON Schema directly on `tool.schema` even
    //      though the LangChain types claim it's Zod). Passing those
    //      to zodToJsonSchema throws `Cannot read properties of
    //      undefined (reading 'typeName')` because the function
    //      reaches for Zod-internal `_def.typeName`.
    //   3. Missing / non-object (defensive).
    // Detect the shape and pass case 2 through unchanged so MCP tools
    // (`run_command`, filesystem ops, etc.) make it to the model.
    const toJsonSchema = (schema: unknown): Record<string, unknown> => {
      if (schema && typeof schema === "object") {
        const obj = schema as Record<string, unknown>;
        // Zod schemas have a `_def` with a `typeName` string.
        const def = obj._def as { typeName?: unknown } | undefined;
        if (def && typeof def.typeName === "string") {
          return zodToJsonSchema(schema as never, {
            target: "openAi",
            $refStrategy: "none",
          }) as Record<string, unknown>;
        }
        // Already a JSON Schema → pass through. Normalise to ensure
        // top-level `type: "object"` so MCP's tool schema validator on
        // the Codex side accepts it (older MCP servers produce shapes
        // that omit `type` for empty-object schemas).
        if (obj.type === "object" || obj.properties || obj.required) {
          return obj.type === "object" ? obj : { ...obj, type: "object" };
        }
      }
      // Fallback: empty object schema. Keeps MCP happy and the tool
      // remains callable with no arguments.
      return { type: "object", properties: {}, additionalProperties: false };
    };

    const tools = entry.tools
      .filter((t) => allowed.has(t.name))
      .map((t) => ({
        name: t.name,
        description: typeof t.description === "string" ? t.description : "",
        inputSchema: toJsonSchema(t.schema),
      }));

    res.json({ tools });
  };

  /**
   * Invokes a single tool by name. Body shape:
   *   { name: string, arguments: Record<string, unknown> }
   *
   * Returns:
   *   200 { content: [{ type: "text", text: string }], isError?: boolean }
   *   400 / 401 / 403 / 404 / 410 with { error: string }
   *
   * The success shape mirrors MCP's `tools/call` result so `mcp_server`
   * can pass it straight through.
   */
  call = async (req: Request, res: Response): Promise<void> => {
    const claims = authenticate(req);
    if (!claims) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const entry = lookup(claims.registryId);
    if (!entry) {
      res.status(410).json({ error: "registry expired" });
      return;
    }

    const body = (req.body ?? {}) as { name?: unknown; arguments?: unknown };
    const toolName = typeof body.name === "string" ? body.name : "";
    if (!toolName) {
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    if (!claims.allowedToolNames.includes(toolName)) {
      // The JWT itself doesn't grant the tool — defense-in-depth even
      // if the registry happens to have it. Logged at warn because a
      // well-behaved bridge would never get here.
      logger.warn("internalTools.call: tool not in JWT allowlist", {
        registryId: claims.registryId,
        toolName,
      });
      res.status(403).json({ error: "tool not allowed for this turn" });
      return;
    }

    const tool = entry.tools.find((t) => t.name === toolName);
    if (!tool) {
      res.status(404).json({ error: "tool not registered" });
      return;
    }

    const args =
      body.arguments && typeof body.arguments === "object"
        ? (body.arguments as Record<string, unknown>)
        : {};

    let text: string;
    let isError = false;
    try {
      const rawResult = await tool.invoke(args);
      text = coerceToolResultToString(rawResult);
    } catch (err) {
      isError = true;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("internalTools.call: tool invocation failed", {
        registryId: claims.registryId,
        toolName,
        error: msg,
      });
      text = `[TOOL ERROR] ${msg}`;
    }

    text = sanitizeToolResultText(text, toolName);

    if (entry.observer) {
      try {
        entry.observer({
          toolName,
          text,
          argsSummary: summariseArgs(args),
        });
      } catch (obsErr) {
        // Observer failures must never break a tool result — same
        // contract as agentSdkAdapter.ts:189.
        logger.warn("internalTools.call: observer threw", {
          registryId: claims.registryId,
          toolName,
          error: obsErr instanceof Error ? obsErr.message : String(obsErr),
        });
      }
    }

    res.json({
      content: [{ type: "text", text }],
      ...(isError ? { isError: true } : {}),
    });
  };
}
