import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { EmployeeAttributes } from "@scheduling-agent/types";

type EmployeeCreationAttributes = Optional<
  EmployeeAttributes,
  "createdAt" | "updatedAt" | "jiraIdNumber"
>;

/**
 * Employment-specific fields for a person. `employees.id` is *the same* as
 * `persons.id` (and equal to `users.id` when the person is also a user).
 *
 * Extend this table with additional columns as new tool integrations land
 * (Slack id, GitHub handle, reporting line, etc.).
 */
class Employee
  extends Model<EmployeeAttributes, EmployeeCreationAttributes>
  implements EmployeeAttributes
{
  declare id: number;
  declare jiraIdNumber: string | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

Employee.init(
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      allowNull: false,
      references: { model: "persons", key: "id" },
    },
    jiraIdNumber: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      field: "jira_id_number",
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
    tableName: "employees",
    underscored: true,
    timestamps: true,
  },
);

export { Employee };
