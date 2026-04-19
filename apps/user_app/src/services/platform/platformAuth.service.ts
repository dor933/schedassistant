import crypto from "crypto";
import { signPlatformToken } from "../../middlewares/platformAuth";

/**
 * Platform-admin sign-in backed by env vars rather than a DB row. There is
 * exactly one platform operator (the sole owner of this system), so the
 * `platform_admins` table + bcrypt + bootstrap script were pure overhead.
 * Credentials live in `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD`
 * alongside every other secret and rotate by updating the env and restarting.
 *
 * The comparison uses `crypto.timingSafeEqual` so response timing never leaks
 * which of the two fields (email vs password) matched — a plain `===` would
 * short-circuit on the first differing byte.
 */
export class PlatformAuthService {
  async login(email: string, password: string) {
    const expectedEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
    const expectedPassword = process.env.PLATFORM_ADMIN_PASSWORD;
    if (!expectedEmail || !expectedPassword) {
      // Misconfigured deployment: fail closed with a 500 (not a 401) so a
      // silent missing-env-var doesn't look like a user typo in the logs.
      throw Object.assign(
        new Error("Platform admin credentials are not configured on the server."),
        { status: 500 },
      );
    }

    const normalizedEmail = email.trim().toLowerCase();
    // Evaluate both compares before branching — avoids short-circuiting on
    // email so response time doesn't distinguish "wrong email" from "wrong
    // password".
    const emailOk = timingSafeEqualStr(normalizedEmail, expectedEmail);
    const passwordOk = timingSafeEqualStr(password, expectedPassword);
    if (!emailOk || !passwordOk) {
      throw Object.assign(new Error("Invalid credentials."), { status: 401 });
    }

    const token = signPlatformToken({
      platformAdminId: expectedEmail,
      email: expectedEmail,
    });

    return {
      token,
      admin: { id: expectedEmail, email: expectedEmail },
    };
  }

  async getMe(email: string) {
    const expectedEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
    // Rotating the env var must invalidate tokens issued under the old
    // credential — otherwise a compromised token would outlive the rotation.
    if (!expectedEmail || email !== expectedEmail) {
      throw Object.assign(new Error("Platform admin token no longer valid."), {
        status: 401,
      });
    }
    return { id: expectedEmail, email: expectedEmail, lastLoginAt: null };
  }
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // `timingSafeEqual` requires equal-length buffers. Pad to a common length so
  // the comparison runs in constant time regardless of input length, then
  // reject mismatched lengths explicitly — otherwise "abc" would equal
  // "abc\0\0" after padding.
  const len = Math.max(aBuf.length, bBuf.length);
  const aPad = Buffer.alloc(len);
  const bPad = Buffer.alloc(len);
  aBuf.copy(aPad);
  bBuf.copy(bPad);
  const equal = crypto.timingSafeEqual(aPad, bPad);
  return equal && aBuf.length === bBuf.length;
}
