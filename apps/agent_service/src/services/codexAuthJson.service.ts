import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logger } from "../logger";

/**
 * Persistence for the Codex CLI's `auth.json` (ChatGPT-account login path).
 * Sibling of `codexAuthToken.service.ts` (which handles the simpler
 * `OPENAI_API_KEY` route).
 *
 * Why a separate service:
 *   - `codex login` writes a structured JSON blob with multiple secrets:
 *     id_token, access_token, refresh_token, account_id, last_refresh.
 *     A super_admin who logged in on their workstation can paste the file
 *     into the admin UI to mirror that login into the container.
 *   - codex reads `~/.codex/auth.json` directly on every spawn — there's
 *     no env-var equivalent — so we MUST own the file at the path codex
 *     expects, with permissions the `agent` user (which spawned codex
 *     runs as) can read.
 *
 * Why we chown to `agent` (not just chmod 0o600):
 *   - The .api-key file works without chown because agent_service (root)
 *     reads it into process.env on startup, and codex reads OPENAI_API_KEY
 *     from env. The file itself never has to be readable by `agent`.
 *   - auth.json is the opposite: codex reads it directly from the
 *     filesystem, as the `agent` user. A 0o600 file owned by root is
 *     unreadable to agent. So after we write, we `chown agent:agent` and
 *     keep mode 0o600 — owner-only read/write, owner is now `agent`.
 *
 * Validation:
 *   - The blob must parse as JSON and have at least one usable credential
 *     (`OPENAI_API_KEY` non-null OR `tokens.access_token` non-empty). We
 *     don't enforce the rest of the shape — codex evolves the file format,
 *     and any extra fields admins paste in are preserved verbatim.
 *
 * Durability:
 *   - File lives under /home/agent/.codex which is on the
 *     `agent_claude_home` named volume — survives container restarts.
 *     This service does NOT replicate to Postgres; the named volume IS
 *     the durability layer. If a paste-from-workstation flow isn't enough
 *     for your DR posture, that's option B (DB-backed) — separate change.
 */

const AGENT_HOME = process.env.AGENT_HOME ?? "/home/agent";
const AUTH_FILE = path.join(AGENT_HOME, ".codex", "auth.json");
const AGENT_USER = "agent";

interface CodexAuthTokens {
  id_token?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  account_id?: string | null;
}

export interface CodexAuthJsonBlob {
  OPENAI_API_KEY?: string | null;
  tokens?: CodexAuthTokens;
  last_refresh?: string | null;
  // Forward-compat: codex may add fields. We pass through anything else
  // verbatim so we don't break logins on a CLI upgrade.
  [extra: string]: unknown;
}

export interface CodexAuthJsonStatus {
  configured: boolean;
  /** Final 8 chars of `tokens.account_id`, e.g. "…cd1f9012". */
  accountIdSuffix: string | null;
  /** First4…last4 of `tokens.access_token`. */
  accessTokenMasked: string | null;
  hasRefreshToken: boolean;
  hasOpenaiApiKey: boolean;
  lastRefresh: string | null;
  /** ISO timestamp of the file's mtime — when this admin last pasted/wrote. */
  updatedAt: string | null;
}

export class CodexAuthJsonError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
    this.name = "CodexAuthJsonError";
  }
}

function maskToken(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length <= 8) return "••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function suffix(raw: string | null | undefined, n = 8): string | null {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  return s.length <= n ? s : `…${s.slice(-n)}`;
}

function readFileBlob(): { blob: CodexAuthJsonBlob; updatedAt: Date } | null {
  try {
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as CodexAuthJsonBlob;
    const stat = fs.statSync(AUTH_FILE);
    return { blob: parsed, updatedAt: stat.mtime };
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    if (err instanceof SyntaxError) {
      // File exists but isn't valid JSON — surface as misconfigured rather
      // than crash. Operator can re-paste a valid blob to recover.
      logger.warn("codexAuthJson: existing auth.json is not valid JSON", {
        error: err.message,
      });
      return null;
    }
    throw err;
  }
}

