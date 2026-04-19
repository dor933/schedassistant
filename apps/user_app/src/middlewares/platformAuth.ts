import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

/**
 * Platform-admin auth is a completely separate auth surface from the tenant
 * login flow:
 *
 *  - signed with its own secret (`PLATFORM_JWT_SECRET`), so a tenant JWT
 *    can never unlock platform routes and vice-versa — even if one secret
 *    ever leaks, the other side is unaffected
 *  - payload carries `kind: "platform"` plus the `platform_admins.id` — no
 *    `organizationId`, no tenant role, because platform admins live outside
 *    the tenant model entirely
 *  - attaches to `req.platformAdmin` to make that disjointness explicit at
 *    type level (never collides with `req.user`)
 */

const PLATFORM_JWT_SECRET =
  process.env.PLATFORM_JWT_SECRET ?? "dev-platform-secret-change-in-production";

export interface PlatformAuthPayload {
  /** Tag prevents accidentally treating a tenant JWT as a platform one. */
  kind: "platform";
  platformAdminId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      platformAdmin?: PlatformAuthPayload;
    }
  }
}

export function signPlatformToken(
  payload: Omit<PlatformAuthPayload, "kind">,
): string {
  return jwt.sign({ ...payload, kind: "platform" }, PLATFORM_JWT_SECRET, {
    expiresIn: "8h",
  });
}

export function verifyPlatformToken(
  token: string,
): PlatformAuthPayload | null {
  try {
    const decoded = jwt.verify(token, PLATFORM_JWT_SECRET) as PlatformAuthPayload;
    // Tag check defends against a forged payload that verifies under this
    // secret but was never issued as a platform token.
    if (decoded.kind !== "platform") return null;
    return decoded;
  } catch {
    return null;
  }
}

export function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header." });
    return;
  }
  const payload = verifyPlatformToken(header.slice(7));
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired platform admin token." });
    return;
  }
  req.platformAdmin = payload;
  next();
}
