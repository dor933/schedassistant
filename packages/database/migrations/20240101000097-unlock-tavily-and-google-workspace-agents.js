"use strict";

/**
 * Unlocks the Tavily web-search and Google Workspace system agents across
 * every organization so super admins can change the underlying model that
 * runs them. These agents were originally seeded with `is_locked = true`
 * by migrations 83 (Tavily) and 96 (Google Workspace), but there's no
 * good reason to pin their model: the tools they expose (tavily_search,
 * google_*) are framework-agnostic and work with any chat model.
 *
 * The Gemini web-search agent (`web_search`) stays locked — it relies on
 * the `googleSearch` built-in grounding tool which is only available on
 * Google Gen AI models, so letting admins swap to a non-Google model would
 * break it.
 *
 * Also clears the cosmetic `locked: true` entry from `tool_config` on the
 * two unlocked agents. That key was never read by the runtime (the real
 * gate is `agents.is_locked`); dropping it avoids future confusion.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `UPDATE agents
          SET is_locked = false,
              tool_config = tool_config - 'locked',
              updated_at = NOW()
        WHERE type = 'system'
          AND slug IN ('web_search_tavily', 'google_workspace_agent')
          AND is_locked = true`,
    );
  },

  async down(queryInterface, _Sequelize) {
    // Restore the prior lock + cosmetic tool_config.locked flag.
    await queryInterface.sequelize.query(
      `UPDATE agents
          SET is_locked = true,
              tool_config = tool_config || '{"locked": true}'::jsonb,
              updated_at = NOW()
        WHERE type = 'system'
          AND slug IN ('web_search_tavily', 'google_workspace_agent')`,
    );
  },
};
