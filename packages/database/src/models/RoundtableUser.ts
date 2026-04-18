import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { UserId } from "@scheduling-agent/types";
import { User } from "./User";

export interface RoundtableUserAttributes {
  id: string;
  roundtableId: string;
  userId: UserId;
  turnOrder: number;
  turnsCompleted: number;
  createdAt: Date;
}

type CreationAttrs = Optional<
  RoundtableUserAttributes,
  "id" | "turnsCompleted" | "createdAt"
>;

class RoundtableUser
  extends Model<RoundtableUserAttributes, CreationAttrs>
  implements RoundtableUserAttributes
{
  declare id: string;
  declare roundtableId: string;
  declare userId: UserId;
  declare turnOrder: number;
  declare turnsCompleted: number;
  declare createdAt: Date;
}

RoundtableUser.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    roundtableId: {
      type: DataTypes.UUID,
      allowNull: false,
      field: "roundtable_id",
      references: { model: "roundtables", key: "id" },
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "user_id",
      references: { model: "users", key: "id" },
    },
    turnOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: "turn_order",
    },
    turnsCompleted: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: "turns_completed",
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      field: "created_at",
    },
  },
  {
    sequelize,
    tableName: "roundtable_users",
    underscored: true,
    timestamps: true,
    updatedAt: false,
    indexes: [{ fields: ["roundtable_id", "user_id"], unique: true }],
  },
);

RoundtableUser.belongsTo(User, { foreignKey: "userId", as: "user" });

export { RoundtableUser };
