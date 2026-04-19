import { Agent, AgentCronJob } from "@scheduling-agent/database";
import type { UserId } from "@scheduling-agent/types";
import { logger } from "../../logger";
import { getIO } from "../../sockets/server/socketServer";

export interface CronJobInput {
  name: string;
  prompt: string;
  cronExpression: string;
  timezone?: string;
  enabled?: boolean;
}

export interface CronJobPatch {
  name?: string;
  prompt?: string;
  cronExpression?: string;
  timezone?: string;
  enabled?: boolean;
}

/**
 * Cheap cron validator — accepts the common 5-field cron form
 * ("minute hour day-of-month month day-of-week"). BullMQ/cron-parser
 * does the final validation when the scheduler picks it up.
 */
function isValidCronExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return false;
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5) return false;
  // Each field: digits, `*`, `/`, `,`, `-`, `?`, letters (for day names) — loose but rejects garbage.
  return fields.every((f) => /^[\d*/,\-?A-Za-z]+$/.test(f));
}

function isValidTimezone(tz: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export class CronJobsService {
  async listForAgent(
    agentId: string,
    callerRole: string,
    callerOrgId: string,
  ) {
    await this.assertAgentAccess(agentId, callerRole, callerOrgId);
    return AgentCronJob.findAll({
      where: { agentId },
      order: [["created_at", "DESC"]],
    });
  }

  async create(
    agentId: string,
    input: CronJobInput,
    callerId: UserId,
    callerRole: string,
    callerOrgId: string,
  ) {
    const agent = await this.assertAgentAccess(agentId, callerRole, callerOrgId);

    const name = input.name?.trim();
    const prompt = input.prompt?.trim();
    const cronExpression = input.cronExpression?.trim();
    const timezone = input.timezone?.trim() || "UTC";

    if (!name) throw badRequest("name is required.");
    if (!prompt) throw badRequest("prompt is required.");
    if (!isValidCronExpression(cronExpression)) {
      throw badRequest("cronExpression is not a valid 5-field cron pattern.");
    }
    if (!isValidTimezone(timezone)) {
      throw badRequest(`timezone "${timezone}" is not a valid IANA zone.`);
    }

    const job = await AgentCronJob.create({
      agentId: agent.id,
      organizationId: agent.organizationId,
      createdByUserId: callerId,
      name,
      prompt,
      cronExpression,
      timezone,
      enabled: input.enabled ?? true,
    });

    this.broadcast(
      "cron_job_created",
      `Schedule "${job.name}" was created.`,
      { agentId, cronJobId: job.id, name: job.name },
      callerId,
    );
    return job;
  }

  async update(
    cronJobId: string,
    patch: CronJobPatch,
    callerId: UserId,
    callerRole: string,
    callerOrgId: string,
  ) {
    const job = await AgentCronJob.findByPk(cronJobId);
    if (!job) throw notFound("Cron job not found.");
    await this.assertAgentAccess(job.agentId, callerRole, callerOrgId);

    const update: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n) throw badRequest("name cannot be empty.");
      update.name = n;
    }
    if (patch.prompt !== undefined) {
      const p = patch.prompt.trim();
      if (!p) throw badRequest("prompt cannot be empty.");
      update.prompt = p;
    }
    if (patch.cronExpression !== undefined) {
      const c = patch.cronExpression.trim();
      if (!isValidCronExpression(c)) {
        throw badRequest("cronExpression is not a valid 5-field cron pattern.");
      }
      update.cronExpression = c;
    }
    if (patch.timezone !== undefined) {
      const tz = patch.timezone.trim() || "UTC";
      if (!isValidTimezone(tz)) {
        throw badRequest(`timezone "${tz}" is not a valid IANA zone.`);
      }
      update.timezone = tz;
    }
    if (patch.enabled !== undefined) update.enabled = patch.enabled;

    await job.update(update);
    this.broadcast(
      "cron_job_updated",
      `Schedule "${job.name}" was updated.`,
      { agentId: job.agentId, cronJobId: job.id, name: job.name },
      callerId,
    );
    return job;
  }

  async delete(
    cronJobId: string,
    callerId: UserId,
    callerRole: string,
    callerOrgId: string,
  ) {
    const job = await AgentCronJob.findByPk(cronJobId);
    if (!job) throw notFound("Cron job not found.");
    await this.assertAgentAccess(job.agentId, callerRole, callerOrgId);

    const deletedName = job.name;
    await job.destroy();
    this.broadcast(
      "cron_job_deleted",
      `Schedule "${deletedName}" was deleted.`,
      { agentId: job.agentId, cronJobId, name: deletedName },
      callerId,
    );
    return { deleted: true };
  }

  private async assertAgentAccess(
    agentId: string,
    _callerRole: string,
    callerOrgId: string,
  ) {
    // Super_admin is org-scoped too — no cross-tenant access through this API.
    const agent = await Agent.findOne({
      where: { id: agentId, organizationId: callerOrgId },
      attributes: ["id", "organizationId", "isLocked"],
    });
    if (!agent) throw notFound("Agent not found.");
    return agent;
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
      logger.error("cronJobs broadcast error", { error: String(err) });
    }
  }
}

function badRequest(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

function notFound(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}
