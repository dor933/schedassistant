"use strict";

/**
 * Introduce a dedicated capabilities surface for SDK-native tools (filesystem,
 * Bash) so the `mcp_servers` table can go back to representing ONLY external
 * MCP subprocesses.
 *
 * Why split: the legacy boolean columns `agents.allow_sdk_builtins` and
 * `agents.allow_sdk_bash` mixed the "do you have the SDK built-in tools"
 * concept into the `agents` table, which made the admin UI confusing —
 * filesystem capability could be either an attached `filesystem` MCP row
 * (subprocess) or the boolean flag (SDK built-in), with no unified place
 * to see what an agent actually has. Promoting the SDK capabilities into
 * their own table + junction gives the UI a single rendering target and
 * removes the two-sources-of-truth seam.
 *
 * Tables:
 *   - `sdk_capabilities` — small enum table, currently 2 rows:
 *       * `filesystem` → activates the SDK Read/Write/Edit/MultiEdit/
 *         Glob/Grep/WebFetch built-ins (was `allow_sdk_builtins=true`).
 *       * `bash` → activates the SDK `Bash` tool, plus drives Codex's
 *         `danger-full-access` vs `workspace-write` sandbox pick (was
 *         `allow_sdk_bash=true`).
 *   - `agent_sdk_capabilities` — junction (agent_id × sdk_capability_id),
 *     mirrors `agent_available_mcp_servers` shape so admin UX is uniform.
 *
 * Backfill: every agent row that had `allow_sdk_builtins = true` gets a
 * junction row for `filesystem`; ditto `allow_sdk_bash` → `bash`. After
 * backfill the two boolean columns are DROPPED — the junction is the sole
 * source of truth.
 *
 * Down migration re-adds both columns (default true) and backfills them
 * from the junction before dropping the new tables.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. sdk_capabilities table + seed ─────────────────────────────────
    await queryInterface.createTable("sdk_capabilities", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    const now = new Date();
    await queryInterface.bulkInsert("sdk_capabilities", [
      {
        slug: "filesystem",
        name: "Filesystem (SDK built-ins)",
        description:
          "Exposes the Claude Agent SDK's built-in filesystem tools to the " +
          "agent: Read, Write, Edit, MultiEdit, Glob, Grep, WebFetch. Replaces " +
          "the legacy `allow_sdk_builtins` boolean. The mcp_servers `filesystem` " +
          "row remains for explicit external-MCP attachments only.",
        created_at: now,
        updated_at: now,
      },
      {
        slug: "bash",
        name: "Bash (SDK built-in)",
        description:
          "Exposes the Claude Agent SDK's built-in `Bash` tool. For Codex " +
          "agents this same capability also picks the sandbox mode " +
          "(`danger-full-access` when set, `workspace-write` when not). " +
          "Replaces the legacy `allow_sdk_bash` boolean.",
        created_at: now,
        updated_at: now,
      },
    ]);

    // ── 2. agent_sdk_capabilities junction ──────────────────────────────
    await queryInterface.createTable("agent_sdk_capabilities", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      agent_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agents", key: "id" },
        onDelete: "CASCADE",
        onUpdate: "CASCADE",
      },
      sdk_capability_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "sdk_capabilities", key: "id" },
        onDelete: "CASCADE",
        onUpdate: "CASCADE",
      },
      active: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });
    await queryInterface.addConstraint("agent_sdk_capabilities", {
      type: "unique",
      name: "agent_sdk_capabilities_agent_id_sdk_capability_id_key",
      fields: ["agent_id", "sdk_capability_id"],
    });

    // ── 3. Backfill from the existing boolean columns ────────────────────
    // Each agent that had `allow_sdk_builtins = true` gets a `filesystem`
    // row; each that had `allow_sdk_bash = true` gets a `bash` row. Both
    // SELECTs are correlated to the junction's NOT EXISTS clause so the
    // migration is rerun-safe (no UNIQUE violation if partially applied).
    await queryInterface.sequelize.query(`
      INSERT INTO agent_sdk_capabilities (agent_id, sdk_capability_id, active, created_at)
      SELECT a.id,
             (SELECT id FROM sdk_capabilities WHERE slug = 'filesystem'),
             true,
             NOW()
        FROM agents a
       WHERE a.allow_sdk_builtins = true
         AND NOT EXISTS (
           SELECT 1 FROM agent_sdk_capabilities asc2
            WHERE asc2.agent_id = a.id
              AND asc2.sdk_capability_id = (SELECT id FROM sdk_capabilities WHERE slug = 'filesystem')
         )
    `);
    await queryInterface.sequelize.query(`
      INSERT INTO agent_sdk_capabilities (agent_id, sdk_capability_id, active, created_at)
      SELECT a.id,
             (SELECT id FROM sdk_capabilities WHERE slug = 'bash'),
             true,
             NOW()
        FROM agents a
       WHERE a.allow_sdk_bash = true
         AND NOT EXISTS (
           SELECT 1 FROM agent_sdk_capabilities asc2
            WHERE asc2.agent_id = a.id
              AND asc2.sdk_capability_id = (SELECT id FROM sdk_capabilities WHERE slug = 'bash')
         )
    `);

    // ── 4. Drop the legacy boolean columns ───────────────────────────────
    await queryInterface.removeColumn("agents", "allow_sdk_builtins");
    await queryInterface.removeColumn("agents", "allow_sdk_bash");
  },

  async down(queryInterface, Sequelize) {
    // Re-add the columns (default true matches the post-125/126 default).
    await queryInterface.addColumn("agents", "allow_sdk_builtins", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });
    await queryInterface.addColumn("agents", "allow_sdk_bash", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    });

    // Backfill from the junction.
    await queryInterface.sequelize.query(`
      UPDATE agents a
         SET allow_sdk_builtins = EXISTS (
               SELECT 1 FROM agent_sdk_capabilities asc2
                JOIN sdk_capabilities sc ON sc.id = asc2.sdk_capability_id
                WHERE asc2.agent_id = a.id
                  AND sc.slug = 'filesystem'
             )
    `);
    await queryInterface.sequelize.query(`
      UPDATE agents a
         SET allow_sdk_bash = EXISTS (
               SELECT 1 FROM agent_sdk_capabilities asc2
                JOIN sdk_capabilities sc ON sc.id = asc2.sdk_capability_id
                WHERE asc2.agent_id = a.id
                  AND sc.slug = 'bash'
             )
    `);

    await queryInterface.dropTable("agent_sdk_capabilities");
    await queryInterface.dropTable("sdk_capabilities");
  },
};
