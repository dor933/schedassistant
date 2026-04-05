import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { PersonAttributes } from "@scheduling-agent/types";

type PersonCreationAttributes = Optional<
  PersonAttributes,
  "id" | "createdAt" | "updatedAt" | "firstName" | "lastName" | "email"
>;

/**
 * Parent table for every human-like entity in the system. Both `users` and
 * `employees` inherit their primary key from `persons` — a person can be a
 * user, an employee, both, or neither.
 */
class Person
  extends Model<PersonAttributes, PersonCreationAttributes>
  implements PersonAttributes
{
  declare id: number;
  declare firstName: string | null;
  declare lastName: string | null;
  declare email: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Person.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "first_name",
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: true,
      field: "last_name",
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
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
    tableName: "persons",
    underscored: true,
    timestamps: true,
  },
);

export { Person };
