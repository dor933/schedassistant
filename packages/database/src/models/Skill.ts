import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";

export interface SkillAttributes {
  id: number;
  name: string;
  slug: string | null;
  description: string | null;
  skillText: string;
  systemAgentAssignable: boolean;
  createdAt: Date;
  updatedAt: Date;
}

type SkillCreationAttributes = Optional<
  SkillAttributes,
  "id" | "slug" | "description" | "systemAgentAssignable" | "createdAt" | "updatedAt"
>;

class Skill extends Model<SkillAttributes, SkillCreationAttributes> implements SkillAttributes {
  declare id: number;
  declare name: string;
  declare slug: string | null;
  declare description: string | null;
  declare skillText: string;
  declare systemAgentAssignable: boolean;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Skill.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    slug: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    skillText: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: "skill_text",
    },
    systemAgentAssignable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: "system_agent_assignable",
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
    tableName: "skills",
    underscored: true,
    timestamps: true,
  },
);

export { Skill };
