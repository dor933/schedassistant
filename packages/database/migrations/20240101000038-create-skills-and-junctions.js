"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("skills", {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      slug: {
        type: Sequelize.STRING,
        allowNull: true,
        unique: true,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      skill_text: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      locked: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
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

    // Tools table — registry of code-defined tools
    await queryInterface.createTable("tools", {
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
      slug: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      category: {
        type: Sequelize.STRING,
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

    // agent_available_skills junction
    await queryInterface.createTable("agent_available_skills", {
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
      skill_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "skills", key: "id" },
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

    await queryInterface.addIndex("agent_available_skills", ["agent_id", "skill_id"], {
      name: "agent_available_skills_unique",
      unique: true,
    });
    await queryInterface.addIndex("agent_available_skills", ["agent_id"], {
      name: "agent_available_skills_agent_id",
    });
    await queryInterface.addIndex("agent_available_skills", ["skill_id"], {
      name: "agent_available_skills_skill_id",
    });

    // agent_available_tools junction
    await queryInterface.createTable("agent_available_tools", {
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
      tool_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "tools", key: "id" },
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

    await queryInterface.addIndex("agent_available_tools", ["agent_id", "tool_id"], {
      name: "agent_available_tools_unique",
      unique: true,
    });
    await queryInterface.addIndex("agent_available_tools", ["agent_id"], {
      name: "agent_available_tools_agent_id",
    });
    await queryInterface.addIndex("agent_available_tools", ["tool_id"], {
      name: "agent_available_tools_tool_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("agent_available_tools", "agent_available_tools_tool_id");
    await queryInterface.removeIndex("agent_available_tools", "agent_available_tools_agent_id");
    await queryInterface.removeIndex("agent_available_tools", "agent_available_tools_unique");
    await queryInterface.dropTable("agent_available_tools");

    await queryInterface.removeIndex("agent_available_skills", "agent_available_skills_skill_id");
    await queryInterface.removeIndex("agent_available_skills", "agent_available_skills_agent_id");
    await queryInterface.removeIndex("agent_available_skills", "agent_available_skills_unique");
    await queryInterface.dropTable("agent_available_skills");

    await queryInterface.dropTable("tools");
    await queryInterface.dropTable("skills");
  },
};
