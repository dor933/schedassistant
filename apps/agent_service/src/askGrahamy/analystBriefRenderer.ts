import { DEFAULT_DISCLAIMER, type AnswerObject, type UiHints } from "./types";
import type { AnalystBrief, AnalystBriefTable } from "./analystTypes";

export function renderAnalystBriefToAnswer(brief: AnalystBrief): {
  answer: AnswerObject;
  ui: UiHints;
} {
  const lines: string[] = [];
  lines.push(`### ${/[\u0590-\u05ff]/.test(brief.bottomLine) ? "השורה התחתונה" : "Bottom line"}`);
  lines.push(brief.bottomLine);
  lines.push("");

  for (const section of brief.sections) {
    lines.push(`### ${section.heading}`);
    if (section.body) lines.push(section.body);
    for (const bullet of section.bullets ?? []) {
      lines.push(`- ${bullet}`);
    }
    lines.push("");
  }

  for (const table of brief.tables) {
    lines.push(...markdownTable(table));
    lines.push("");
  }

  if (brief.caveats.length) {
    lines.push("### Data / limitations");
    for (const caveat of brief.caveats) lines.push(`- ${caveat}`);
    lines.push("");
  }

  lines.push("### Confidence");
  lines.push(`${brief.confidence.level}: ${brief.confidence.explanation}`);

  return {
    answer: {
      headline: "",
      summary: lines.join("\n").trim(),
      bullets: [],
      watchpoints: [],
      disclaimer: DEFAULT_DISCLAIMER,
    },
    ui: {
      cards: [],
      tables: [],
      suggestedFollowups: brief.followUps.slice(0, 5),
    },
  };
}

function markdownTable(table: AnalystBriefTable): string[] {
  return [
    `| ${table.columns.map(safeCell).join(" | ")} |`,
    `| ${table.columns.map(() => "---").join(" | ")} |`,
    ...table.rows.map((row) => `| ${row.map(safeCell).join(" | ")} |`),
  ];
}

function safeCell(value: string): string {
  return String(value ?? "")
    .replace(/\|/g, "/")
    .replace(/\n/g, " ")
    .trim();
}
