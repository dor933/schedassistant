import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { logger } from "../logger";

const AGENT_HOME = process.env.AGENT_HOME ?? "/home/agent";
const CONFIG_DIR = path.join(AGENT_HOME, ".claude");
const CONFIG_FILE = path.join(CONFIG_DIR, "mcp-from-db.json");
const AGENT_USER = "agent";

function sanitizeKey(name: string, idForCollision: number): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || `mcp_${idForCollision}`;
}

function ensureDir(dir: string, mode: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function chownToAgent(target: string): void {
  const r = spawnSync("chown", [`${AGENT_USER}:${AGENT_USER}`, target], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    logger.warn("claudeMcpConfig: chown failed (non-fatal)", {
      target,
      stderr: r.stderr?.trim(),
    });
  }
}

function renderEnvForClaude(env: Record<string, string> | null): Record<string, string> | undefined {
  if (!env || Object.keys(env).length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const placeholder = value.match(/^\{\{(\w+)\}\}$/);
    out[key] = placeholder ? `\${${placeholder[1]}}` : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Render a Claude Code MCP JSON config from the DB registry.
 *
 * Claude Code accepts this format through `--mcp-config <file>`. It is the
 * same shape as project `.mcp.json` / managed MCP config:
 *
 *   { "mcpServers": { "name": { "type": "stdio", "command": "...", ... } } }
 */
export async function renderClaudeMcpConfig(): Promise<{
  path: string;
  serverCount: number;
}> {
  ensureDir(CONFIG_DIR, 0o755);
  chownToAgent(CONFIG_DIR);

  const rows = await McpServer.findAll({
    where: {
      transport: "stdio",
      command: { [Op.ne]: "" },
    },
    attributes: ["id", "name", "transport", "command", "args", "env"],
    order: [["id", "ASC"]],
  });

  const takenKeys = new Set<string>();
  const mcpServers: Record<string, unknown> = {};
  for (const row of rows) {
    let key = sanitizeKey(row.name, row.id);
    if (takenKeys.has(key)) key = `${key}_${row.id}`;
    takenKeys.add(key);

    const env = renderEnvForClaude(row.env);
    mcpServers[key] = {
      type: "stdio",
      command: row.command,
      args: row.args ?? [],
      ...(env ? { env } : {}),
    };
  }

  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ mcpServers }, null, 2) + "\n",
    { encoding: "utf-8", mode: 0o644 },
  );
  fs.chmodSync(CONFIG_FILE, 0o644);
  chownToAgent(CONFIG_FILE);

  logger.info("claudeMcpConfig: rendered", {
    path: CONFIG_FILE,
    serverCount: rows.length,
  });
  return { path: CONFIG_FILE, serverCount: rows.length };
}

export function getClaudeMcpConfigPath(): string {
  return CONFIG_FILE;
}
