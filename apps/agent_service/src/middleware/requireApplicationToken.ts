import type { Request, Response, NextFunction } from "express";

const APPLICATION_AGENT_TOKEN_HEADER = "x-application-agent-token";

/**
 * Shared-secret service-to-service auth for the `/api/application/*` and
 * `/api/ask-grahamy` routes. Compares the `x-application-agent-token` header
 * against `APPLICATION_AGENT_API_TOKEN`. Fail-closed: if the env var is
 * missing or empty, every request is rejected — beats accidental public
 * exposure if the secret isn't wired up.
 *
 * To onboard additional client apps, replace this with a per-token lookup
 * against `client_applications.api_token_hash`.
 */
export function requireApplicationToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expected = process.env.APPLICATION_AGENT_API_TOKEN;
  if (!expected || expected.trim().length === 0) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  const provided = req.header(APPLICATION_AGENT_TOKEN_HEADER);
  if (typeof provided !== "string" || provided !== expected) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  next();
}
