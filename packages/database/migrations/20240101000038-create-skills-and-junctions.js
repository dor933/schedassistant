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
      system_agent_assignable: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: true,
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

    await queryInterface.createTable("agents_skills", {
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
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("agents_skills", ["agent_id", "skill_id"], {
      name: "agents_skills_agent_id_skill_id_unique",
      unique: true,
    });
    await queryInterface.addIndex("agents_skills", ["agent_id"], {
      name: "agents_skills_agent_id",
    });
    await queryInterface.addIndex("agents_skills", ["skill_id"], {
      name: "agents_skills_skill_id",
    });

    await queryInterface.createTable("system_agents_skills", {
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
      skill_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "skills", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("system_agents_skills", ["system_agent_id", "skill_id"], {
      name: "system_agents_skills_system_agent_id_skill_id_unique",
      unique: true,
    });
    await queryInterface.addIndex("system_agents_skills", ["system_agent_id"], {
      name: "system_agents_skills_system_agent_id",
    });
    await queryInterface.addIndex("system_agents_skills", ["skill_id"], {
      name: "system_agents_skills_skill_id",
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("system_agents_skills", "system_agents_skills_skill_id");
    await queryInterface.removeIndex("system_agents_skills", "system_agents_skills_system_agent_id");
    await queryInterface.removeIndex(
      "system_agents_skills",
      "system_agents_skills_system_agent_id_skill_id_unique",
    );
    await queryInterface.dropTable("system_agents_skills");

    await queryInterface.removeIndex("agents_skills", "agents_skills_skill_id");
    await queryInterface.removeIndex("agents_skills", "agents_skills_agent_id");
    await queryInterface.removeIndex("agents_skills", "agents_skills_agent_id_skill_id_unique");
    await queryInterface.dropTable("agents_skills");

    await queryInterface.dropTable("skills");
  },
};
