"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("agent_available_mcp_servers", {
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

    await queryInterface.addIndex("agent_available_mcp_servers", ["agent_id", "mcp_server_id"], {
      name: "agent_available_mcp_servers_unique",
      unique: true,
    });

    await queryInterface.addIndex("agent_available_mcp_servers", ["agent_id"], {
      name: "agent_available_mcp_servers_agent_id",
    });

    await queryInterface.addIndex("agent_available_mcp_servers", ["mcp_server_id"], {
      name: "agent_available_mcp_servers_mcp_server_id",
    });

    // Seed: link the default primary agent to all MCP servers except massive_market_data
    const DEFAULT_AGENT_ID = "00000000-0000-4000-a000-000000000001";
    await queryInterface.sequelize.query(
      `INSERT INTO agent_available_mcp_servers (agent_id, mcp_server_id, active, created_at)
       SELECT :agentId, id, true, NOW() FROM mcp_servers
       WHERE name != 'massive_market_data'
       ON CONFLICT DO NOTHING`,
      { replacements: { agentId: DEFAULT_AGENT_ID } },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("agent_available_mcp_servers", "agent_available_mcp_servers_mcp_server_id");
    await queryInterface.removeIndex("agent_available_mcp_servers", "agent_available_mcp_servers_agent_id");
    await queryInterface.removeIndex("agent_available_mcp_servers", "agent_available_mcp_servers_unique");
    await queryInterface.dropTable("agent_available_mcp_servers");
  },
};
