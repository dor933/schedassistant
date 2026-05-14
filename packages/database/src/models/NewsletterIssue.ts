import { DataTypes, Model, Optional } from "sequelize";
import { sequelize } from "../connection";
import type { AgentId, OrganizationId } from "@scheduling-agent/types";

export type NewsletterIssueType = "top20_stocks" | "financial_news";
export type NewsletterIssueStatus = "generated" | "sent" | "failed";

export interface NewsletterIssueAttributes {
  id: string;
  organizationId: OrganizationId;
  type: NewsletterIssueType;
  status: NewsletterIssueStatus;
  subject: string | null;
  issueDate: string;
  asOfDate: string | null;
  fileUri: string;
  payloadUri: string | null;
  htmlUri: string | null;
  summary: string | null;
  sentMessageId: string | null;
  sentThreadId: string | null;
  createdByAgentId: AgentId | null;
  sentAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

type NewsletterIssueCreationAttributes = Optional<
  NewsletterIssueAttributes,
  | "id"
  | "status"
  | "subject"
  | "issueDate"
  | "asOfDate"
  | "payloadUri"
  | "htmlUri"
  | "summary"
  | "sentMessageId"
  | "sentThreadId"
  | "createdByAgentId"
  | "sentAt"
  | "metadata"
  | "createdAt"
  | "updatedAt"
>;

class NewsletterIssue
  extends Model<NewsletterIssueAttributes, NewsletterIssueCreationAttributes>
  implements NewsletterIssueAttributes
{
  declare id: string;
  declare organizationId: OrganizationId;
  declare type: NewsletterIssueType;
  declare status: NewsletterIssueStatus;
  declare subject: string | null;
  declare issueDate: string;
  declare asOfDate: string | null;
  declare fileUri: string;
  declare payloadUri: string | null;
  declare htmlUri: string | null;
  declare summary: string | null;
  declare sentMessageId: string | null;
  declare sentThreadId: string | null;
  declare createdByAgentId: AgentId | null;
  declare sentAt: Date | null;
  declare metadata: Record<string, unknown> | null;
  declare createdAt: Date;
  declare updatedAt: Date;
}

NewsletterIssue.init(
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
      references: { model: "organizations", key: "id" },
    },
    type: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "generated",
    },
    subject: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    issueDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "issue_date",
    },
    asOfDate: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "as_of_date",
    },
    fileUri: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: "file_uri",
    },
    payloadUri: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "payload_uri",
    },
    htmlUri: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "html_uri",
    },
    summary: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    sentMessageId: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "sent_message_id",
    },
    sentThreadId: {
      type: DataTypes.TEXT,
      allowNull: true,
      field: "sent_thread_id",
    },
    createdByAgentId: {
      type: DataTypes.UUID,
      allowNull: true,
      field: "created_by_agent_id",
      references: { model: "agents", key: "id" },
    },
    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: "sent_at",
    },
    metadata: {
      type: DataTypes.JSONB,
      allowNull: true,
      defaultValue: {},
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "created_at",
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: "updated_at",
    },
  },
  {
    sequelize,
    tableName: "newsletter_issues",
    underscored: true,
    timestamps: true,
  },
);

export { NewsletterIssue };
