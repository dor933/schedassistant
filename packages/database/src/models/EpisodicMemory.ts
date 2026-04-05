import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { EpisodicMemoryAttributes, EpisodicChunkMetadata } from "@scheduling-agent/types";

/**
 * Embedding dimension — must match the model used in the embedding pipeline.
 * OpenAI text-embedding-3-small = 1536; adjust if using a different model.
 */
export const EMBEDDING_DIMENSION = 1536;

type EpisodicMemoryCreationAttributes = Optional<
  EpisodicMemoryAttributes,
  "id" | "createdAt" | "metadata" | "userId"
>;

class EpisodicMemory
  extends Model<EpisodicMemoryAttributes, EpisodicMemoryCreationAttributes>
  implements EpisodicMemoryAttributes
{
  declare id: string;
  declare agentId: string;
  declare userId: number | null;
  declare content: string;
  declare embedding: number[];
  declare metadata: EpisodicChunkMetadata | null;
  declare createdAt: Date;
}

EpisodicMemory.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: true,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    content: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    embedding: {
      // pgvector `vector(1536)` column. Sequelize has no built-in vector type,
      // so we store/retrieve as a string in pgvector literal format "[0.1,0.2,…]".
      // The custom set/get below transparently converts between number[] and that format.
      type: "VECTOR(1536)" as any,
      allowNull: false,
      set(this: EpisodicMemory, val: number[]) {
        this.setDataValue("embedding" as any, `[${val.join(",")}]` as any);
      },
      get(this: EpisodicMemory) {
        const raw = this.getDataValue("embedding" as any);
        if (!raw) return raw;
        if (Array.isArray(raw)) return raw as number[];
        const str = String(raw);
        if (str.startsWith("[")) {
          return JSON.parse(str) as number[];
        }
        return raw;
      },
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "episodic_memory",
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["agent_id"] },
      { fields: ["user_id"] },
    ],
  },
);

export { EpisodicMemory };
