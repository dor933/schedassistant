"use strict";

/**
 * Stores newsletter issue records. Primary agents get explicit tools to create
 * a record, update same-day replacement paths, and retrieve the latest issue by
 * type. Google Workspace/deep agents do not get these record-management tools.
 *
 * @type {import('sequelize-cli').Migration}
 */

const TOOL = {
  name: "Get Latest Newsletter Issue",
  slug: "get_latest_newsletter_issue",
  category: "data",
  description:
    "Retrieve the latest archived newsletter issue for a newsletter type, including file paths and summary context.",
};

const RECORD_TOOL = {
  name: "Record Newsletter Issue",
  slug: "record_newsletter_issue",
  category: "data",
  description:
    "Create a newsletter issue record after a newsletter file is prepared or sent.",
};

const UPDATE_PATH_TOOL = {
  name: "Update Newsletter Issue Path",
  slug: "update_newsletter_issue_path",
  category: "data",
  description:
    "Update the file path fields on an existing newsletter issue record, usually for a revised same-day issue.",
};

const TOOLS = [TOOL, RECORD_TOOL, UPDATE_PATH_TOOL];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("newsletter_issues", {
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
        onDelete: "CASCADE",
      },
      type: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "generated",
      },
      subject: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      issue_date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_DATE"),
      },
      as_of_date: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      file_uri: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      payload_uri: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      html_uri: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      summary: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      sent_message_id: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      sent_thread_id: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      created_by_agent_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
      sent_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: {},
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

    await queryInterface.sequelize.query(
      `ALTER TABLE newsletter_issues
       ADD CONSTRAINT newsletter_issues_type_check
       CHECK (type IN ('top20_stocks', 'financial_news'))`,
    );
    await queryInterface.sequelize.query(
      `ALTER TABLE newsletter_issues
       ADD CONSTRAINT newsletter_issues_status_check
       CHECK (status IN ('generated', 'sent', 'failed'))`,
    );
    await queryInterface.sequelize.query(
      `CREATE INDEX newsletter_issues_org_type_sent_at_idx
       ON newsletter_issues (organization_id, type, sent_at DESC, created_at DESC)`,
    );
    await queryInterface.sequelize.query(
      `CREATE INDEX newsletter_issues_org_type_issue_date_idx
       ON newsletter_issues (organization_id, type, issue_date, created_at DESC)`,
    );
    await queryInterface.addIndex("newsletter_issues", ["sent_message_id"], {
      name: "newsletter_issues_sent_message_id",
    });

    for (const tool of TOOLS) {
      await queryInterface.sequelize.query(
        `INSERT INTO tools (name, slug, description, category, created_at, updated_at)
         VALUES (:name, :slug, :description, :category, NOW(), NOW())
         ON CONFLICT (slug) DO NOTHING`,
        { replacements: tool },
      );
    }

    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_tools (agent_id, tool_id, active, created_at)
       SELECT agents.id, tools.id, true, NOW()
       FROM agents
       CROSS JOIN tools
       WHERE agents.type = 'primary'
         AND tools.slug IN (:slugs)
       ON CONFLICT (agent_id, tool_id) DO NOTHING`,
      { replacements: { slugs: TOOLS.map((tool) => tool.slug) } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_tools
       WHERE tool_id IN (SELECT id FROM tools WHERE slug IN (:slugs))`,
      { replacements: { slugs: TOOLS.map((tool) => tool.slug) } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM tools WHERE slug IN (:slugs)`,
      { replacements: { slugs: TOOLS.map((tool) => tool.slug) } },
    );
    await queryInterface.dropTable("newsletter_issues");
  },
};
