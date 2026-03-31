"use strict";

/**
 * Add a unique `user_name` column to `users` for login purposes.
 * Backfill existing users with a sanitised version of their display_name or id.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. Add the column (nullable first so we can backfill)
    await queryInterface.addColumn("users", "user_name", {
      type: Sequelize.STRING,
      allowNull: true,
      unique: true,
    });

    // 2. Backfill: use lower-cased display_name stripped of non-alphanumeric,
    //    falling back to the user id itself.
    await queryInterface.sequelize.query(`
      UPDATE users
      SET user_name = COALESCE(
        NULLIF(
          LOWER(REGEXP_REPLACE(display_name, '[^a-zA-Z0-9_]', '', 'g')),
          ''
        ),
        'user' || id::text
      )
      WHERE user_name IS NULL
    `);

    await queryInterface.sequelize.query(`
      UPDATE users SET user_name = 'system' WHERE id = 1 AND (user_name IS NULL OR user_name = '')
    `);

    // 3. Deduplicate: append a suffix for any collisions
    await queryInterface.sequelize.query(`
      WITH dupes AS (
        SELECT id, user_name,
               ROW_NUMBER() OVER (PARTITION BY user_name ORDER BY created_at ASC) AS rn
        FROM users
      )
      UPDATE users u
      SET user_name = u.user_name || dupes.rn::text
      FROM dupes
      WHERE dupes.id = u.id AND dupes.rn > 1
    `);

    // 4. Make NOT NULL now that all rows have a value
    await queryInterface.sequelize.query(`
      ALTER TABLE users ALTER COLUMN user_name SET NOT NULL
    `);
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeColumn("users", "user_name");
  },
};
