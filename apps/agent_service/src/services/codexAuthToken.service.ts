import fs from "node:fs";
import path from "node:path";
import { logger } from "../logger";

/**
 * Persistence + env wiring for the Codex CLI's OpenAI API key.
 *
 * Why a file under /home/agent/.codex:
 *   - The `agent_claude_home` named volume already mounts /home/agent, so
 *     anything we write there survives container restarts. We co-locate
 *     codex's persistent state under /home/agent/.codex to match.
 *   - The CLI runs as the `agent` user (`su-exec agent codex …`), so this
 *     directory is the natural home for codex auth + cache.
 *
 * Why not store in process.env only:
 *   - process.env is per-process; a container restart loses it. The admin
 *     would have to re-paste the key every time.
 *
 * Spawn integration:
 *   - The CLI engine (`utils/cliExecution.ts`) spreads `process.env` into
 *     every spawn, then merges the adapter's `envVars()` on top. Once
 *     `loadIntoEnv()` runs at startup, `OPENAI_API_KEY` is in process.env
 *     and `codex` finds it automatically.
 *   - Codex also accepts auth via `~/.codex/auth.json` (written by
 *     `codex login`). We don't manage that path here — admins who want
 *     ChatGPT-account login can run `codex login` inside the container.
 */

const ENV_VAR = "OPENAI_API_KEY";

function tokenFilePath(): string {
  const home = process.env.AGENT_HOME ?? "/home/agent";
  return path.join(home, ".codex", ".api-key");
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

export interface CodexAuthTokenStatus {
  configured: boolean;
  masked: string | null;
  updatedAt: string | null;
}

/**
 * Read the persisted key (if any) and put it in process.env so that
 * subsequent spawns of `codex` inherit OPENAI_API_KEY without an
 * interactive login.
 */
export function loadIntoEnv(): void {
  try {
    const entry = readTokenFile();
    if (entry) {
      process.env[ENV_VAR] = entry.token;
      logger.info("Codex API key loaded from disk into process env");
    } else if (!process.env[ENV_VAR]) {
      // Don't clobber an already-set OPENAI_API_KEY (e.g. from container
      // env) just because no file is present. Only log when both are absent.
      logger.info(
        "No persisted Codex API key and no OPENAI_API_KEY in env; codex CLI will fall back to ~/.codex/auth.json or fail",
      );
    }
  } catch (err: any) {
    logger.warn("Failed to load Codex API key", { error: err?.message });
  }
}

export function describe(): CodexAuthTokenStatus {
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

export class CodexAuthTokenError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "CodexAuthTokenError";
  }
}

export function set(token: string): CodexAuthTokenStatus {
  const trimmed = String(token ?? "").trim();
  if (!trimmed) {
    throw new CodexAuthTokenError(
      "token is required and cannot be empty. To clear, use DELETE.",
      400,
    );
  }
  writeTokenFile(trimmed);
  loadIntoEnv();
  return describe();
}

export function clear(): CodexAuthTokenStatus {
  deleteTokenFile();
  loadIntoEnv();
  return describe();
}
