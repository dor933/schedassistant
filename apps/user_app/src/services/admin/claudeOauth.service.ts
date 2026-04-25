import { logger } from "../../logger";

/**
 * Admin-side proxy for the agent_service Claude Code OAuth token. The token
 * is persisted on the agent_service container (so it can be inherited by the
 * spawned `claude` CLI), and only that service can read/write the file —
 * user_app forwards every request.
 *
 * Access control is enforced upstream by `requireSuperAdmin`; this service
 * does not re-authenticate.
 */

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export interface ClaudeOauthTokenStatus {
  configured: boolean;
  masked: string | null;
  updatedAt: string | null;
}

async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string } | null;
    return body?.error ?? `Request failed (${resp.status})`;
  } catch {
    return `Request failed (${resp.status})`;
  }
}

export class ClaudeOauthService {
  async get(): Promise<ClaudeOauthTokenStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/claude-oauth-token`);
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    return (await resp.json()) as ClaudeOauthTokenStatus;
  }

  async set(token: string): Promise<ClaudeOauthTokenStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/claude-oauth-token`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const status = (await resp.json()) as ClaudeOauthTokenStatus;
    logger.info("Claude OAuth token updated via admin UI");
    return status;
  }

  async remove(): Promise<ClaudeOauthTokenStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/claude-oauth-token`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const status = (await resp.json()) as ClaudeOauthTokenStatus;
    logger.info("Claude OAuth token cleared via admin UI");
    return status;
  }
}
