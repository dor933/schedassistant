"use strict";

/**
 * Adds the infrastructure for application-agent end-user mirroring and
 * conversation continuity:
 *
 *   1. `client_applications` — catalog of upstream apps that may invoke
 *      application agents. Each row owns a hashed API token (replaces the
 *      single-secret APPLICATION_AGENT_API_TOKEN env var when populated)
 *      and is scoped to one organization.
 *
 *   2. `users` extension — columns that mark a user as JIT-mirrored from a
 *      client app:
 *        - client_application_id : FK to the originating client app (nullable
 *                                  for native users).
 *        - external_metadata     : JSONB payload the client may push to enrich
 *                                  the agent's view of the user.
 *        - external_synced_at    : last time we refreshed cached fields.
 *        - deleted_at            : soft-delete timestamp (GDPR / lifecycle).
 *      The existing `external_sub` column carries the client-side user id
 *      string. A partial unique index ensures one row per
 *      (client_application_id, external_sub).
 *
 *   3. `application_agent_threads` — stable LangGraph thread per
 *      (user_id, application_agent_id) pair. Looked up on every invocation
 *      so the same end user resumes their existing conversation with each
 *      application agent, regardless of whether they reach it via REST or
 *      via a primary's `invoke_application_agent` tool call.
 *
 * Notes:
 *   - Native chat users (auth_provider='local'/'google') keep working unchanged.
 *   - Client-app users use a new conventional auth_provider value 'client_app'
 *     (no DB CHECK on that column today, so no constraint change needed).
 *     The existing login endpoint already rejects any non-'local' user with a
 *     clear error, so no chat-UI guard change is required either.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    // ── 1. client_applications ─────────────────────────────────────────────
    await queryInterface.createTable("client_applications", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      organization_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "organizations", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      api_token_hash: {
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
    await queryInterface.addIndex("client_applications", ["slug"], {
      name: "client_applications_slug_unique",
      unique: true,
    });
    await queryInterface.addIndex("client_applications", ["organization_id"], {
      name: "client_applications_organization_id",
    });

    // ── 2. users extension ────────────────────────────────────────────────
    await queryInterface.addColumn("users", "client_application_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "client_applications", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "RESTRICT",
    });
    await queryInterface.addColumn("users", "external_metadata", {
      type: Sequelize.JSONB,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "external_synced_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
    await queryInterface.addColumn("users", "deleted_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });

    // One row per (client_application_id, external_sub). Distinct from the
    // existing (auth_provider, external_sub) partial index used by Google SSO
    // — both can coexist because the predicates don't overlap (Google rows
    // have client_application_id IS NULL).
    await queryInterface.sequelize.query(
      `CREATE UNIQUE INDEX users_client_app_external_uniq
         ON users (client_application_id, external_sub)
         WHERE client_application_id IS NOT NULL`,
    );

    // ── 3. application_agent_threads ──────────────────────────────────────
    await queryInterface.createTable("application_agent_threads", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      application_agent_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      thread_id: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      last_used_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });
    await queryInterface.addIndex(
      "application_agent_threads",
      ["user_id", "application_agent_id"],
      {
        name: "application_agent_threads_user_agent_unique",
        unique: true,
      },
    );
    await queryInterface.addIndex("application_agent_threads", ["thread_id"], {
      name: "application_agent_threads_thread_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("application_agent_threads");

    await queryInterface.sequelize.query(
      `DROP INDEX IF EXISTS users_client_app_external_uniq`,
    );
    await queryInterface.removeColumn("users", "deleted_at");
    await queryInterface.removeColumn("users", "external_synced_at");
    await queryInterface.removeColumn("users", "external_metadata");
    await queryInterface.removeColumn("users", "client_application_id");

    await queryInterface.dropTable("client_applications");
  },
};
