import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import { Vendor } from "./Vendor";

/**
 * Catalog entry for an embedding model. Sits alongside `LLMModel` (chat
 * models) but is intentionally a separate table because:
 *   1. Embedding models carry a critical attribute (`dimension`) that
 *      chat models don't, and the application layer needs that as a hard
 *      fact when validating org switches against the live pgvector column.
 *   2. The selection pattern is per-org, not per-agent — orgs pick once,
 *      and switching is gated by dimension equivalence (slice 15).
 *   3. Lifecycle differs: rotating chat models per-agent is routine;
 *      rotating an embedding model invalidates every existing vector and
 *      requires a re-embed.
 *
 * Seeded by migration 129 with text-embedding-3-small/large, voyage-3-large,
 * and cohere embed-english-v3.0. Admins extend by INSERT directly — there's
 * no admin UI for editing the catalog itself (it's read-only in practice).
 */
export interface EmbeddingModelAttributes {
  id: string;
  vendorId: string;
  slug: string;
  name: string;
  /** Embedding output size. Must match the org's frozen
   *  `organizations.embedding_dimension` once one is set. */
  dimension: number;
  createdAt: Date;
  updatedAt: Date;
}

type CreationAttributes = Optional<
  EmbeddingModelAttributes,
  "id" | "createdAt" | "updatedAt"
>;

class EmbeddingModel
  extends Model<EmbeddingModelAttributes, CreationAttributes>
  implements EmbeddingModelAttributes
{
  declare id: string;
  declare vendorId: string;
  declare slug: string;
  declare name: string;
  declare dimension: number;
  declare createdAt: Date;
  declare updatedAt: Date;
}

EmbeddingModel.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    vendorId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "vendor_id",
      references: { model: "vendors", key: "id" },
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    dimension: {
      type: DataTypes.INTEGER,
      allowNull: false,
      validate: { min: 1 },
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "updated_at",
    },
  },
  {
    sequelize,
    tableName: "embedding_models",
    underscored: true,
    timestamps: true,
    indexes: [{ fields: ["vendor_id"] }],
  },
);

EmbeddingModel.belongsTo(Vendor, { foreignKey: "vendorId" });
Vendor.hasMany(EmbeddingModel, { foreignKey: "vendorId" });

export { EmbeddingModel };
