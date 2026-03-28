"use strict";

const EMBEDDING_DIMENSION = 1536;

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("episodic_memory", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        allowNull: false,
      },
      user_id: {
        type: Sequelize.STRING,
        allowNull: false,
        references: { model: "users", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      thread_id: {
        type: Sequelize.STRING,
        allowNull: false,
        references: { model: "threads", key: "id" },
        onUpdate: "CASCADE",
        onDelete: "CASCADE",
      },
      content: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      // Placeholder — replaced with a pgvector column below.
      embedding: {
        type: Sequelize.TEXT,
        allowNull: false,
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
    });

    // Convert the placeholder TEXT column into a proper pgvector column.
    await queryInterface.sequelize.query(
      `ALTER TABLE episodic_memory
       ALTER COLUMN embedding
       TYPE vector(${EMBEDDING_DIMENSION})
       USING embedding::vector(${EMBEDDING_DIMENSION});`,
    );

    await queryInterface.addIndex("episodic_memory", ["user_id"], {
      name: "episodic_memory_user_id",
    });
    await queryInterface.addIndex("episodic_memory", ["thread_id"], {
      name: "episodic_memory_thread_id",
    });

    // HNSW index for fast approximate nearest-neighbour search (cosine distance).
    await queryInterface.sequelize.query(
      `CREATE INDEX IF NOT EXISTS episodic_memory_embedding_idx
       ON episodic_memory
       USING hnsw (embedding vector_cosine_ops);`,
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.dropTable("episodic_memory");
  },
};
