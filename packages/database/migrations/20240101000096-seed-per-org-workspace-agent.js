"use strict";

/**
 * Seeds ONE Google Workspace system agent per existing organization. "Google
 * Workspace" here means Google's SaaS suite — Gmail, Google Calendar, Google
 * Drive — NOT each agent's personal workspace folder (.md/.txt scratch area
 * managed by the separate workspace_* tools).
 *
 * The google_workspace_agent is the single point through which all google_*
 * tool calls are made — primary agents no longer carry those tools and
 * instead delegate to this agent via `delegate_to_deep_agent`.
 *
 * Permission inheritance: the google_* tools key their AgentUserScope check
 * to the *caller* agent id (not this system agent), so a primary's grants
 * are what authorize the operation. This agent just owns the tool bindings
 * at runtime (gated by tool_config.useGoogleWorkspaceTools in the deep agent
 * worker).
 *
 * Skips orgs that already have a google_workspace_agent (idempotent re-run).
 * Also migrates any legacy `workspace_agent` rows inserted by an earlier
 * iteration of this migration to the new slug + tool_config shape.
 *
 * @type {import('sequelize-cli').Migration}
 */

const WORKSPACE_INSTRUCTIONS =
  "You are THE dedicated Google Workspace system agent for this organization. " +
  "All Gmail, Google Calendar, and Google Drive operations from other agents are routed directly to you.\n\n" +
  "You have access to these tools:\n" +
  "- `google_list_calendar_events`, `google_create_calendar_event` (Calendar)\n" +
  "- `google_list_drive_files`, `google_read_drive_file`, `google_write_drive_file` (Drive)\n" +
  "- `google_list_gmail_messages`, `google_send_gmail` (Gmail)\n\n" +
  "Each tool takes a `subjectEmail` — the workspace email of the user whose data " +
  "you are acting on. The delegating agent always hands off the target user's EMAIL " +
  "ADDRESS plus the operation to perform; your job is to translate that into the " +
  "correct tool call. Never ask for or invent an internal user id — always use the " +
  "email the caller gave you.\n\n" +
  "If a tool returns an authorization error, report it clearly to the caller — do NOT " +
  "retry with a different email. Permissions are gated per (calling agent, subject " +
  "user, scope); the authorization check runs against the calling agent, not you, so " +
  "you inherit its grants.\n\n" +
  "Be precise: return the data you fetched or the ID of the resource you created/sent, " +
  "and keep responses structured so the calling agent can use them directly.";

const WORKSPACE_DESCRIPTION =
  "Performs Google Workspace operations on behalf of primary agents — Gmail (list/send), Google Calendar (list/create events), and Google Drive (list/read/write files). Inherits permissions from the calling agent.";

module.exports = {
  async up(queryInterface, _Sequelize) {
    // 1. Migrate any legacy `workspace_agent` rows from earlier iterations of
    // this migration (renamed to `google_workspace_agent` to disambiguate
    // from the agent workspace folder concept).
    await queryInterface.sequelize.query(
      `UPDATE agents
          SET slug = 'google_workspace_agent',
              agent_name = 'Google Workspace Agent',
              description = :description,
              instructions = :instructions,
              tool_config = '{"useGoogleWorkspaceTools": true, "locked": true}'::jsonb,
              updated_at = NOW()
        WHERE slug = 'workspace_agent'
          AND type = 'system'`,
      {
        replacements: {
          description: WORKSPACE_DESCRIPTION,
          instructions: WORKSPACE_INSTRUCTIONS,
        },
      },
    );

    // 2. Resolve the model id for claude-sonnet-4-6 once — used for every seeded row.
    const [models] = await queryInterface.sequelize.query(
      `SELECT id FROM models WHERE slug = 'claude-sonnet-4-6' LIMIT 1`,
    );
    const modelId = models.length > 0 ? models[0].id : null;

    await queryInterface.sequelize.query(
      `INSERT INTO agents (
         id, type, slug, agent_name, description, instructions,
         model_slug, model_id, tool_config, is_locked, organization_id,
         created_at, updated_at
       )
       SELECT
         gen_random_uuid(),
         'system',
         'google_workspace_agent',
         'Google Workspace Agent',
         :description,
         :instructions,
         'claude-sonnet-4-6',
         CAST(:modelId AS uuid),
         '{"useGoogleWorkspaceTools": true, "locked": true}'::jsonb,
         true,
         o.id,
         NOW(),
         NOW()
       FROM organizations o
       WHERE NOT EXISTS (
         SELECT 1 FROM agents a
          WHERE a.organization_id = o.id
            AND a.slug = 'google_workspace_agent'
            AND a.type = 'system'
       )`,
      {
        replacements: {
          modelId,
          instructions: WORKSPACE_INSTRUCTIONS,
          description: WORKSPACE_DESCRIPTION,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM agents WHERE slug IN ('google_workspace_agent', 'workspace_agent') AND type = 'system'`,
    );
  },
};
