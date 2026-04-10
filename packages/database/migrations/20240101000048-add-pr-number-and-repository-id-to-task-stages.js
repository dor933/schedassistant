"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("task_stages", "pr_number", {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await queryInterface.addColumn("task_stages", "repository_id", {
      type: Sequelize.UUID,
      allowNull: true,
      references: { model: "repositories", key: "id" },
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });

    await queryInterface.addIndex("task_stages", ["repository_id", "pr_number"], {
      name: "task_stages_repo_pr_number",
      unique: true,
      where: {
        pr_number: { [Sequelize.Op.ne]: null },
      },
    });
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.removeIndex("task_stages", "task_stages_repo_pr_number");
    await queryInterface.removeColumn("task_stages", "repository_id");
    await queryInterface.removeColumn("task_stages", "pr_number");
  },
};
