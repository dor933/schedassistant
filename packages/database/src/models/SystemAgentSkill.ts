import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import { Skill } from "./Skill";

interface SystemAgentSkillAttributes {
  id: number;
  systemAgentId: number;
  skillId: number;
  createdAt: Date;
}

type SystemAgentSkillCreationAttributes = Optional<SystemAgentSkillAttributes, "id" | "createdAt">;

class SystemAgentSkill
  extends Model<SystemAgentSkillAttributes, SystemAgentSkillCreationAttributes>
  implements SystemAgentSkillAttributes
{
  declare id: number;
  declare systemAgentId: number;
  declare skillId: number;
  declare createdAt: Date;
}

SystemAgentSkill.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    systemAgentId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "system_agent_id",
      references: { model: "system_agents", key: "id" },
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
    tableName: "system_agents_skills",
    underscored: true,
    timestamps: true,
    updatedAt: false,
  },
);

SystemAgentSkill.belongsTo(Skill, { foreignKey: "skillId", as: "skill" });

export { SystemAgentSkill };
