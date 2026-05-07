import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentSdkCapabilityAttributes, AgentId } from "@scheduling-agent/types";

type CreationAttributes = Optional<
  AgentSdkCapabilityAttributes,
  "id" | "active" | "createdAt"
>;

class AgentSdkCapability
  extends Model<AgentSdkCapabilityAttributes, CreationAttributes>
  implements AgentSdkCapabilityAttributes
{
  declare id: number;
  declare agentId: AgentId;
  declare sdkCapabilityId: number;
  declare active: boolean;
  declare createdAt: Date;
}

AgentSdkCapability.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    agentId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "agent_id",
      references: { model: "agents", key: "id" },
    },
    sdkCapabilityId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "sdk_capability_id",
      references: { model: "sdk_capabilities", key: "id" },
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "agent_sdk_capabilities",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

export { AgentSdkCapability };
