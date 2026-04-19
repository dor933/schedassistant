"use strict";

/**
 * Historical: this migration used to seed a single global "Epic Orchestrator"
 * agent under the Default organization. That row became cross-tenant noise
 * once every new org started provisioning its OWN epic orchestrator via
 * `apps/user_app/src/services/admin/orgAgentSeeder.ts`, so the global seed
 * was removed.
 *
 * Left as a no-op to keep `SequelizeMeta` consistent on environments that
 * have already recorded this migration.
 *
 * @type {import('sequelize-cli').Migration}
 */

module.exports = {
  async up() {},
  async down() {},
};
