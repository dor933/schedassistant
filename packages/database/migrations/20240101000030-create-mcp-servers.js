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

    // Seed MCP servers (without docker — removed in old migration 0069).
    //
    // The legacy `bash` MCP server (`mcp-shell`) is no longer seeded here:
    // shell access is provided by the Claude Agent SDK's native `Bash` tool,
    // gated per-agent by `agents.allow_sdk_bash` (added in migration 121).
    // Existing environments that already have a `bash` row from an earlier
    // run of this migration keep it — admins manage cleanup via the admin
    // UI as agents are migrated off the legacy MCP.
    await queryInterface.bulkInsert("mcp_servers", [
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
        args: JSON.stringify(["--from", "git+https://github.com/massive-com/mcp_massive@v0.8.3", "mcp_massive"]),
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