function writeBlob(blob: CodexAuthJsonBlob): void {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  // Two-stage write: create with 0o600, then chown to `agent`. mode in
  // writeFileSync may be ignored if the file already exists, so chmod
  // explicitly afterwards to be safe.
  const serialized = JSON.stringify(blob, null, 2);
  fs.writeFileSync(AUTH_FILE, serialized, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(AUTH_FILE, 0o600);
  } catch {
    // chmod can fail on some filesystems; the writeFileSync mode is enough.
  }
  // chown to `agent` so the spawned codex (running as agent via su-exec)
  // can read the file. Best-effort: if chown fails (e.g. user doesn't
  // exist in some test environment), log and continue — the operator
  // will see the failure when codex tries to read the file.
  const r = spawnSync("chown", [`${AGENT_USER}:${AGENT_USER}`, AUTH_FILE], {
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    logger.warn("codexAuthJson: chown to agent failed (non-fatal)", {
      stderr: r.stderr?.trim(),
    });
  }
  // Also ensure the parent directory is owned by agent so codex can write
  // its own updates (refresh-token rotation) to siblings of the file.
  const rDir = spawnSync(
    "chown",
    [`${AGENT_USER}:${AGENT_USER}`, path.dirname(AUTH_FILE)],
    { encoding: "utf-8" },
  );
  if (rDir.status !== 0) {
    logger.warn("codexAuthJson: chown of .codex dir failed (non-fatal)", {
      stderr: rDir.stderr?.trim(),
    });
  }
}

function deleteFile(): void {
  try {
    fs.unlinkSync(AUTH_FILE);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

function validateBlob(value: unknown): CodexAuthJsonBlob {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexAuthJsonError(
      "auth.json must be a JSON object — paste the full file contents.",
    );
  }
  const blob = value as CodexAuthJsonBlob;

  const apiKey =
    typeof blob.OPENAI_API_KEY === "string" && blob.OPENAI_API_KEY.trim().length > 0
      ? blob.OPENAI_API_KEY
      : null;
  const accessToken =
    typeof blob.tokens?.access_token === "string" &&
    blob.tokens.access_token.trim().length > 0
      ? blob.tokens.access_token
      : null;

  if (!apiKey && !accessToken) {
    throw new CodexAuthJsonError(
      "auth.json must contain either a non-null OPENAI_API_KEY or " +
        "tokens.access_token. Run `codex login` again and re-export.",
    );
  }

  // last_refresh, when provided, must be parseable as a date — codex uses
  // it to decide when to rotate the refresh token. A bad value would
  // surface as a confusing CLI error later; reject early.
  if (
    typeof blob.last_refresh === "string" &&
    blob.last_refresh.trim().length > 0 &&
    Number.isNaN(Date.parse(blob.last_refresh))
  ) {
    throw new CodexAuthJsonError(
      `auth.json.last_refresh ("${blob.last_refresh}") is not a parseable timestamp.`,
    );
  }

  return blob;
}

export function describe(): CodexAuthJsonStatus {
  const entry = readFileBlob();
  if (!entry) {
    return {
      configured: false,
      accountIdSuffix: null,
      accessTokenMasked: null,
      hasRefreshToken: false,
      hasOpenaiApiKey: false,
      lastRefresh: null,
      updatedAt: null,
    };
  }
  const { blob, updatedAt } = entry;
  return {
    configured: true,
    accountIdSuffix: suffix(blob.tokens?.account_id ?? null),
    accessTokenMasked: maskToken(blob.tokens?.access_token ?? null),
    hasRefreshToken:
      typeof blob.tokens?.refresh_token === "string" &&
      blob.tokens.refresh_token.trim().length > 0,
    hasOpenaiApiKey:
      typeof blob.OPENAI_API_KEY === "string" &&
      blob.OPENAI_API_KEY.trim().length > 0,
    lastRefresh: blob.last_refresh ?? null,
    updatedAt: updatedAt.toISOString(),
  };
}

/**
 * Persist a fresh auth.json blob. Accepts either the parsed object or a
 * raw string (the admin UI sends a string from a textarea).
 */
export function set(input: unknown): CodexAuthJsonStatus {
  let parsed: unknown;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (err: any) {
      throw new CodexAuthJsonError(
        `auth.json is not valid JSON: ${err?.message ?? err}`,
      );
    }
  } else {
    parsed = input;
  }
  const blob = validateBlob(parsed);
  writeBlob(blob);
  logger.info("codexAuthJson: wrote auth.json", {
    hasOpenaiApiKey:
      typeof blob.OPENAI_API_KEY === "string" &&
      blob.OPENAI_API_KEY.trim().length > 0,
    hasAccessToken:
      typeof blob.tokens?.access_token === "string" &&
      blob.tokens.access_token.trim().length > 0,
    hasRefreshToken:
      typeof blob.tokens?.refresh_token === "string" &&
      blob.tokens.refresh_token.trim().length > 0,
    accountIdSuffix: suffix(blob.tokens?.account_id ?? null),
  });
  return describe();
}

export function clear(): CodexAuthJsonStatus {
  deleteFile();
  logger.info("codexAuthJson: cleared auth.json");
  return describe();
}
