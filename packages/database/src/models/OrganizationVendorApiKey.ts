import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

/**
 * Discriminator for the credential format stored on the row. Three values:
 *   - `'api_key'`     — simple secret string, in the `apiKey` column.
 *                       Anthropic classic keys (`sk-ant-api…`) and OpenAI
 *                       API keys both use this shape.
 *   - `'oauth_token'` — Claude Code OAuth token (`sk-ant-oat…`) for
 *                       Pro/Max subscription billing. String, in `apiKey`.
 *   - `'auth_object'` — Multi-field structured credential (Codex CLI's
 *                       `auth.json`: id_token + access_token + refresh_token
 *                       + account_id + …). Stored in the `authObject`
 *                       JSONB column. `apiKey` is null for these rows.
 *
 * The DB enforces "exactly one of (apiKey, authObject) is non-null" via a
 * CHECK constraint (migration 127), so a row's discriminator can be
 * inferred from which column is populated — but the explicit `key_type`
 * column makes admin queries cleaner and is the source of truth at the
 * application level.
 */
/**
 * `'embedding'` (added migration 129) is a separate billing line for the
 * embedder. Functionally it stores a string in `apiKey` just like the
 * `'api_key'` type, but the runtime resolver looks it up first when
 * resolving credentials for the embedding pipeline. If absent, the
 * resolver falls back to the same vendor's `'api_key'` row — so admins
 * who want one key for both chat and embeddings only set `'api_key'`.
 */
export type OrganizationVendorKeyType =
  | "api_key"
  | "oauth_token"
  | "auth_object"
  | "embedding";

export interface OrganizationVendorApiKeyAttributes {
  id: string;
  organizationId: string;
  vendorId: string;
  /** Simple-string credential. Null when `keyType === 'auth_object'`. */
  apiKey: string | null;
  /** Structured credential (e.g. Codex CLI `auth.json`). Null when
   *  `keyType` is `'api_key'` or `'oauth_token'`. */
  authObject: Record<string, unknown> | null;
  /**
   * Which kind of credential is stored on this row. Determines how the
   * runtime presents it to the LLM SDK (env var name, auth header,
   * file materialization, etc.).
   */
  keyType: OrganizationVendorKeyType;
  createdAt: Date;
  updatedAt: Date;
}

type CreationAttributes = Optional<
  OrganizationVendorApiKeyAttributes,
  "id" | "createdAt" | "updatedAt" | "apiKey" | "authObject"
>;

class OrganizationVendorApiKey
  extends Model<OrganizationVendorApiKeyAttributes, CreationAttributes>
  implements OrganizationVendorApiKeyAttributes
{
  declare id: string;
  declare organizationId: string;
  declare vendorId: string;
  declare apiKey: string | null;
  declare authObject: Record<string, unknown> | null;
  declare keyType: OrganizationVendorKeyType;
  declare createdAt: Date;
  declare updatedAt: Date;
}

OrganizationVendorApiKey.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "organization_id",
    },
    vendorId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "vendor_id",
    },
    apiKey: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "api_key",
    },
    authObject: {
      type: DataTypes.JSONB,
      allowNull: true,
      field: "auth_object",
    },
    keyType: {
      type: DataTypes.STRING,
      allowNull: false,
      field: "key_type",
      defaultValue: "api_key",
      validate: { isIn: [["api_key", "oauth_token", "auth_object", "embedding"]] },
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
    tableName: "organization_vendor_api_keys",
    underscored: true,
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["organization_id", "vendor_id", "key_type"],
        name: "organization_vendor_api_keys_org_vendor_type_unique",
      },
    ],
  },
);

export { OrganizationVendorApiKey };
