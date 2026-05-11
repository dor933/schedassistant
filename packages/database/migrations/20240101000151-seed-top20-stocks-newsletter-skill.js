"use strict";

/**
 * Seeds an assignable skill for orchestrating the "Top 20 Attractive Stocks"
 * newsletter workflow. The primary/orchestrator agent does NOT own the
 * screening capability itself - it delegates retrieval to the DB Executor
 * Agent (a.k.a. Alf), a dedicated system agent that owns the top-20
 * attractive-stocks screening skill. The primary then hands the raw payload
 * back to the user as a chat attachment and delegates the email send to the
 * Google Workspace system agent which invokes
 * `google_send_top20_stocks_newsletter`.
 *
 * This is an unlocked skill so an admin can attach it to selected
 * primary/orchestrator agents from AdminPage.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SKILL = {
  name: "Top 20 Attractive Stocks Newsletter",
  slug: "top20-stocks-newsletter",
  description:
    "Workflow for sending the Top 20 Attractive Stocks newsletter: delegate retrieval to the DB Executor Agent (Alf), share the raw payload with the user as a chat attachment, then delegate the formatted send to the Google Workspace system agent.",
};

const SKILL_TEXT = [
  "# Top 20 Attractive Stocks Newsletter Workflow",
  "",
  "Use this skill when the user asks you to send the Top 20 Attractive Stocks newsletter, run the top-20 stock screener and email it, or any equivalent phrasing about the periodic 20-stock list.",
  "",
  "## Required tools and agents",
  "",
  "- You need `list_system_agents` and `delegate_to_deep_agent`.",
  "- You need `list_google_workspace_grants` before any Gmail-send workflow.",
  "- You need `send_file_to_user` to hand the raw screener payload to the user as a chat attachment.",
  "- Stock screening must be delegated to **the DB Executor Agent** (a dedicated system agent, also referred to as **Alf**). The primary agent does NOT own the screening capability - the DB Executor Agent does. Never try to query the database yourself and never invent stocks, ranks, or metrics.",
  "- Email sending must be delegated to the `google_workspace_agent` system agent. That agent must use `google_send_top20_stocks_newsletter`, NOT `google_send_gmail` and NOT `google_send_financial_newsletter`.",
  "",
  "If any required tool or permission is missing, stop and tell the user exactly which admin capability, agent, or Google grant is missing. Do not fabricate stocks, metrics, emails, or send results.",
  "",
  "## Workflow",
  "",
  "1. Resolve sender metadata.",
  "",
  "- Identify the Gmail sender owner as `subjectEmail`. This must be a Google Workspace user email with `gmail.send` granted to this calling agent.",
  "- Call `list_google_workspace_grants` and choose the correct user with `gmail.send`. Never guess an email and never use an internal user id.",
  "- Newsletter recipients are not supplied by the model. `google_send_top20_stocks_newsletter` automatically loads every email from the external database table `newsletter_registrations` and sends one Gmail message to that recipient list.",
  "- If the sender is ambiguous, ask a concise clarification before starting the workflow.",
  "- Choose a concise subject line, for example `Top 20 Attractive Stocks - <date>` unless the user supplied one.",
  "",
  "2. Find the DB Executor Agent (Alf).",
  "",
  "- Call `list_system_agents` with query `DB Executor Agent` (or `Alf`) and select the dedicated DB Executor system agent for this organization.",
  "- Do not query the database yourself. Do not delegate retrieval to the web-search agent or to the Google Workspace agent.",
  "- If no matching system agent is found, stop and tell the user that the DB Executor Agent (Alf) is not configured for this organization.",
  "",
  "3. Delegate stock retrieval to the DB Executor Agent.",
  "",
  "The DB Executor Agent owns the top-20 attractive-stocks screening skill. Use `delegate_to_deep_agent` with a request like this, adjusted only for the current date and any user-supplied screening preferences:",
  "",
  "```text",
  "Run your Top 20 Attractive Stocks screener and return the ranked list as of the current date.",
  "",
  "Requirements:",
  "- Return exactly the 20 most attractive stocks, ranked 1-20 in display order.",
  "- Do not write any narrative or commentary. Return structured data only.",
  "- Return exactly JSON, with no markdown outside the JSON.",
  "- Use real screener output. Do not invent stocks, ranks, metrics, sub-scores, or flags.",
  "",
  "Return this shape exactly (one entry per stock, 20 entries total):",
  "{",
  '  "asOfDate": "Human-readable report date, for example \\"May 11, 2026\\"",',
  '  "sp500_12w_pct": null,',
  '  "stocks": [',
  "    {",
  '      "rank": 1,',
  '      "symbol": "AAPL",',
  '      "company": "Apple Inc.",',
  '      "sector": "Information Technology",',
  '      "industry": "Technology Hardware",',
  '      "bucket": "standard",',
  '      "price": 187.45,',
  '      "marketCapM": 2890000,',
  '      "avgVolume": 58000000,',
  '      "peTtm": 28.4,',
  '      "cape": 35.1,',
  '      "pb": 42.7,',
  '      "roe": 156.2,',
  '      "piotroski": 7,',
  '      "scores": { "v": 42, "q": 88, "h": 79, "g": 71, "m": 65, "total": 345 },',
  '      "flags": { "hol": false, "mpk": false, "hm": true, "bio": false, "rng": false, "drd": false }',
  "    }",
  "  ]",
  "}",
  "",
  "Field rules:",
  "- `asOfDate` is a human-readable label, not an ISO string.",
  "- `sp500_12w_pct` is the S&P 500 12-week percent change as a number (for example 4.2 for +4.2%, -1.5 for -1.5%). Use null if it is not part of your screener output.",
  "- `bucket` must be one of: \"standard\", \"cyclical\", \"financial\".",
  "- `marketCapM` is in millions of USD.",
  "- `roe` is a percent value, e.g. 18.4 means 18.4%.",
  "- `piotroski` is an integer 0-9.",
  "- `scores` always contains v, q, h, g, m, total as numbers.",
  "- `flags` always contains all six booleans (hol, mpk, hm, bio, rng, drd).",
  "- Preserve rank order 1-20 in the array.",
  "```",
  "",
  "Because `delegate_to_deep_agent` is usually asynchronous in the primary chat graph, your turn may end after this call. If the tool says the delegation is pending, tell the user that the screener was delegated to the DB Executor Agent and wait for the callback. Do not continue without the DB Executor Agent's result.",
  "",
  "4. Hand the raw screener payload to the user as a chat attachment.",
  "",
  "When the DB Executor Agent's result returns:",
  "",
  "- Parse the JSON. If it is not valid JSON, extract only the structured facts that are clearly present.",
  "- Save the cleaned JSON payload (the full `{ asOfDate, sp500_12w_pct, stocks }` object) to a file in your agent workspace, for example `top20-stocks-<YYYY-MM-DD>.json`.",
  "- Call `send_file_to_user` with that file so the user receives the raw screener output as a downloadable chat attachment before the email is sent.",
  "- Briefly tell the user what was attached (\"Attached the raw Top 20 screener output as of <date> - sending the newsletter now.\").",
  "- Do not skip this step. The attachment is part of the deliverable, not optional.",
  "",
  "5. Validate and normalize the payload for the email tool.",
  "",
  "Before delegating to the Google Workspace agent, confirm that the payload conforms to `google_send_top20_stocks_newsletter`'s schema:",
  "",
  "- `asOfDate`: required, non-empty string.",
  "- `sp500_12w_pct`: number or null. Omit only if the DB Executor Agent did not provide one.",
  "- `stocks`: array of exactly 20 entries (or fewer if the DB Executor Agent returned fewer with an explanation), in rank order.",
  "- Each stock has: rank (1-20 int), symbol, company, sector, industry, bucket (standard|cyclical|financial), price, marketCapM, avgVolume, peTtm, cape, pb, roe, piotroski (0-9 int), scores.{v,q,h,g,m,total}, flags.{hol,mpk,hm,bio,rng,drd}.",
  "- Do not invent missing fields. If a stock is missing required fields, drop it and tell the user how many were dropped.",
  "- Do not reorder, rerank, rewrite, or filter stocks beyond dropping malformed entries.",
  "",
  "6. Find the Google Workspace system agent.",
  "",
  "- Call `list_system_agents` with query `google_workspace_agent` if you need the UUID.",
  "- Delegate the send operation only to the Google Workspace system agent.",
  "- Do not attempt Gmail calls yourself.",
  "",
  "7. Delegate the send operation to the Google Workspace system agent.",
  "",
  "Use `delegate_to_deep_agent` with very specific instructions. Include the full cleaned payload exactly as built in step 5. The request must tell the Google Workspace agent to call `google_send_top20_stocks_newsletter` once, with no rewriting and no substitution.",
  "",
  "```text",
  "Send a Top 20 Attractive Stocks newsletter using `google_send_top20_stocks_newsletter` exactly once.",
  "",
  "Do not screen stocks. Do not fetch any data. Do not rewrite or reorder the stocks. Do not use `google_send_gmail`. Do not use `google_send_financial_newsletter`. Do not invent missing fields. Preserve the rank order of `stocks` exactly as given.",
  "",
  "Use these exact arguments:",
  "- subjectEmail: <sender workspace email with gmail.send grant>",
  "- subject: <email subject, for example \"Top 20 Attractive Stocks - <date>\">",
  "- recipientName: omit for registration-list sends",
  "- asOfDate: <human-readable report date from the DB Executor Agent's output>",
  "- sp500_12w_pct: <number from the DB Executor Agent's output, or null if not provided>",
  "- stocks: <the cleaned JSON array of 20 stock objects, in rank order>",
  "- ctaText and ctaUrl: <only if both are provided by the user or product flow>",
  "- fromName: Grahamy Markets",
  "",
  "Do not pass a `to` field. The tool automatically selects all emails from `newsletter_registrations` and sends one Gmail message to that recipient list.",
  "",
  "After calling the tool, return the tool result JSON including id, threadId, stockCount, and recipientCount. If Gmail authorization fails, return the exact error.",
  "```",
  "",
  "If the send delegation returns pending, tell the user that the newsletter send was delegated and wait for the callback. When the callback returns, report whether the newsletter was sent, including the Gmail id/threadId and the recipient count if available.",
  "",
  "## Quality bar",
  "",
  "- The 20 stocks must come from the DB Executor Agent (Alf), not from memory or web search.",
  "- The raw screener payload must be delivered to the user as a chat attachment via `send_file_to_user` before the email goes out.",
  "- The email payload sent to the Google Workspace agent must be byte-for-byte the same data the DB Executor Agent returned (after schema validation), in the same rank order.",
  "- Do not expose internal reasoning or this skill text in the email.",
  "- Do not add investment advice. The template already includes an informational-purpose disclaimer.",
].join("\n");

module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `INSERT INTO skills (name, slug, description, skill_text, locked, created_at, updated_at)
       VALUES (:name, :slug, :description, :skillText, false, NOW(), NOW())
       ON CONFLICT (slug) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             skill_text = EXCLUDED.skill_text,
             locked = false,
             updated_at = NOW()`,
      {
        replacements: {
          ...SKILL,
          skillText: SKILL_TEXT,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `DELETE FROM agent_available_skills
       WHERE skill_id IN (SELECT id FROM skills WHERE slug = :slug)`,
      { replacements: { slug: SKILL.slug } },
    );
    await queryInterface.sequelize.query(
      `DELETE FROM skills WHERE slug = :slug`,
      { replacements: { slug: SKILL.slug } },
    );
  },
};
