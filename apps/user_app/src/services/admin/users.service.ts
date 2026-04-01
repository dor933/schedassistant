import { User, Role } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";

export class UsersService {
  async getAll() {
    const users = await User.findAll({
      attributes: ["id", "displayName", "userIdentity", "roleId", "createdAt"],
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
    }));
  }

  async update(
    targetId: UserId,
    callerRole: string,
    callerId: UserId,
    data: { displayName?: string; userIdentity?: Record<string, unknown>; roleId?: string },
  ) {
    const user = await User.findByPk(targetId);
    if (!user) throw Object.assign(new Error("User not found."), { status: 404 });

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
