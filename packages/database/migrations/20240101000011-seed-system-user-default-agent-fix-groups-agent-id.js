"use strict";

/**
 * Make groups.agent_id NOT NULL (backfill existing rows first).
 *
 * Originally also seeded a shared "System Admin" user (id=1) so the very first
 * deploy had a signable admin account. That seed is gone — every tenant now
 * gets its own super_admin on first Google SSO bootstrap (or via the manual
 * onboarding wizard), so there is no reason to ship a hardcoded password in a
 * migration. The groups.agent_id tightening below is preserved because later
 * migrations assume the column is NOT NULL.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    // Backfill any existing groups that have NULL agent_id. Ancient fixtures
    // may still have them; pick any agent so the NOT NULL enforcement below
    // doesn't crash.
    await queryInterface.sequelize.query(
      `UPDATE groups SET agent_id = (SELECT id FROM agents LIMIT 1) WHERE agent_id IS NULL`,
    );

    await queryInterface.sequelize.query(
      `ALTER TABLE groups ALTER COLUMN agent_id SET NOT NULL`,
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TABLE groups ALTER COLUMN agent_id DROP NOT NULL`,
    );
  },
};
