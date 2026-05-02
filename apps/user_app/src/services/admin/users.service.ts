import bcrypt from "bcrypt";
import { Op } from "sequelize";
import { User, Role } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import {
  userNameSchema,
  passwordSchema,
  displayNameSchema,
} from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

export class UsersService {
  async getAll(
    organizationId: string,
    opts: { excludeClientApp?: boolean } = {},
  ) {
    // The roundtable / group picker passes excludeClientApp=true so users
    // mirrored from upstream client apps never show up as candidates. The
    // admin users page leaves it unset to keep its full read-only listing.
    const where: Record<string, unknown> = { organizationId };
    if (opts.excludeClientApp) {
      where.authProvider = { [Op.ne]: "client_app" };
    }
    const users = await User.findAll({
      where,
      attributes: [
        "id",
        "displayName",
        "userIdentity",
        "roleId",
        "createdAt",
        "authProvider",
        "externalSub",
      ],
      order: [["created_at", "DESC"]],
    });
    const roles = await Role.findAll({ attributes: ["id", "name"] });
    const roleMap = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    return users.map((u) => ({
      id: u.id,
      displayName: u.displayName,
      userIdentity: u.userIdentity,
      role: u.roleId ? roleMap[u.roleId] ?? "user" : "user",
      roleId: u.roleId,
      createdAt: u.createdAt,
      authProvider: u.authProvider,
      externalSub: u.externalSub,
    }));
  }

  /**
   * Provisions a new local (password-auth) user inside the caller's
   * organization. Runs independently of the tenant's auth-provider mix — an
   * org whose admin signed in via Google SSO can still hold local users;
   * `organization_id` is opaque to `auth_provider`. Gated to super_admin at
   * the controller, but this layer re-enforces so future API surfaces inherit
   * the guard automatically.
   */
  async create(
    callerRole: string,
    callerId: UserId,
    callerOrgId: string,
    data: {
      userName: string;
      displayName: string;
      password: string;
      roleId?: string | null;
    },
  ) {
    if (callerRole !== "super_admin") {
      throw Object.assign(
        new Error("Only super admins can create users."),
        { status: 403 },
      );
    }

    const userName = userNameSchema.parse(data.userName);
    const displayName = displayNameSchema.parse(data.displayName);
    const password = passwordSchema.parse(data.password);

    // Username is globally unique (matches the same check on registerOrganization).
    const existing = await User.findOne({ where: { userName } });
    if (existing) {
      throw Object.assign(new Error("Username is already taken."), { status: 409 });
    }

    let roleId: string | null = null;
    if (data.roleId) {
      // Validate roleId exists. Allow assigning any role from the global role
      // table — super_admin is the highest privilege and can grant anything,
      // matching the `update()` branch that already lets super_admin swap roles.
      const role = await Role.findByPk(data.roleId, { attributes: ["id"] });
      if (!role) {
        throw Object.assign(new Error("Role not found."), { status: 400 });
      }
      roleId = role.id;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await User.create({
      userName,
      displayName,
      password: passwordHash,
      authProvider: "local",
      externalSub: null,
      organizationId: callerOrgId,
      roleId,
      // lastLoginAt left null so the welcome animation fires on first sign-in.
    });

    this.broadcast(
      "user_created",
      `User "${user.displayName || user.userName}" created`,
      { userId: user.id },
      callerId,
    );

    const roles = await Role.findAll({ attributes: ["id", "name"] });
    const roleMap = Object.fromEntries(roles.map((r) => [r.id, r.name]));
    return {
      id: user.id,
      displayName: user.displayName,
      userIdentity: user.userIdentity,
      role: user.roleId ? roleMap[user.roleId] ?? "user" : "user",
      roleId: user.roleId,
      createdAt: user.createdAt,
    };
  }

  async update(
    targetId: UserId,
    callerRole: string,
    callerId: UserId,
    callerOrgId: string,
    data: { displayName?: string; userIdentity?: Record<string, unknown>; roleId?: string },
  ) {
    // Scope by org — super_admin is still tenant-bound.
    const user = await User.findOne({ where: { id: targetId, organizationId: callerOrgId } });
    if (!user) throw Object.assign(new Error("User not found."), { status: 404 });

    // Client-app users are owned by the upstream application — their
    // displayName / identity / role mirror data we don't control here.
    // Block all admin edits to keep the mirror authoritative.
    if (user.authProvider === "client_app") {
      throw Object.assign(
        new Error(
          "This user is provisioned by an external application and cannot be edited from the admin UI.",
        ),
        { status: 403 },
      );
    }

    let targetRoleName = "user";
    if (user.roleId) {
      const targetRole = await Role.findByPk(user.roleId, { attributes: ["name"] });
      if (targetRole) targetRoleName = targetRole.name;
    }

    if (callerRole === "admin" && targetRoleName === "super_admin") {
      throw Object.assign(new Error("You do not have permission to edit this user."), { status: 403 });
    }

    // Admins can only edit identity for regular users, not for admin/super_admin
    const targetIsAdminOrAbove = targetRoleName === "admin" || targetRoleName === "super_admin";
    const canEditIdentity = callerRole === "super_admin" || !targetIsAdminOrAbove;

    const patch: Record<string, any> = {};
    if (data.displayName !== undefined) patch.displayName = data.displayName;
    if (data.userIdentity !== undefined && canEditIdentity) patch.userIdentity = data.userIdentity;
    if (data.roleId !== undefined && callerRole === "super_admin") patch.roleId = data.roleId;
    await user.update(patch);

    this.broadcast("user_updated", `User "${user.displayName || user.id}" updated`, { userId: user.id }, callerId);
    return user;
  }

  private broadcast(type: string, message: string, data: Record<string, unknown>, actorId: UserId) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }
}
