import type { Request, Response } from "express";
import { invokeApplicationAgentForExternalUser } from "../services/application.service";
import { getApplicationGraph } from "../deps";
import { logger } from "../logger";

/**
 * Header used for shared-secret auth on application-agent invocations.
 * The token is configured server-side via the APPLICATION_AGENT_API_TOKEN
 * env var. Trust model: callers run inside the same docker-compose network,
 * so a single shared token is sufficient for v1.
 *
 * To onboard a second client app, replace this with a per-token lookup
 * against `client_applications.api_token_hash`.
 */
const APPLICATION_AGENT_TOKEN_HEADER = "x-application-agent-token";

function isAuthorized(req: Request): boolean {
  const expected = process.env.APPLICATION_AGENT_API_TOKEN;
  // Fail-closed: if no token is configured, deny — beats accidental public
  // exposure if the env var is missing.
  if (!expected || expected.trim().length === 0) return false;

  const provided = req.header(APPLICATION_AGENT_TOKEN_HEADER);
  return typeof provided === "string" && provided === expected;
}

export class ApplicationController {
  /**
   * POST /api/application/:agentId/invoke
   *
   * Body:
   *   {
   *     "input": "...",                                 // required
   *     "externalUserId": "<client-app user id>",       // required, string
   *     "userMetadata": {                               // optional
   *       "displayName": "...",
   *       "email": "...",
   *       "extra": { ... }
   *     }
   *   }
   *
   * Header: x-application-agent-token: <APPLICATION_AGENT_API_TOKEN>
   *
   * Synchronous: blocks until the inner deep agent finishes, then returns
   * the final assistant text plus the resolved internal `userId` and
   * `threadId` (useful for the upstream client to surface in its UI / logs).
   */
  invoke = async (req: Request, res: Response) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ error: "Unauthorized." });
    }

    const agentIdParam = req.params.agentId;
    const agentId = Array.isArray(agentIdParam) ? agentIdParam[0] : agentIdParam;
    const { input, externalUserId, userMetadata } = req.body ?? {};

    if (typeof agentId !== "string" || agentId.length === 0) {
      return res.status(400).json({ error: "Path param 'agentId' is required." });
    }
    if (typeof input !== "string") {
      return res.status(400).json({ error: "Body field 'input' must be a string." });
    }
    if (typeof externalUserId !== "string" || externalUserId.length === 0) {
      return res.status(400).json({
        error: "Body field 'externalUserId' is required and must be a non-empty string.",
      });
    }
    if (userMetadata != null && (typeof userMetadata !== "object" || Array.isArray(userMetadata))) {
      return res.status(400).json({
        error: "Body field 'userMetadata', if present, must be a JSON object.",
      });
    }

    try {
      const graph = getApplicationGraph();
      const result = await invokeApplicationAgentForExternalUser(graph, {
        agentId,
        input,
        externalUserId,
        userMetadata: userMetadata ?? undefined,
      });

      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      return res.json({
        output: result.output,
        userId: result.userId,
        threadId: result.threadId,
      });
    } catch (err: any) {
      logger.error("/api/application invoke handler error", { error: err?.message });
      return res.status(500).json({ error: err?.message ?? "Internal error" });
    }
  };
}
