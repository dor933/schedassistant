import bcrypt from "bcrypt";
import {
  sequelize,
  Person,
  User,
  Employee,
  Role,
} from "@scheduling-agent/database";
import { getIO } from "../../sockets/server/socketServer";
import { logger } from "../../logger";
import type { UserId } from "@scheduling-agent/types";

export interface CreatePersonPayload {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  user?: {
    userName: string;
    password: string;
    displayName?: string | null;
    roleId?: string | null;
    userIdentity?: Record<string, unknown> | null;
  } | null;
  employee?: {
    jiraIdNumber?: string | null;
  } | null;
}

/**
 * Creates a `persons` row and optionally a linked `users` and/or `employees`
 * row, all in a single transaction. At least one of `user` or `employee`
 * must be supplied — a person row without any role is rejected.
 */
export class PersonsService {
  async create(payload: CreatePersonPayload, actorId: UserId) {
    if (!payload.user && !payload.employee) {
      throw Object.assign(
        new Error("A person must be created with at least one role (user or employee)."),
        { status: 400 },
      );
    }

    // Validate the user payload up-front so we fail before opening the
    // transaction on anything obvious.
    if (payload.user) {
      if (!payload.user.userName?.trim()) {
        throw Object.assign(new Error("user.userName is required."), { status: 400 });
      }
      if (!payload.user.password?.trim()) {
        throw Object.assign(new Error("user.password is required."), { status: 400 });
      }
      if (payload.user.roleId) {
        const role = await Role.findByPk(payload.user.roleId);
        if (!role) {
          throw Object.assign(new Error("Unknown roleId."), { status: 400 });
        }
      }
    }

    const result = await sequelize.transaction(async (tx) => {
      const person = await Person.create(
        {
          firstName: payload.firstName?.trim() || null,
          lastName: payload.lastName?.trim() || null,
          email: payload.email?.trim() || null,
        },
        { transaction: tx },
      );

      let userRow: User | null = null;
      if (payload.user) {
        const passwordHash = await bcrypt.hash(payload.user.password, 10);
        userRow = await User.create(
          {
            id: person.id,
            userName: payload.user.userName.trim(),
            displayName:
              payload.user.displayName?.trim() ||
              [person.firstName, person.lastName].filter(Boolean).join(" ") ||
              null,
            password: passwordHash,
            roleId: payload.user.roleId ?? null,
            userIdentity: payload.user.userIdentity ?? null,
          },
          { transaction: tx },
        );
      }

      let employeeRow: Employee | null = null;
      if (payload.employee) {
        employeeRow = await Employee.create(
          {
            id: person.id,
            jiraIdNumber: payload.employee.jiraIdNumber?.trim() || null,
          },
          { transaction: tx },
        );
      }

      return { person, userRow, employeeRow };
    });

    this.broadcast(
      "person_created",
      `Person "${[result.person.firstName, result.person.lastName].filter(Boolean).join(" ") || `#${result.person.id}`}" created`,
      {
        personId: result.person.id,
        isUser: !!result.userRow,
        isEmployee: !!result.employeeRow,
      },
      actorId,
    );

    logger.info("Person created", {
      personId: result.person.id,
      isUser: !!result.userRow,
      isEmployee: !!result.employeeRow,
    });

    return {
      person: {
        id: result.person.id,
        firstName: result.person.firstName,
        lastName: result.person.lastName,
        email: result.person.email,
        createdAt: result.person.createdAt,
      },
      user: result.userRow
        ? {
            id: result.userRow.id,
            userName: result.userRow.userName,
            displayName: result.userRow.displayName,
            roleId: result.userRow.roleId,
          }
        : null,
      employee: result.employeeRow
        ? {
            id: result.employeeRow.id,
            jiraIdNumber: result.employeeRow.jiraIdNumber,
          }
        : null,
    };
  }

  private broadcast(
    type: string,
    message: string,
    data: Record<string, unknown>,
    actorId: UserId,
  ) {
    try {
      getIO().emit("admin:change", { type, message, data, actorId });
    } catch (err) {
      logger.error("broadcastAdminChange error", { error: String(err) });
    }
  }
}
