"use strict";

/**
 * agent_user_scopes — per-agent, per-subject-user Google operation grants.
 *
 * One row = "agent X may perform scope Y on data belonging to user Z".
 * The subject is the user whose Google data is being touched, NOT the user
 * who happens to be chatting with the agent. This lets us express grants
 * like "marketing-bot can read calendar of user A and user B, but not C"
 * without entangling the agent's runtime identity with the authorization
 * question.
 *
 * org_id is denormalized from both agent and subject so we can index and
 * filter quickly; a runtime guard asserts agent.org_id === subject.org_id
 * before insert, and the unique index on (agent_id, subject_user_id, scope)
 * prevents duplicate grants.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("agent_user_scopes", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },
      agent_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      subject_user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      organization_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "organizations", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      scope: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      granted_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      granted_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
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

    // Scope is a closed enum — new Google operations must be added via a
    // follow-up migration. Keeping the list small and explicit makes audits
    // feasible and prevents typos from silently authorizing nothing.
    await queryInterface.sequelize.query(`
      ALTER TABLE agent_user_scopes
      ADD CONSTRAINT agent_user_scopes_scope_check
      CHECK (scope IN (
        'calendar.read',
        'calendar.write',
        'drive.read',
        'drive.write',
        'gmail.read',
        'gmail.send'
      ))
    `);

    await queryInterface.addIndex(
      "agent_user_scopes",
      ["agent_id", "subject_user_id", "scope"],
      { unique: true, name: "agent_user_scopes_unique" },
    );
    await queryInterface.addIndex("agent_user_scopes", ["organization_id"], {
      name: "agent_user_scopes_organization_id",
    });
    await queryInterface.addIndex("agent_user_scopes", ["subject_user_id"], {
      name: "agent_user_scopes_subject_user_id",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      "agent_user_scopes",
      "agent_user_scopes_unique",
    );
    await queryInterface.removeIndex(
      "agent_user_scopes",
      "agent_user_scopes_organization_id",
    );
    await queryInterface.removeIndex(
      "agent_user_scopes",
      "agent_user_scopes_subject_user_id",
    );
    await queryInterface.dropTable("agent_user_scopes");
  },
};
