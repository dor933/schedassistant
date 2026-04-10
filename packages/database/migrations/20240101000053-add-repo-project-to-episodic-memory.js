"use strict";

/**
 * Adds repository_id and project_id to episodic_memory so the epic orchestrator
 * can store and retrieve knowledge chunks scoped to specific repos/projects.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("episodic_memory", "repository_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "repositories", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addColumn("episodic_memory", "project_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "projects", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addIndex("episodic_memory", ["repository_id"], {
      name: "episodic_memory_repository_id",
    });
    await queryInterface.addIndex("episodic_memory", ["project_id"], {
      name: "episodic_memory_project_id",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("episodic_memory", "episodic_memory_project_id");
    await queryInterface.removeIndex("episodic_memory", "episodic_memory_repository_id");
    await queryInterface.removeColumn("episodic_memory", "project_id");
    await queryInterface.removeColumn("episodic_memory", "repository_id");
  },
};
