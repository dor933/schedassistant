import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { McpServer } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { logger } from "../logger";

/**
 * Codex CLI's `~/.codex/config.toml` renderer.
 *
 * Why a renderer at all:
 *   - Codex reads MCP server definitions exclusively from
 *     `[mcp_servers.NAME]` tables in `~/.codex/config.toml`. There is no
 *     env-var or flag equivalent. Until this service existed, every
 *     `run_codex_cli` invocation saw zero MCPs no matter what the
 *     `mcp_servers` registry contained — the Claude path picked them up
 *     via its own config but Codex did not.
 *   - We own the file. Re-render it from the database whenever the
 *     registry changes (admin CRUD, install-from-public). Idempotent: the
 *     rendered output is a function of the rows, so two renders with the
 *     same DB state produce byte-identical files.
 *
 * What we render:
 *   - Every `mcp_servers` row, regardless of `organization_id`. Codex is a
 *     single-process CLI shared across all tenants in this container, and
 *     selecting which subset of MCPs a particular spawn is allowed to use
 *     happens at the agent layer (via `agent_available_mcp_servers`),
 *     not at the Codex config layer. Rendering everything keeps the
 *     adapter simple; a more granular per-org config.toml can be added
 *     later if isolation requirements grow.
 *   - Each row becomes a `[mcp_servers.<safe_name>]` table. The display
 *     name is sanitized (lowercase, alnum + underscore) so it matches
 *     codex's TOML key constraints; collisions are resolved by suffixing
 *     `_<id>`.
 *
 * What we deliberately don't do here:
 *   - We don't write `script_content` to disk. That's the controller's
 *     job — it persists the script under `mcp-scripts/<id>.js` at
 *     create/update time and points `command="node"` /
 *     `args=["…/<id>.js"]` on the row. The renderer just picks up the
 *     command/args verbatim.
 *   - We don't merge user-authored sections (e.g. `[notice]`, custom
 *     `[profiles.…]`). The file is exclusively `[mcp_servers.*]` — if an
 *     operator wants extra Codex config, that's a separate static file
 *     pattern (TODO when we need it).
 *
 * Permissions: file is owned by `agent:agent` so the spawned codex (which
 * runs under `su-exec agent`) can read it. Mode 0o644 — the file contains
 * no secrets directly, just command lines. Sensitive env values (API keys,
 * tokens) are stored in `mcp_servers.env` and rendered into the TOML, so
 * keep them out of the registry; if that's a problem, switch to 0o600 +
 * chown agent:agent and tell admins not to commit envs to the registry.
 *
 * Re-render hooks:
 *   - At agent_service boot (`renderCodexConfigToml()` called once after
 *     DB connect).
 *   - From the user_app admin controller after every successful
 *     POST/PATCH/DELETE/install on /admin/mcp-servers. user_app asks this
 *     service to re-render via `/api/system/codex-config-toml/render`.
 */

const AGENT_HOME = process.env.AGENT_HOME ?? "/home/agent";
const CONFIG_DIR = path.join(AGENT_HOME, ".codex");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.toml");
const SCRIPTS_DIR = path.join(CONFIG_DIR, "mcp-scripts");
const AGENT_USER = "agent";

const HEADER = `# AUTO-GENERATED — DO NOT EDIT BY HAND.
# Regenerated from the mcp_servers DB table on agent_service boot and
# after every admin-UI MCP CRUD. Source of truth: PostgreSQL.
`;

/** Codex TOML keys must match [A-Za-z0-9_]. */
function sanitizeKey(name: string, idForCollision: number): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || `mcp_${idForCollision}`;
}

function tomlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function renderArray(values: string[]): string {
  if (values.length === 0) return "[]";
  return "[" + values.map((v) => `"${tomlEscape(v)}"`).join(", ") + "]";
}

