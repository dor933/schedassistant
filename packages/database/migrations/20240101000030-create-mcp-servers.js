"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("mcp_servers", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      transport: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "stdio",
      },
      command: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      args: {
        type: Sequelize.JSONB,
        allowNull: false,
        defaultValue: [],
      },
      env: {
        type: Sequelize.JSONB,
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

    // Seed the existing hardcoded MCP servers
    await queryInterface.bulkInsert("mcp_servers", [
      {
        name: "bash",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "mcp-shell"]),
        env: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        name: "fetch",
        transport: "stdio",
        command: "uvx",
        args: JSON.stringify(["mcp-server-fetch"]),
        env: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        name: "github",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "@modelcontextprotocol/server-github"]),
        env: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        name: "docker",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "@alisaitteke/docker-mcp"]),
        env: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        name: "filesystem",
        transport: "stdio",
        command: "npx",
        args: JSON.stringify(["-y", "@modelcontextprotocol/server-filesystem", "/app/data"]),
        env: null,
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        name: "massive_market_data",
        transport: "stdio",
        command: "uvx",
        args: JSON.stringify(["--from", "git+https://github.com/massive-com/mcp_massive@v0.4.0", "mcp_polygon"]),
        env: JSON.stringify({ MASSIVE_API_KEY: "{{MASSIVE_API_KEY}}" }),
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("mcp_servers");
  },
};
