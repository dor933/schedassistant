"use strict";

/**
 * Adds a third per-organization web-search system agent powered by the
 * Claude Agent SDK's hosted `WebSearch` built-in. Sits alongside the
 * existing two (`web_search` / Gemini, `web_search_tavily` / Tavily) so
 * admins can pick whichever billing path makes sense for their tenant —
 * Anthropic-hosted search is billed against the same OAuth token / API
 * key the agent already uses, so orgs on Pro/Max subscriptions get
 * search "for free" against their existing seat.
 *
 * Wiring:
 *   - slug             : `web_search_anthropic`
 *   - tool_config      : `{ "useAnthropicWebSearch": true }` — read by the
 *                        deep-agent worker, threaded through to
 *                        `runAnthropicAgentSdk` which adds `WebSearch` to
 *                        the SDK's `allowedTools` list. Mirrors the
 *                        existing `googleSearch` / `useTavily` pattern.
 *   - model            : `claude-sonnet-4-6` — Claude is required because
 *                        `WebSearch` is an Anthropic-hosted server tool.
 *                        Locked? No — admins may swap to a different
 *                        Anthropic-vendor model (opus, haiku, etc.) so we
 *                        leave `is_locked = false` to match the Tavily row.
 *   - org pointer      : the existing `organizations.web_search_agent_id`
 *                        column already discriminates which of the three
 *                        is active; nothing schema-side needs adding.
 *
 * Idempotency: ON CONFLICT DO NOTHING on the (organization_id, slug) tuple
 * so re-running the migration is a no-op.
 *
 * @type {import('sequelize-cli').Migration}
 */

const ANTHROPIC_INSTRUCTIONS =
  "You are THE dedicated web-search system agent for this organization. " +
  "All web searches from other agents are routed directly to you. " +
  "Use the built-in `WebSearch` tool (Anthropic-hosted) to find accurate, " +
  "up-to-date information from the internet. Summarize findings clearly, " +
  "cite sources when possible, and return the most relevant results.";

module.exports = {
  async up(queryInterface, _Sequelize) {
    // Resolve the Anthropic model id used as the default for the new
    // agent. `claude-sonnet-4-6` is the cheapest current Sonnet that
    // supports the hosted `WebSearch` server tool. If the slug isn't in
    // the catalog (older deploys), fall back to whichever Sonnet exists.
    const [models] = await queryInterface.sequelize.query(
      `SELECT id FROM models
        WHERE slug = 'claude-sonnet-4-6'
        LIMIT 1`,
    );
    const modelId = models.length > 0 ? models[0].id : null;
    if (!modelId) {
      // No suitable Anthropic model in the catalog — skip seeding so we
      // don't insert rows that point at a missing model. New deploys with
      // the catalog already in place will satisfy the lookup; older
      // deploys can re-run after their model catalog catches up.
      // eslint-disable-next-line no-console
      console.warn(
        "[migration 128] claude-sonnet-4-6 not found in models catalog — " +
          "skipping web_search_anthropic seed. Re-run after the model is added.",
      );
      return;
    }

    // Seed one `web_search_anthropic` system agent per existing org. We
    // intentionally do NOT change the org's `web_search_agent_id` pointer
    // here — admins flip to the new agent via the existing admin UI when
    // they're ready. The default for already-bootstrapped orgs stays on
    // whatever they had before.
    await queryInterface.sequelize.query(
      `INSERT INTO agents (
         id, type, slug, agent_name, description, instructions,
         model_slug, model_id, tool_config, is_locked, organization_id,
         allow_sdk_builtins, allow_sdk_bash,
         created_at, updated_at
       )
       SELECT
         gen_random_uuid(),
         'system',
         'web_search_anthropic',
         'Web Search Agent (Anthropic)',
         'Searches the web using the Claude Agent SDK''s hosted WebSearch tool. Billed against the org''s Anthropic credential — no extra API key needed.',
         :instructions,
         'claude-sonnet-4-6',
         CAST(:modelId AS uuid),
         '{"useAnthropicWebSearch": true}'::jsonb,
         false,
         o.id,
         true,
         false,
         NOW(),
         NOW()
       FROM organizations o
       WHERE NOT EXISTS (
         SELECT 1 FROM agents a
          WHERE a.organization_id = o.id
            AND a.type = 'system'
            AND a.slug = 'web_search_anthropic'
       )`,
      {
        replacements: {
          modelId,
          instructions: ANTHROPIC_INSTRUCTIONS,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    // Clear the org pointer first for any org that has flipped to this
    // agent — null is safe (the resolver falls back to whichever
    // candidate exists). Then delete the rows.
    await queryInterface.sequelize.query(
      `UPDATE organizations
          SET web_search_agent_id = NULL,
              updated_at = NOW()
        WHERE web_search_agent_id IN (
          SELECT id FROM agents
           WHERE type = 'system' AND slug = 'web_search_anthropic'
        )`,
    );
    await queryInterface.sequelize.query(
      `DELETE FROM agents
        WHERE type = 'system'
          AND slug = 'web_search_anthropic'`,
    );
  },
};
