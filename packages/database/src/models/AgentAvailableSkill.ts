import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";
import { Skill } from "./Skill";

interface AgentAvailableSkillAttributes {
  id: number;
  agentId: AgentId;
  skillId: number;
  active: boolean;
  createdAt: Date;
}

type CreationAttributes = Optional<AgentAvailableSkillAttributes, "id" | "active" | "createdAt">;

class AgentAvailableSkill
  extends Model<AgentAvailableSkillAttributes, CreationAttributes>
  implements AgentAvailableSkillAttributes
{
  declare id: number;
  declare agentId: AgentId;
  declare skillId: number;
  declare active: boolean;
  declare createdAt: Date;
}

AgentAvailableSkill.init(
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
    skillId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "skill_id",
      references: { model: "skills", key: "id" },
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
    tableName: "agent_available_skills",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

AgentAvailableSkill.belongsTo(Skill, { foreignKey: "skillId", as: "skill" });

export { AgentAvailableSkill };
