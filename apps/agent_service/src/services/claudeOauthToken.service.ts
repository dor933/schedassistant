import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";

/**
 * Persistence + env wiring for the Claude Code CLI OAuth token.
 *
 * Why a file under /home/agent/.claude:
 *   - The `agent_claude_home` Docker named volume already mounts there, so the
 *     token survives container restarts without a DB migration.
 *   - The CLI runs as the `agent` user (`su-exec agent claude …`), so this
 *     directory is the natural home for CLI-related state.
 *
 * Why not store in process.env only:
 *   - process.env is per-process; the next container restart loses it.
 *
 * Spawn integration:
 *   - `agentSpawnEnv()` in epicTaskUtils.ts spreads `process.env`, so once
 *     `loadIntoEnv()` runs at startup, every `spawn("su-exec", ["agent",
 *     "claude", …])` inherits CLAUDE_CODE_OAUTH_TOKEN automatically.
 *   - `loadIntoEnv()` is also called after every set/clear so a token change
 *     applies to subsequent spawns without a restart.
 */

const ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN";

function tokenFilePath(): string {
  const home = process.env.AGENT_HOME ?? "/home/agent";
  return path.join(home, ".claude", ".oauth-token");
}

function readTokenFile(): { token: string; updatedAt: Date } | null {
  const p = tokenFilePath();
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const token = raw.trim();
    if (!token) return null;
    const stat = fs.statSync(p);
    return { token, updatedAt: stat.mtime };
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function writeTokenFile(token: string): void {
  const p = tokenFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // 0600 — only the owner (agent or root) can read. Token never leaves the
  // container after this point.
  fs.writeFileSync(p, token, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    // chmod can fail on some filesystems; the writeFileSync mode is enough.
  }
}

function deleteTokenFile(): void {
  const p = tokenFilePath();
  try {
    fs.unlinkSync(p);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function maskToken(raw: string): string {
  const s = raw.trim();
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export interface ClaudeOauthTokenStatus {
  configured: boolean;
  masked: string | null;
  updatedAt: string | null;
}

/**
 * Read the persisted token (if any) and put it in process.env so that
 * subsequent spawns of `claude` (which inherit env via `agentSpawnEnv()`)
 * authenticate without an interactive login.
 */
export function loadIntoEnv(): void {
  try {
    const entry = readTokenFile();
    if (entry) {
      process.env[ENV_VAR] = entry.token;
      logger.info("Claude OAuth token loaded from disk into process env");
    } else {
      delete process.env[ENV_VAR];
      logger.info("No persisted Claude OAuth token; CLI will require manual login");
    }
  } catch (err: any) {
    logger.warn("Failed to load Claude OAuth token", { error: err?.message });
  }
}

export function describe(): ClaudeOauthTokenStatus {
  const entry = readTokenFile();
  if (!entry) {
    return { configured: false, masked: null, updatedAt: null };
  }
  return {
    configured: true,
    masked: maskToken(entry.token),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

export class ClaudeOauthTokenError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "ClaudeOauthTokenError";
  }
}

export function set(token: string): ClaudeOauthTokenStatus {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) {
    throw new ClaudeOauthTokenError(
      "token is required and cannot be empty. To clear, use DELETE.",
      400,
    );
  }
  writeTokenFile(trimmed);
  loadIntoEnv();
  return describe();
}

export function clear(): ClaudeOauthTokenStatus {
  deleteTokenFile();
  loadIntoEnv();
  return describe();
}
