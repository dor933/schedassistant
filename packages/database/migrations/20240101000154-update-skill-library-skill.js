"use strict";

/**
 * Replaces the terse in-house skill-library helper skill with practical
 * guidance for discovering, reading, creating, and editing reusable skills.
 *
 * @type {import('sequelize-cli').Migration}
 */

const SLUG = "dev-in-house-skill-library";

const UPDATED = {
  name: "Skill library",
  description:
    "How to discover, load, create, and edit reusable agent skills with list/get/add/edit skill tools.",
  skillText: [
    "# Skill Library",
    "",
    "Use this skill when you need stored instructions, procedures, reusable workflows, or long-running playbooks that belong to the current agent.",
    "",
    "Skills are persistent database records. They are not scratch files, temporary notes, or one-off chat memory. Use the workspace for drafts and temporary files; use agent notes for short durable facts; use skills for reusable procedural knowledge.",
    "",
    "## Available Tools",
    "",
    "- `list_agent_skills` - list skill ids, names, slugs, and descriptions. It does not return the full skill body.",
    "- `get_agent_skill` - load the full `skill_text` for a skill id returned by `list_agent_skills`.",
    "- `add_agent_skill` - create a new reusable skill and link it to this agent.",
    "- `edit_agent_skill` - update metadata and/or the full body of a skill linked to this agent.",
    "",
    "System/deep agents may only have the read-only skill tools. Primary agents normally have create/edit tools as well.",
    "",
    "## Discovery Workflow",
    "",
    "When the user asks for a task that may already have a stored workflow:",
    "",
    "1. Call `list_agent_skills`.",
    "2. Choose the relevant skill by name, slug, and description.",
    "3. Call `get_agent_skill` for the chosen id before executing the workflow.",
    "4. Follow the loaded `skill_text` unless the user explicitly overrides it.",
    "",
    "Do not guess a skill's full instructions from the list output. The list output is only an index.",
    "",
    "## Creating A Skill",
    "",
    "Use `add_agent_skill` only when the user asks to create a new skill, preserve a reusable workflow, or turn repeated instructions into a maintained playbook.",
    "",
    "A good new skill should include:",
    "",
    "- A clear title.",
    "- When to use it.",
    "- Required tools, agents, permissions, and prerequisites.",
    "- Step-by-step workflow.",
    "- Exact payload shapes or command formats when relevant.",
    "- Failure handling and stopping conditions.",
    "- Quality bar / invariants.",
    "- What not to do.",
    "",
    "Do not create a skill for a single answer, a temporary file path, a short preference, or data that belongs in agent notes.",
    "",
    "## Editing A Skill",
    "",
    "Use `edit_agent_skill` when the user asks to improve, correct, replace, or extend an existing skill.",
    "",
    "Safe edit workflow:",
    "",
    "1. Call `list_agent_skills` to find the skill id.",
    "2. Call `get_agent_skill` to read the full current body.",
    "3. Prepare the full replacement `skill_text`; do not patch from memory.",
    "4. Preserve useful existing instructions unless the user asks to replace them.",
    "5. Call `edit_agent_skill` with the skill id and the full updated `skill_text`.",
    "6. If changing metadata, update `name`, `slug`, or `description` in the same call when appropriate.",
    "",
    "Important: skills are shared rows. If the same skill is linked to other agents, those agents will see the updated text too. Mention this if the edit has broad behavioral impact.",
    "",
    "## Skill Body Standards",
    "",
    "Write skills as operational instructions, not vague summaries.",
    "",
    "Prefer:",
    "",
    "- Concrete tool names.",
    "- Ordered steps.",
    "- Required input and output schemas.",
    "- Explicit validation rules.",
    "- Clear delegation boundaries between primary agents and system agents.",
    "- Exact field names when a downstream tool schema requires them.",
    "- Concise examples that can be copied into tool arguments.",
    "",
    "Avoid:",
    "",
    "- Marketing language.",
    "- Long background explanations that do not affect execution.",
    "- Hidden assumptions about permissions or available agents.",
    "- Instructions to invent missing data.",
    "- References to files or tools that the agent may not have.",
    "",
    "## Choosing Between Skills, Notes, And Workspace",
    "",
    "- Use skills for reusable workflows and procedures.",
    "- Use agent notes for durable facts and preferences that should be remembered in future turns.",
    "- Use the workspace for drafts, payload files, logs, generated reports, and temporary artifacts.",
    "- Use the shared library for admin-managed reference documents.",
    "",
    "## Related",
    "",
    "- Markdown workspace scratch and payload files: `dev-in-house-workspace`.",
    "- Agent memory and durable preferences: `dev-in-house-agent-notes`.",
  ].join("\n"),
};

const PREVIOUS = {
  name: "Skill library (list / get / add)",
  description: "list_agent_skills, get_agent_skill, add_agent_skill.",
  skillText: [
    "# Skill library",
    "",
    "- **`list_agent_skills`** - ids and metadata (not full body).",
    "- **`get_agent_skill`** - full `skill_text` by id.",
    "- **`add_agent_skill`** - create and link a new skill.",
    "",
    "## Related",
    "- Markdown workspace scratch -> `dev-in-house-workspace`.",
  ].join("\n"),
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `UPDATE skills
       SET name = :name,
           description = :description,
           skill_text = :skillText,
           updated_at = NOW()
       WHERE slug = :slug`,
      {
        replacements: {
          slug: SLUG,
          ...UPDATED,
        },
      },
    );
  },

  async down(queryInterface, _Sequelize) {
    await queryInterface.sequelize.query(
      `UPDATE skills
       SET name = :name,
           description = :description,
           skill_text = :skillText,
           updated_at = NOW()
       WHERE slug = :slug`,
      {
        replacements: {
          slug: SLUG,
          ...PREVIOUS,
        },
      },
    );
  },
};