function renderEnvTable(env: Record<string, string> | null): string {
  if (!env || Object.keys(env).length === 0) return "";
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    lines.push(`  ${k} = "${tomlEscape(v)}"`);
  }
  if (lines.length === 0) return "";
  return "  env = { " + lines.map((l) => l.trim()).join(", ") + " }\n";
}

function renderRow(
  row: {
    id: number;
    name: string;
    command: string;
    args: string[];
    env: Record<string, string> | null;
    description: string | null;
  },
  takenKeys: Set<string>,
): string {
  let key = sanitizeKey(row.name, row.id);
  if (takenKeys.has(key)) key = `${key}_${row.id}`;
  takenKeys.add(key);

  const out: string[] = [];
  if (row.description) {
    out.push(`# ${row.description.split("\n")[0].slice(0, 200)}`);
  }
  out.push(`[mcp_servers.${key}]`);
  out.push(`  command = "${tomlEscape(row.command)}"`);
  out.push(`  args = ${renderArray(row.args)}`);
  const envBlock = renderEnvTable(row.env);
  if (envBlock) out.push(envBlock.trimEnd());
  return out.join("\n") + "\n";
}

function ensureDir(dir: string, mode: number): void {
  fs.mkdirSync(dir, { recursive: true, mode });
}

function chownToAgent(target: string): void {
  const r = spawnSync("chown", [`${AGENT_USER}:${AGENT_USER}`, target], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    logger.warn("codexConfigToml: chown failed (non-fatal)", {
      target,
      stderr: r.stderr?.trim(),
    });
  }
}

/**
 * Persist a single row's `script_content` to disk and return the
 * canonical (command, args) the registry should store. Caller is the
 * mcpServers admin controller, not the renderer — exported here so the
 * disk path stays in one module.
 */
export function persistMcpScript(
  rowId: number,
  scriptContent: string,
): { command: string; args: string[]; scriptPath: string } {
  ensureDir(SCRIPTS_DIR, 0o755);
  chownToAgent(SCRIPTS_DIR);
  const scriptPath = path.join(SCRIPTS_DIR, `${rowId}.js`);
  fs.writeFileSync(scriptPath, scriptContent, { encoding: "utf-8", mode: 0o755 });
  fs.chmodSync(scriptPath, 0o755);
  chownToAgent(scriptPath);
  return {
    command: "node",
    args: [scriptPath],
    scriptPath,
  };
}

/** Best-effort delete. Missing file is fine (already cleaned up). */
export function deleteMcpScript(rowId: number): void {
  const scriptPath = path.join(SCRIPTS_DIR, `${rowId}.js`);
  try {
    fs.unlinkSync(scriptPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      logger.warn("codexConfigToml: script delete failed", {
        scriptPath,
        error: err?.message,
      });
    }
  }
}

/**
 * Render `~/.codex/config.toml` from the current `mcp_servers` rows.
 * Idempotent. Safe to call repeatedly (e.g. after every CRUD).
 */
export async function renderCodexConfigToml(): Promise<{
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
    attributes: [
      "id",
      "name",
      "transport",
      "command",
      "args",
      "env",
      "description",
    ],
    order: [["id", "ASC"]],
  });

  const takenKeys = new Set<string>();
  const blocks: string[] = [];
  for (const r of rows) {
    blocks.push(
      renderRow(
        {
          id: r.id,
          name: r.name,
          command: r.command,
          args: r.args ?? [],
          env: r.env,
          description: r.description ?? null,
        },
        takenKeys,
      ),
    );
  }

  const body = HEADER + "\n" + blocks.join("\n");
  fs.writeFileSync(CONFIG_FILE, body, { encoding: "utf-8", mode: 0o644 });
  fs.chmodSync(CONFIG_FILE, 0o644);
  chownToAgent(CONFIG_FILE);

  logger.info("codexConfigToml: rendered", {
    path: CONFIG_FILE,
    serverCount: rows.length,
  });
  return { path: CONFIG_FILE, serverCount: rows.length };
}
