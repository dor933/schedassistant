import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AgentCronJob } from "@scheduling-agent/database";

/**
 * Lists the calling agent's own cron jobs (schedules).
 *
 * Scoped to the closure-captured `agentId` — the agent can only see its own
 * schedules, never another agent's. No LLM-provided arguments.
 *
 * Cron jobs are configured by admins through the user_app admin UI and stored
 * in `agent_cron_jobs`; the agent can't create/edit/delete them, only inspect.
 */
export function ListCronJobsTool(agentId: string) {
  return tool(
    async () => {
      const jobs = await AgentCronJob.findAll({
        where: { agentId },
        attributes: [
          "id",
          "name",
          "prompt",
          "cronExpression",
          "timezone",
          "enabled",
          "lastRunAt",
          "lastStatus",
          "lastError",
        ],
        order: [["createdAt", "ASC"]],
      });

      if (jobs.length === 0) {
        return "You have no cron jobs (scheduled runs) configured.";
      }

      const lines = [
        `You have ${jobs.length} cron job${jobs.length === 1 ? "" : "s"} configured:`,
        "",
      ];
      for (const j of jobs) {
        lines.push(`**${j.name}** ${j.enabled ? "(enabled)" : "(disabled)"}`);
        lines.push(`  - Schedule: \`${j.cronExpression}\` (${j.timezone})`);
        lines.push(`  - Prompt: ${j.prompt}`);
        if (j.lastRunAt) {
          const when = j.lastRunAt.toISOString();
          const status = j.lastStatus ?? "unknown";
          lines.push(`  - Last run: ${when} — ${status}`);
          if (j.lastStatus === "failed" && j.lastError) {
            lines.push(`  - Last error: ${j.lastError}`);
          }
        } else {
          lines.push(`  - Last run: never`);
        }
        lines.push("");
      }
      return lines.join("\n").trimEnd();
    },
    {
      name: "list_cron_jobs",
      description:
        "Lists your own scheduled runs (cron jobs). " +
        "Each cron job is a prompt that the system runs on your behalf on a recurring schedule " +
        "(defined by a 5-field cron expression and an IANA timezone). " +
        "Use this to understand what recurring tasks you're already responsible for — " +
        "e.g. before promising a user a new daily digest, check whether a similar one is already scheduled. " +
        "For each job you get: name, cron expression, timezone, enabled/disabled, the prompt that runs, " +
        "and the timestamp + status of the last run (including the error message if the last run failed).",
      schema: z.object({}),
    },
  );
}
