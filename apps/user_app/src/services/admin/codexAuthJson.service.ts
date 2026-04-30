import { logger } from "../../logger";

/**
 * Admin-side proxy for the agent_service Codex CLI `auth.json`. Sibling
 * of `codexApiKey.service.ts` — same agent_service-as-source-of-truth
 * model, just for the structured ChatGPT-account login blob instead of
 * the simpler API key.
 *
 * Access control is enforced upstream by `requireSuperAdmin`.
 */

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export interface CodexAuthJsonStatus {
  configured: boolean;
  accountIdSuffix: string | null;
  accessTokenMasked: string | null;
  hasRefreshToken: boolean;
  hasOpenaiApiKey: boolean;
  lastRefresh: string | null;
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

export class CodexAuthJsonService {
  async get(): Promise<CodexAuthJsonStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/codex-auth-json`);
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    return (await resp.json()) as CodexAuthJsonStatus;
  }

  async set(blob: string | Record<string, unknown>): Promise<CodexAuthJsonStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/codex-auth-json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob }),
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const status = (await resp.json()) as CodexAuthJsonStatus;
    logger.info("Codex auth.json updated via admin UI");
    return status;
  }

  async remove(): Promise<CodexAuthJsonStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/codex-auth-json`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const status = (await resp.json()) as CodexAuthJsonStatus;
    logger.info("Codex auth.json cleared via admin UI");
    return status;
  }
}
