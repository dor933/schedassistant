"use strict";

/**
 * Agent cron jobs — scheduled prompts that re-invoke an agent on a cron cadence.
 *
 * One row = one schedule for one agent. The scheduler (agent_service) keeps
 * BullMQ repeatable jobs in sync with this table; on each tick the worker
 * enqueues a regular `agent_chat_jobs` entry using the job's `prompt`.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("agent_cron_jobs", {
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
      organization_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "organizations", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "RESTRICT",
      },
      created_by_user_id: {
        type: Sequelize.INTEGER,
        allowNull: true,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      prompt: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      cron_expression: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      timezone: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "UTC",
      },
      enabled: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
      },
      last_run_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      last_status: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      last_error: {
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

    await queryInterface.addIndex("agent_cron_jobs", ["agent_id"], {
      name: "agent_cron_jobs_agent_id",
    });
    await queryInterface.addIndex("agent_cron_jobs", ["organization_id"], {
      name: "agent_cron_jobs_organization_id",
    });
    await queryInterface.addIndex("agent_cron_jobs", ["enabled"], {
      name: "agent_cron_jobs_enabled",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("agent_cron_jobs", "agent_cron_jobs_agent_id");
    await queryInterface.removeIndex("agent_cron_jobs", "agent_cron_jobs_organization_id");
    await queryInterface.removeIndex("agent_cron_jobs", "agent_cron_jobs_enabled");
    await queryInterface.dropTable("agent_cron_jobs");
  },
};
