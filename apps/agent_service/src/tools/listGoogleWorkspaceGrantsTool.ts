import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { AgentUserScope, User } from "@scheduling-agent/database";
import { Op } from "sequelize";
import { logger } from "../logger";

/**
 * Returns the set of Google Workspace users (by email) that `authorityAgentId`
 * is permitted to act on, grouped by user with the list of granted scopes.
 *
 * NOTE: "Google Workspace" here means Google's SaaS suite — Gmail, Calendar,
 * Drive. It has nothing to do with each agent's personal *workspace folder*
 * (which holds .md/.txt files and is managed via the separate `workspace_*`
 * tools).
 *
 * Primary agents call this BEFORE delegating a Gmail/Calendar/Drive operation
 * to the `google_workspace_agent` system agent, to discover which email +
 * scope to hand off. The google_workspace_agent is the specialist that
 * translates an email + operation into the actual Google API call.
 */
export function ListGoogleWorkspaceGrantsTool(authorityAgentId: string) {
  return tool(
    async () => {
      try {
        const grants = await AgentUserScope.findAll({
          where: { agentId: authorityAgentId },
          attributes: ["subjectUserId", "scope"],
        });

        if (grants.length === 0) {
          return JSON.stringify({
            count: 0,
            users: [],
            note:
              "You have no Google Workspace (Gmail/Calendar/Drive) grants. Ask a super admin " +
              "to grant you access in Admin → Google Permissions before attempting any Gmail, " +
              "Google Calendar, or Google Drive operation.",
          });
        }

        const subjectIds = [...new Set(grants.map((g) => g.subjectUserId))];
        const users = await User.findAll({
          where: { id: { [Op.in]: subjectIds } },
          attributes: ["id", "userName", "displayName", "authProvider", "externalSub"],
        });
        const userById = new Map(users.map((u) => [u.id, u]));

        const scopesByUser = new Map<number, Set<string>>();
        for (const g of grants) {
          const set = scopesByUser.get(g.subjectUserId) ?? new Set<string>();
          set.add(g.scope);
          scopesByUser.set(g.subjectUserId, set);
        }

        const rows: Array<{
          email: string;
          displayName: string | null;
          scopes: string[];
          googleAuthed: boolean;
        }> = [];
        for (const [subjectUserId, scopeSet] of scopesByUser) {
          const u = userById.get(subjectUserId);
          if (!u) continue;
          rows.push({
            email: u.userName,
            displayName: u.displayName,
            scopes: [...scopeSet].sort(),
            googleAuthed: u.authProvider === "google" && !!u.externalSub,
          });
        }
        rows.sort((a, b) => a.email.localeCompare(b.email));

        return JSON.stringify({
          count: rows.length,
          users: rows,
          note:
            "Delegate Google Workspace (Gmail/Calendar/Drive) operations to the " +
            "`google_workspace_agent` using the user's email address (not an ID). The " +
            "google_workspace_agent will translate email + operation into the actual Gmail / " +
            "Calendar / Drive call. Users with googleAuthed=false cannot be impersonated " +
            "even if scopes are granted.",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn("list_google_workspace_grants failed", {
          authorityAgentId,
          error: msg,
        });
        return `Error listing Google Workspace grants: ${msg}`;
      }
    },
    {
      name: "list_google_workspace_grants",
      description:
        "List the Google Workspace users (by email) you are permitted to act on for Gmail, " +
        "Google Calendar, and Google Drive operations, along with the granted scopes per " +
        "user (calendar.read, calendar.write, drive.read, drive.write, gmail.read, " +
        "gmail.send). This is about Google's SaaS suite — NOT your own agent workspace " +
        "folder. Call this BEFORE delegating a Gmail / Calendar / Drive task to the " +
        "`google_workspace_agent` so you pass the correct email and know which operations " +
        "are allowed. Takes no arguments.",
      schema: z.object({}),
    },
  );
}
