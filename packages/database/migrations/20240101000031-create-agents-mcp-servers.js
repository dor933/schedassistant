"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("agents_mcp_servers", {
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
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      mcp_server_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "mcp_servers", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("agents_mcp_servers", ["agent_id", "mcp_server_id"], {
      name: "agents_mcp_servers_unique",
      unique: true,
    });

    await queryInterface.addIndex("agents_mcp_servers", ["agent_id"], {
      name: "agents_mcp_servers_agent_id",
    });

    await queryInterface.addIndex("agents_mcp_servers", ["mcp_server_id"], {
      name: "agents_mcp_servers_mcp_server_id",
    });

    // Seed: link the default agent to all existing MCP servers
    const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";
    await queryInterface.sequelize.query(
      `INSERT INTO agents_mcp_servers (agent_id, mcp_server_id, created_at)
       SELECT :agentId, id, NOW() FROM mcp_servers
       ON CONFLICT DO NOTHING`,
      { replacements: { agentId: DEFAULT_AGENT_ID } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("agents_mcp_servers", "agents_mcp_servers_mcp_server_id");
    await queryInterface.removeIndex("agents_mcp_servers", "agents_mcp_servers_agent_id");
    await queryInterface.removeIndex("agents_mcp_servers", "agents_mcp_servers_unique");
    await queryInterface.dropTable("agents_mcp_servers");
  },
};
