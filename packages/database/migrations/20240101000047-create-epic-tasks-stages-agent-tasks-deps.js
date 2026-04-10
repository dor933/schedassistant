"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 1. epic_tasks
    await queryInterface.createTable("epic_tasks", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "pending",
      },
      project_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "projects", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      user_id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      agent_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agents", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      metadata: {
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
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("epic_tasks", ["project_id"], {
      name: "epic_tasks_project_id",
    });
    await queryInterface.addIndex("epic_tasks", ["user_id"], {
      name: "epic_tasks_user_id",
    });
    await queryInterface.addIndex("epic_tasks", ["agent_id"], {
      name: "epic_tasks_agent_id",
    });
    await queryInterface.addIndex("epic_tasks", ["status"], {
      name: "epic_tasks_status",
    });

    // 2. epic_task_repositories (junction)
    await queryInterface.createTable("epic_task_repositories", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      epic_task_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "epic_tasks", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      repository_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "repositories", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("epic_task_repositories", ["epic_task_id", "repository_id"], {
      name: "epic_task_repositories_unique",
      unique: true,
    });

    // 3. task_stages
    await queryInterface.createTable("task_stages", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      epic_task_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "epic_tasks", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "pending",
      },
      sort_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      pr_url: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      pr_status: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      metadata: {
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
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("task_stages", ["epic_task_id"], {
      name: "task_stages_epic_task_id",
    });
    await queryInterface.addIndex("task_stages", ["status"], {
      name: "task_stages_status",
    });

    // 4. agent_tasks
    await queryInterface.createTable("agent_tasks", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      task_stage_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "task_stages", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "pending",
      },
      sort_order: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      metadata: {
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
      started_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("agent_tasks", ["task_stage_id"], {
      name: "agent_tasks_task_stage_id",
    });
    await queryInterface.addIndex("agent_tasks", ["status"], {
      name: "agent_tasks_status",
    });

    // 5. task_executions
    await queryInterface.createTable("task_executions", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      agent_task_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agent_tasks", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      attempt_number: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "running",
      },
      cli_session_id: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      result: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      error: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      feedback: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      metadata: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
      completed_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });

    await queryInterface.addIndex("task_executions", ["agent_task_id", "attempt_number"], {
      name: "task_executions_task_attempt",
      unique: true,
    });

    // 6. task_dependencies
    await queryInterface.createTable("task_dependencies", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      task_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agent_tasks", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      depends_on_task_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "agent_tasks", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.fn("NOW"),
      },
    });

    await queryInterface.addIndex("task_dependencies", ["task_id", "depends_on_task_id"], {
      name: "task_dependencies_unique",
      unique: true,
    });
    await queryInterface.addIndex("task_dependencies", ["depends_on_task_id"], {
      name: "task_dependencies_depends_on",
    });

    // CHECK constraint: no self-referencing dependencies
    await queryInterface.sequelize.query(
      `ALTER TABLE task_dependencies ADD CONSTRAINT task_deps_no_self_ref CHECK (task_id <> depends_on_task_id);`
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `ALTER TABLE task_dependencies DROP CONSTRAINT IF EXISTS task_deps_no_self_ref;`
    );
    await queryInterface.removeIndex("task_dependencies", "task_dependencies_depends_on");
    await queryInterface.removeIndex("task_dependencies", "task_dependencies_unique");
    await queryInterface.dropTable("task_dependencies");

    await queryInterface.removeIndex("task_executions", "task_executions_task_attempt");
    await queryInterface.dropTable("task_executions");

    await queryInterface.removeIndex("agent_tasks", "agent_tasks_status");
    await queryInterface.removeIndex("agent_tasks", "agent_tasks_task_stage_id");
    await queryInterface.dropTable("agent_tasks");

    await queryInterface.removeIndex("task_stages", "task_stages_status");
    await queryInterface.removeIndex("task_stages", "task_stages_epic_task_id");
    await queryInterface.dropTable("task_stages");

    await queryInterface.removeIndex("epic_task_repositories", "epic_task_repositories_unique");
    await queryInterface.dropTable("epic_task_repositories");

    await queryInterface.removeIndex("epic_tasks", "epic_tasks_status");
    await queryInterface.removeIndex("epic_tasks", "epic_tasks_agent_id");
    await queryInterface.removeIndex("epic_tasks", "epic_tasks_user_id");
    await queryInterface.removeIndex("epic_tasks", "epic_tasks_project_id");
    await queryInterface.dropTable("epic_tasks");
  },
};
