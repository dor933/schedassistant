import { logger } from "../../logger";

/**
 * Admin-side proxy for the agent_service Codex CLI API key. Mirrors
 * `claudeOauth.service.ts` — the key is persisted on the agent_service
 * container so it can be inherited by the spawned `codex` CLI as
 * OPENAI_API_KEY, and only that service can read/write the file.
 *
 * Access control is enforced upstream by `requireSuperAdmin`; this service
 * does not re-authenticate.
 */

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export interface CodexApiKeyStatus {
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

export class CodexApiKeyService {
  async get(): Promise<CodexApiKeyStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/codex-api-key`);
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    return (await resp.json()) as CodexApiKeyStatus;
  }

  async set(token: string): Promise<CodexApiKeyStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/codex-api-key`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const status = (await resp.json()) as CodexApiKeyStatus;
    logger.info("Codex API key updated via admin UI");
    return status;
  }

  async remove(): Promise<CodexApiKeyStatus> {
    const resp = await fetch(`${AGENT_SERVICE_URL}/api/system/codex-api-key`, {
      method: "DELETE",
    });
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    const status = (await resp.json()) as CodexApiKeyStatus;
    logger.info("Codex API key cleared via admin UI");
    return status;
  }
}
