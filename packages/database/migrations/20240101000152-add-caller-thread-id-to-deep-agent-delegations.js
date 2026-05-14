"use strict";

/**
 * Add `deep_agent_delegations.caller_thread_id` — the langgraph thread that
 * was active on the caller agent when the delegate tool fired.
 *
 * Why we need it: the caller's `active_thread_id` can rotate (after
 * summarization) while the deep agent is still running. When the result
 * comes back, we need to know which thread originally initiated the
 * delegation so we can (a) annotate the result with a pointer to that
 * thread's `/threads/<id>/` workspace folder, and (b) reason about whether
 * cross-thread context-stitching is needed at delivery time.
 *
 * Until now the caller's thread-id was only forwarded inside the BullMQ
 * job payload (`DeepAgentJobData.callerThreadId`) and used solely for
 * scoping the executor's filesystem writes. Promoting it to a column
 * gives us a durable, queryable record per delegation.
 *
 * Nullable on purpose: pre-existing rows have no thread-id to backfill,
 * and a delegation triggered from a code path without a thread (e.g. a
 * future REST trigger) should still be valid.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("deep_agent_delegations", "caller_thread_id", {
      type: Sequelize.UUID,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("deep_agent_delegations", "caller_thread_id");
  },
};
