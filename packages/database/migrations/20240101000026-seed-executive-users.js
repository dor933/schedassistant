"use strict";

/**
 * Seed executive users (Dor, Dan, Maor). `users.id` is SERIAL — not set here.
 * Idempotent via ON CONFLICT (user_name).
 * Roles: Dor = super_admin; Dan & Maor = admin.
 *
 * Password (dev): same bcrypt as system admin in migration 11 — "Sys@dm1n!2026#Gr4hamy".
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface, _Sequelize) {
    const bcryptHash =
      "$2b$10$ntns1t390KhW5VJCrBKlV.5csFRPG3/RmYVKW8BSJJ1EhoWZ8YMm.";
    /** @see 20240101000024-add-super-admin-role.js */
    const superAdminRoleId = "00000000-0000-4000-c000-000000000003";
    /** @see 20240101000021-create-roles-add-role-id-to-users.js */
    const adminRoleId = "00000000-0000-4000-c000-000000000001";

    const executives = [
      {
        user_name: "dor",
        role_id: superAdminRoleId,
        display_name: "Dor",
        user_identity: {
          general: {
            preferredName: "Dor",
            formalTitle: "VP R&D & CTO",
            location: "Israel (Asia/Jerusalem)",
            summary:
              "Leads technical vision, research discipline, and engineering execution for Grahamy.",
            communicationStyle:
              "Direct, evidence-first, balances innovation with delivery risk.",
          },
          scope: {
            function: "Research & Development",
            mandate:
              "Platform architecture, algorithm quality, engineering organization, and long-term technical roadmap.",
            focusAreas: [
              "R&D strategy",
              "data & ML systems",
              "engineering hiring",
              "technical debt vs velocity",
            ],
            keyPartnersInternal: ["Product", "Data Science", "Security"],
            reportsExpectations: [
              "technical roadmaps",
              "experiment design",
              "release quality",
            ],
          },
        },
      },
      {
        user_name: "dan",
        role_id: adminRoleId,
        display_name: "Dan",
        user_identity: {
          general: {
            preferredName: "Dan",
            formalTitle: "Chief Executive Officer",
            location: "Israel (Asia/Jerusalem)",
            summary:
              "Sets overall direction for Grahamy and aligns leadership on product, market, and capital.",
            communicationStyle:
              "Strategic, concise, ties decisions to customer and business outcomes.",
          },
          scope: {
            function: "Executive / Company leadership",
            mandate:
              "Company strategy, market positioning, capital and resource allocation, and cross-functional alignment.",
            focusAreas: [
              "corporate strategy",
              "investor & board narrative",
              "culture and leadership",
              "major partnerships",
            ],
            keyPartnersInternal: ["Finance", "Legal", "GTM", "R&D"],
            reportsExpectations: ["P&L narrative", "strategic bets", "org health"],
          },
        },
      },
      {
        user_name: "maor",
        role_id: adminRoleId,
        display_name: "Maor",
        user_identity: {
          general: {
            preferredName: "Maor",
            formalTitle: "VP Sales",
            location: "Israel (Asia/Jerusalem)",
            summary:
              "Owns revenue growth and customer acquisition for Grahamy's platform across core markets.",
            communicationStyle:
              "Relationship-oriented, quota-aware, aligns deals with product reality.",
          },
          scope: {
            function: "Sales",
            mandate:
              "Pipeline health, enterprise and mid-market wins, and GTM alignment with product and marketing.",
            focusAreas: [
              "enterprise pipeline",
              "US & Canada expansion",
              "pricing & packaging",
              "sales enablement",
            ],
            territories: ["United States", "Canada"],
            keyPartnersInternal: ["Marketing", "Customer Success", "Product"],
            reportsExpectations: [
              "forecast accuracy",
              "win/loss themes",
              "customer feedback loop",
            ],
          },
        },
      },
    ];

    for (const row of executives) {
      await queryInterface.sequelize.query(
        `INSERT INTO users (user_name, display_name, user_identity, password, role_id, created_at, updated_at)
         VALUES (:user_name, :display_name, CAST(:user_identity AS jsonb), :password, CAST(:role_id AS uuid), NOW(), NOW())
         ON CONFLICT (user_name) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           user_identity = EXCLUDED.user_identity,
           password = EXCLUDED.password,
           role_id = EXCLUDED.role_id,
           updated_at = NOW()`,
        {
          replacements: {
            user_name: row.user_name,
            display_name: row.display_name,
            user_identity: JSON.stringify(row.user_identity),
            password: bcryptHash,
            role_id: row.role_id,
          },
        },
      );
    }
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM users WHERE user_name IN ('dor', 'dan', 'maor')`,
    );
  },
};
