"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("system_agents_mcp_servers", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      system_agent_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "system_agents", key: "id" },
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

    await queryInterface.addIndex("system_agents_mcp_servers", ["system_agent_id", "mcp_server_id"], {
      name: "system_agents_mcp_servers_unique",
      unique: true,
    });

    await queryInterface.addIndex("system_agents_mcp_servers", ["system_agent_id"], {
      name: "system_agents_mcp_servers_system_agent_id",
    });

    await queryInterface.addIndex("system_agents_mcp_servers", ["mcp_server_id"], {
      name: "system_agents_mcp_servers_mcp_server_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("system_agents_mcp_servers", "system_agents_mcp_servers_mcp_server_id");
    await queryInterface.removeIndex("system_agents_mcp_servers", "system_agents_mcp_servers_system_agent_id");
    await queryInterface.removeIndex("system_agents_mcp_servers", "system_agents_mcp_servers_unique");
    await queryInterface.dropTable("system_agents_mcp_servers");
  },
};
