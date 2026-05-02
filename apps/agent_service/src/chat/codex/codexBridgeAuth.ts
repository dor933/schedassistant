/**
 * JWT helpers for the Codex / mcp_server tool bridge.
 *
 * Each turn that runs through `mcp_server` is bracketed by:
 *   1. The runner (`codexSdkRunner` / future Anthropic-via-bridge) calls
 *      `mintTurnToken(...)` to obtain a short-lived bearer string.
 *   2. The token is handed to the spawned Codex CLI via
 *      `mcp_servers.<name>.bearer_token` (or as `Authorization: Bearer …`
 *      when the SDK is configured with a URL form).
 *   3. The Codex CLI presents the token on every MCP request to
 *      `mcp_server`. The bridge forwards the token unchanged on the
 *      back-channel HTTP call to `agent_service`'s `/internal/tools/*`.
 *   4. Inside `agent_service`, `verifyTurnToken(...)` validates the
 *      signature + expiry and returns the original claims so the request
 *      handler can:
 *         - look up the tool registry (`registryId` claim),
 *         - reject any tool name not in `allowedToolNames`,
 *         - log with the same `(agentId, userId, threadId, source)`
 *           context the runner had.
 *
 * Why hand-rolled HMAC-SHA256 instead of pulling `jsonwebtoken`?
 *   - We control both ends (mcp_server is in this monorepo and uses the
 *     same module). No interop concerns with third-party JWT libraries.
 *   - We only ever need HS256 — no asymmetric keys, no rotation, no
 *     `kid` discovery. Adding a 200KB dep for this is overkill.
 *   - `node:crypto.createHmac` is constant-time when paired with
 *     `crypto.timingSafeEqual`, which is what we actually want.
 *
 * Secret source
 * -------------
 * `MCP_BRIDGE_JWT_SECRET` in the env. Compose must set the same value
 * in `agent_service` and `mcp_server`. The module fails fast on first
 * use (mint or verify) when the secret is missing — better to crash on
 * boot than silently issue tokens nobody can verify.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Source tag carried on the JWT so log lines downstream of `mcp_server`
 * can be correlated back to which graph node opened the turn. Mirrors
 * `AgentSdkSource` in `agentSdkRunner.ts:71` (kept structurally
 * identical so a future merge of the two runner abstractions is a
 * straight refactor, not a contract change).
 */
export type TurnSource =
  | "primary_agent"
  | "epic_orchestrator"
  | "roundtable_agent"
  | "application_agent"
  | "deep_agent_executor";

/**
 * Claims encoded into the per-turn JWT. Everything `mcp_server` /
 * `/internal/tools/*` needs to do its job — no DB lookups required to
 * authenticate a tool call.
 *
 * `registryId` resolves to an in-memory entry inside `toolRegistry`
 * holding the live `StructuredToolInterface[]` instances + the optional
 * `ToolResultObserver`. The token alone is never enough to invoke a
 * tool — the registry must also still be alive (cleared at end of turn
 * or after TTL).
 *
 * `allowedToolNames` is a defense-in-depth allowlist enforced inside
 * the controller before the tool is invoked. Even if a token leaks and
 * the registry is still alive, the leaked token's surface is bounded
 * by what the original turn whitelisted.
 */
export interface TurnTokenClaims {
  /** Stable id for the in-process tool registry entry. */
  registryId: string;
  agentId: string | null;
  userId: number | null;
  threadId: string | null;
  groupId: string | null;
  singleChatId: string | null;
  source: TurnSource;
  allowedToolNames: string[];
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. Caller must reject when `now > exp`. */
  exp: number;
}

const HEADER_B64URL = base64UrlEncode(
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })),
);

const DEFAULT_TTL_SECONDS = 30 * 60; // 30 min — caps the longest legitimate turn.

function getSecret(): Buffer {
  const raw = process.env.MCP_BRIDGE_JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "MCP_BRIDGE_JWT_SECRET must be set to a string of at least 32 chars on " +
        "both agent_service and mcp_server before the Codex bridge can run.",
    );
  }
  return Buffer.from(raw, "utf8");
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function sign(message: string, secret: Buffer): string {
  return base64UrlEncode(createHmac("sha256", secret).update(message).digest());
}

/**
 * Generates a fresh JWT for the given turn. The caller is expected to
 * also `register(...)` the matching tool list against
 * `claims.registryId` (typically a freshly-minted UUID).
 */
export function mintTurnToken(
  claims: Omit<TurnTokenClaims, "iat" | "exp"> & { ttlSeconds?: number },
): { token: string; expiresAt: number } {
  const secret = getSecret();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (claims.ttlSeconds ?? DEFAULT_TTL_SECONDS);

  const payload: TurnTokenClaims = {
    registryId: claims.registryId,
    agentId: claims.agentId,
    userId: claims.userId,
    threadId: claims.threadId,
    groupId: claims.groupId,
    singleChatId: claims.singleChatId,
    source: claims.source,
    allowedToolNames: claims.allowedToolNames,
    iat,
    exp,
  };

  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${HEADER_B64URL}.${payloadB64}`;
  const signature = sign(signingInput, secret);

  return { token: `${signingInput}.${signature}`, expiresAt: exp * 1000 };
}

/**
 * Validates a token. Returns the claims when the signature checks out
 * AND the token has not expired. Returns `null` for any failure mode
 * (malformed, bad signature, expired) — callers should treat all three
 * the same way: 401, no diagnostic, no log of the offending token.
 */
export function verifyTurnToken(token: string): TurnTokenClaims | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  if (headerB64 !== HEADER_B64URL) return null; // pin to HS256 — never accept `none`.

  let secret: Buffer;
  try {
    secret = getSecret();
  } catch {
    return null;
  }

  const expectedSig = sign(`${headerB64}.${payloadB64}`, secret);
  const a = Buffer.from(signatureB64);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let claims: TurnTokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));
  } catch {
    return null;
  }

  if (
    typeof claims !== "object" ||
    claims === null ||
    typeof claims.registryId !== "string" ||
    typeof claims.exp !== "number" ||
    typeof claims.iat !== "number" ||
    !Array.isArray(claims.allowedToolNames)
  ) {
    return null;
  }
  if (Math.floor(Date.now() / 1000) >= claims.exp) return null;

  return claims;
}

/**
 * Convenience for runners that just need a fresh registry id alongside
 * a token. Kept here so the JWT and the registry id are minted atomically
 * — the registryId in the JWT is always a fresh value, not something
 * the caller can supply (which would let a buggy caller mint two tokens
 * pointing at the same registry).
 */
export function newRegistryId(): string {
  return randomBytes(16).toString("hex");
}
