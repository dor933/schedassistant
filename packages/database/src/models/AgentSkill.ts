import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId } from "@scheduling-agent/types";
import { Skill } from "./Skill";

interface AgentSkillAttributes {
  id: number;
  agentId: AgentId;
  skillId: number;
  createdAt: Date;
}

type AgentSkillCreationAttributes = Optional<AgentSkillAttributes, "id" | "createdAt">;

class AgentSkill
  extends Model<AgentSkillAttributes, AgentSkillCreationAttributes>
  implements AgentSkillAttributes
{
  declare id: number;
  declare agentId: AgentId;
  declare skillId: number;
  declare createdAt: Date;
}

AgentSkill.init(
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
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "agents_skills",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

AgentSkill.belongsTo(Skill, { foreignKey: "skillId", as: "skill" });

export { AgentSkill };
