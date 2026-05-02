"use strict";

/**
 * Persists when the current user-turn window opened on a roundtable.
 *
 * Background:
 *   The 5-minute deadline shown to participants when status flips to
 *   `waiting_for_user` was emitted only as `deadlineSeconds` on the
 *   `roundtable:user_turn` socket event. The client computed
 *   `Date.now() + 5 * 60 * 1000` from it. On a page refresh, the client
 *   never received that event, fell back to a generic
 *   "five minutes from now" heuristic in `fetchData()`, and the
 *   countdown reset every time. This column gives the server a single
 *   source of truth for the turn window so refresh, reconnect, and
 *   late-joining observers all see the same deadline.
 *
 * Behavior:
 *   - Worker stamps `user_turn_started_at = NOW()` whenever it emits
 *     `roundtable:user_turn` (initial user turn after agents finish a
 *     round, AND when handing off to the next user mid-round).
 *   - Worker clears it (set to NULL) on every other status transition
 *     so a stale timestamp can never linger past the window.
 *   - GET /roundtables/:id surfaces both the raw column and a derived
 *     `userTurnDeadlineAt`.
 *
 * Idempotent (`IF NOT EXISTS`) so this migration can rerun cleanly.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `ALTER TABLE roundtables
         ADD COLUMN IF NOT EXISTS user_turn_started_at TIMESTAMP WITH TIME ZONE`,
    );
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("roundtables", "user_turn_started_at");
  },
};
