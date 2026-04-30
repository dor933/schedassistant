import type { Request, Response } from "express";
import { invokeApplicationAgentForExternalUser } from "../services/application.service";
import { getApplicationGraph } from "../deps";
import { logger } from "../logger";

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
   * Service-to-service auth (header `x-application-agent-token`) is enforced
   * by `requireApplicationToken` middleware applied at the router.
   *
   * Synchronous: blocks until the inner deep agent finishes, then returns
   * the final assistant text plus the resolved internal `userId` and
   * `threadId` (useful for the upstream client to surface in its UI / logs).
   */
  invoke = async (req: Request, res: Response) => {
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
