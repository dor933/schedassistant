import { OAuth2Client, type TokenPayload } from "google-auth-library";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { Organization } from "@scheduling-agent/database";
import { logger } from "../logger";
import { JWT_SECRET } from "../middlewares/auth";

/**
 * Default OAuth client ids allowed when an organization has no client id of
 * its own. Currently a single Google Cloud project (`grahamy`) backs every
 * workspace domain; as soon as we start issuing per-tenant URLs each org
 * will get its own client id stored in `organizations.google_client_id` and
 * this env fallback will only be used for orgs still on the shared project.
 */
const ENV_CLIENT_IDS = (process.env.GOOGLE_OAUTH_CLIENT_IDS ?? process.env.GOOGLE_OAUTH_CLIENT_ID ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Successful verification result — the provider payload plus the tenant we
 * resolved it to. The caller uses this to find-or-create the user.
 */
export interface VerifiedGoogleIdentity {
  /** Stable Google user id (the `sub` claim). */
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Google Workspace primary domain (the `hd` claim). Required for JIT SSO. */
  hd: string;
  name: string | null;
  picture: string | null;
  /** Tenant matched by `organizations.google_workspace_domain = hd`. */
  organization: Organization;
}

function authError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

/**
 * Audience-validated ID token client. We keep a single `OAuth2Client` per
 * process and call `verifyIdToken` with the full set of allowed audiences
 * (env defaults + every org-specific `google_client_id`) so Google's own
 * library does the signature + claim verification against the live JWKS.
 */
const oauthClient = new OAuth2Client();

async function loadAllowedAudiences(): Promise<string[]> {
  const orgs = await Organization.findAll({
    where: {},
    attributes: ["googleClientId"],
  });
  const orgClientIds = orgs
    .map((o) => o.googleClientId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return Array.from(new Set([...ENV_CLIENT_IDS, ...orgClientIds]));
}

export class GoogleAuthService {
  /**
   * Verifies a Google id token and resolves the tenant it belongs to.
   *
   * Flow:
   *  1. Pull the full set of allowed audiences (env defaults + every
   *     `organizations.google_client_id`) and let `google-auth-library` do
   *     the JWKS signature check against them.
   *  2. Require `email_verified=true` and an `hd` claim — this must be a
   *     managed Workspace account, not a personal Google user.
   *  3. Look up the tenant by `googleWorkspaceDomain = hd`. If that org has
   *     its own `googleClientId`, the token's `aud` must match it exactly
   *     (prevents a token minted for another tenant from logging in here).
   */
  async verifyIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
    const audiences = await loadAllowedAudiences();
    if (audiences.length === 0) {
      logger.error("Google SSO misconfigured: no client ids configured");
      throw authError(500, "Google SSO is not configured on this server.");
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken,
        audience: audiences,
      });
      payload = ticket.getPayload();
    } catch (err) {
      logger.warn("Google id token verification failed", { error: String(err) });
      throw authError(401, "Invalid Google credential.");
    }

    if (!payload) throw authError(401, "Invalid Google credential.");

    const { sub, email, email_verified, hd, name, picture, aud } = payload;
    if (!sub || !email) throw authError(401, "Invalid Google credential.");
    if (!email_verified) {
      throw authError(403, "Google account email is not verified.");
    }
    if (!hd) {
      throw authError(
        403,
        "Personal Google accounts are not allowed — use your organization Workspace account.",
      );
    }

    const org = await Organization.findOne({
      where: { googleWorkspaceDomain: hd },
    });
    if (!org) {
      throw authError(
        403,
        `No organization is registered for the ${hd} domain.`,
      );
    }

    // If this org was issued its own client id, lock audience to it.
    // Orgs still on the shared project (googleClientId=null) accept any
    // env-default audience.
    if (org.googleClientId && aud !== org.googleClientId) {
      throw authError(
        403,
        "Google credential was issued for a different tenant.",
      );
    }

    return {
      sub,
      email: email.toLowerCase(),
      emailVerified: email_verified,
      hd,
      name: name ?? null,
      picture: picture ?? null,
      organization: org,
    };
  }

  /**
   * Pre-registration verification — used when the caller is setting up a
   * brand-new org and no `organizations` row exists for their `hd` yet.
   * Validates the id token's signature + audience against env-level client
   * ids only (the usual org-specific `googleClientId` lookup isn't possible
   * pre-org). Rejects personal accounts and any `hd` that already has an
   * org so a second tenant can't be spawned on the same Workspace domain.
   */
  async verifyBootstrapIdToken(idToken: string): Promise<{
    sub: string;
    email: string;
    hd: string;
    name: string | null;
    picture: string | null;
  }> {
    if (ENV_CLIENT_IDS.length === 0) {
      logger.error("Google SSO misconfigured: GOOGLE_OAUTH_CLIENT_IDS is empty");
      throw authError(500, "Google SSO is not configured on this server.");
    }

    let payload: TokenPayload | undefined;
    try {
      const ticket = await oauthClient.verifyIdToken({
        idToken,
        audience: ENV_CLIENT_IDS,
      });
      payload = ticket.getPayload();
    } catch (err) {
      logger.warn("Google id token verification failed (bootstrap)", {
        error: String(err),
      });
      throw authError(401, "Invalid Google credential.");
    }

    if (!payload) throw authError(401, "Invalid Google credential.");
    const { sub, email, email_verified, hd, name, picture } = payload;
    if (!sub || !email) throw authError(401, "Invalid Google credential.");
    if (!email_verified) {
      throw authError(403, "Google account email is not verified.");
    }
    if (!hd) {
      throw authError(
        403,
        "Personal Google accounts are not allowed — use your organization Workspace account.",
      );
    }

    const existing = await Organization.findOne({
      where: { googleWorkspaceDomain: hd },
    });
    if (existing) {
      throw authError(
        409,
        `An organization already exists for ${hd}. Sign in with Google from the login page instead.`,
      );
    }

    return {
      sub,
      email: email.toLowerCase(),
      hd,
      name: name ?? null,
      picture: picture ?? null,
    };
  }
}

