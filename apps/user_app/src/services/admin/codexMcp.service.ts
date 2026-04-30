import { logger } from "../../logger";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

export interface PersistedMcpScript {
  command: string;
  args: string[];
  scriptPath: string;
}

export interface CodexConfigRenderResult {
  path: string;
  serverCount: number;
}

async function readError(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { error?: string } | null;
    return body?.error ?? `Request failed (${resp.status})`;
  } catch {
    return `Request failed (${resp.status})`;
  }
}

export class CliMcpConfigService {
  async persistScript(
    rowId: number,
    scriptContent: string,
  ): Promise<PersistedMcpScript> {
    const resp = await fetch(
      `${AGENT_SERVICE_URL}/api/system/codex-mcp-scripts/${rowId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scriptContent }),
      },
    );
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    return (await resp.json()) as PersistedMcpScript;
  }

  async deleteScript(rowId: number): Promise<void> {
    const resp = await fetch(
      `${AGENT_SERVICE_URL}/api/system/codex-mcp-scripts/${rowId}`,
      { method: "DELETE" },
    );
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
  }

  async renderConfig(): Promise<CodexConfigRenderResult> {
    const resp = await fetch(
      `${AGENT_SERVICE_URL}/api/system/codex-config-toml/render`,
      { method: "POST" },
    );
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    return (await resp.json()) as CodexConfigRenderResult;
  }

  async renderClaudeConfig(): Promise<CodexConfigRenderResult> {
    const resp = await fetch(
      `${AGENT_SERVICE_URL}/api/system/claude-mcp-config/render`,
      { method: "POST" },
    );
    if (!resp.ok) {
      throw Object.assign(new Error(await readError(resp)), { status: resp.status });
    }
    return (await resp.json()) as CodexConfigRenderResult;
  }

  async renderConfigBestEffort(scope: string): Promise<void> {
    try {
      await this.renderConfig();
    } catch (err: any) {
      logger.warn("Codex config render failed after MCP registry change", {
        scope,
        error: err?.message ?? String(err),
      });
    }
  }

  async renderCliConfigsBestEffort(scope: string): Promise<void> {
    await Promise.all([
      this.renderConfigBestEffort(scope),
      this.renderClaudeConfig().catch((err: any) => {
        logger.warn("Claude MCP config render failed after MCP registry change", {
          scope,
          error: err?.message ?? String(err),
        });
      }),
    ]);
  }
}
