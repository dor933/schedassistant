import bcrypt from "bcrypt";
import { PlatformAdmin } from "@scheduling-agent/database";
import { signPlatformToken } from "../../middlewares/platformAuth";

/**
 * Platform-admin sign-in. Distinct from tenant auth on every axis:
 * separate table, separate password column, separate JWT secret, no
 * organization/role to resolve. The issued token is keyed off
 * `platform_admins.id` and carries `kind: "platform"` so downstream
 * middleware can't confuse it with a tenant session.
 */
export class PlatformAuthService {
  async login(email: string, password: string) {
    const normalized = email.trim().toLowerCase();
    const admin = await PlatformAdmin.findOne({ where: { email: normalized } });
    // Uniform error on both "no such admin" and "wrong password" so the API
    // doesn't leak which platform admin emails are provisioned.
    if (!admin) {
      throw Object.assign(new Error("Invalid credentials."), { status: 401 });
    }
    const valid = await bcrypt.compare(password, admin.passwordHash);
    if (!valid) {
      throw Object.assign(new Error("Invalid credentials."), { status: 401 });
    }

    await admin.update({ lastLoginAt: new Date() });

    const token = signPlatformToken({
      platformAdminId: admin.id,
      email: admin.email,
    });

    return {
      token,
      admin: {
        id: admin.id,
        email: admin.email,
      },
    };
  }

  async getMe(platformAdminId: string) {
    const admin = await PlatformAdmin.findByPk(platformAdminId, {
      attributes: ["id", "email", "lastLoginAt"],
    });
    if (!admin) {
      throw Object.assign(new Error("Platform admin not found."), { status: 404 });
    }
    return {
      id: admin.id,
      email: admin.email,
      lastLoginAt: admin.lastLoginAt,
    };
  }
}