// ─── Bootstrap ticket (signed server-side, carried by the wizard) ──────────

/** Claims embedded in a bootstrap ticket. `type` discriminates from session JWTs. */
export interface GoogleBootstrapClaims {
  type: "google-bootstrap";
  sub: string;
  email: string;
  hd: string;
  name: string | null;
  /**
   * True once the admin has proved they control the `hd` domain by publishing
   * the expected TXT record. `/auth/register` requires this flag — the initial
   * ticket minted by `/auth/google-bootstrap` is always `false` until the
   * `/auth/google-verify-domain` endpoint re-issues it.
   */
  verifiedDomain: boolean;
}

/** 15 minutes is enough to finish the wizard and short enough to limit replay. */
const BOOTSTRAP_TTL_SECONDS = 15 * 60;

export function signBootstrapTicket(
  identity: Omit<GoogleBootstrapClaims, "type">,
): string {
  const claims: GoogleBootstrapClaims = { type: "google-bootstrap", ...identity };
  return jwt.sign(claims, JWT_SECRET, { expiresIn: BOOTSTRAP_TTL_SECONDS });
}

export function verifyBootstrapTicket(ticket: string): GoogleBootstrapClaims {
  let decoded: unknown;
  try {
    decoded = jwt.verify(ticket, JWT_SECRET);
  } catch {
    throw authError(401, "Google bootstrap ticket is invalid or expired.");
  }
  const c = decoded as Partial<GoogleBootstrapClaims>;
  if (
    c.type !== "google-bootstrap" ||
    !c.sub ||
    !c.email ||
    !c.hd ||
    typeof c.verifiedDomain !== "boolean"
  ) {
    throw authError(401, "Google bootstrap ticket is malformed.");
  }
  return c as GoogleBootstrapClaims;
}

// ─── DNS TXT domain ownership verification ────────────────────────────────

/**
 * Fixed prefix for our verification TXT records. Prefix-scoped so it won't
 * collide with SPF, DMARC, Google's `google-site-verification`, etc.
 */
export const DOMAIN_VERIFICATION_TXT_PREFIX = "sched-assist-verify=";

/**
 * Deterministic verification token the admin must publish as a DNS TXT record
 * on their root domain. Binding it to `(hd, sub)` + `JWT_SECRET` means:
 *   - The same admin always sees the same token (safe to reshow across
 *     ticket re-issues — no persistence needed).
 *   - A different admin at the same company (different `sub`) wouldn't
 *     produce the same token, so a stale TXT from a failed prior attempt
 *     can't be replayed by somebody else.
 * We truncate the HMAC to 20 bytes for a ~32-char base32-ish value; collision
 * resistance at this scale is more than sufficient.
 */
export function domainVerificationToken(hd: string, sub: string): string {
  const h = crypto.createHmac("sha256", JWT_SECRET);
  h.update(`domain-verify:${hd.toLowerCase()}:${sub}`);
  return h.digest("base64url").slice(0, 32);
}

/** Full TXT record value the admin publishes — prefix + token. */
export function domainVerificationTxtValue(hd: string, sub: string): string {
  return `${DOMAIN_VERIFICATION_TXT_PREFIX}${domainVerificationToken(hd, sub)}`;
}

/**
 * Live DNS lookup — resolves every TXT record on `hd` and returns true if any
 * of them (after joining multi-string records per RFC 7208) matches our
 * expected verification value. Returns false on NXDOMAIN / no-TXT.
 *
 * Notes:
 *   - Node's `resolveTxt` returns `string[][]` because a single TXT record can
 *     be split into multiple <=255-byte strings that must be concatenated.
 *   - ENODATA / ENOTFOUND are expected ("no TXT yet") and surfaced as false.
 *   - Any other error (SERVFAIL, timeouts) is logged and surfaced as false —
 *     the admin can just retry.
 */
export async function checkDomainTxt(hd: string, expected: string): Promise<boolean> {
  let records: string[][];
  try {
    records = await dns.resolveTxt(hd);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENODATA" || code === "ENOTFOUND") return false;
    logger.warn("DNS TXT lookup failed", { hd, code, error: String(err) });
    return false;
  }
  return records.some((chunks) => chunks.join("") === expected);
}
