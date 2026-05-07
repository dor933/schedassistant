import test from "node:test";
import assert from "node:assert/strict";
import {
  analystBriefPromptHasForbiddenInternals,
  buildAnalystBriefSynthesisPrompts,
  synthesizeAnalystBriefFromEvidencePack,
} from "../analystBriefSynthesizer";
import { renderAnalystBriefToAnswer } from "../analystBriefRenderer";
import type { EvidencePack } from "../analystTypes";

const pack: EvidencePack = {
  questionType: "compound_research",
  workflowName: "regime_to_stock_screen",
  anchor: { type: "screen", label: "Current candidate screen" },
  currentSetup: {
    state: "complete",
    keyData: ["Candidate rows: 2.", "1. GSL (Industrials): public row."],
    interpretation: "Current candidates come from public bounded screens.",
    strength: "moderate",
    warnings: [],
    sourceView: "featureScreenView",
  },
  candidateTable: [
    {
      symbol: "GSL",
      sector: "Industrials",
      rank: 1,
      hitRatePct: 58.1,
      medianReturnPct: 3.2,
      pipelineLabel: "ראיה מאומתת קיימת",
      reasonBullets: ["Public candidate row."],
      sourceView: "featureScreenView",
    },
  ],
  contradictions: [],
  missingEvidence: ["Path-risk evidence is unavailable."],
  confidence: { level: "moderate", explanation: "Public evidence is available with missing risk context." },
  monitorNext: ["Check risk for GSL."],
  freshness: { dataThrough: "2026-05-04", state: "fresh" },
  sourceViews: ["featureScreenView", "validatedEdgeEvidenceView"],
};

test("AnalystBrief synthesizer prompt contains only compact EvidencePack context", () => {
  const prompts = buildAnalystBriefSynthesisPrompts({
    message: "איזה מניות מתאימות?",
    evidencePack: pack,
  });

  assert.equal(analystBriefPromptHasForbiddenInternals(prompts), false);
  assert.equal(prompts.userPrompt.includes("ResearchPlan"), false);
  assert.equal(prompts.userPrompt.includes("compoundResearchContext"), false);
  assert.equal(prompts.userPrompt.includes("raw_sql"), false);
  assert.ok(prompts.userPrompt.includes("candidateTable"));
});

test("AnalystBrief synthesizer validates structured brief output and renderer preserves sections", async () => {
  const result = await synthesizeAnalystBriefFromEvidencePack(
    { message: "איזה מניות מתאימות?", evidencePack: pack },
    async () =>
      JSON.stringify({
        bottomLine: "לפי הנתונים, GSL הוא מועמד מחקר בולט אך חסרה שכבת סיכון.",
        sections: [
          {
            id: "what_was_checked",
            heading: "מה נבדק",
            bullets: ["נבדק מסך מניות ציבורי ושכבת Pipeline ציבורית."],
          },
          {
            id: "supports",
            heading: "מה תומך בזה",
            bullets: ["GSL הופיע בשורה הראשונה במסך המוגבל."],
          },
          {
            id: "data_limitations",
            heading: "מגבלות הנתונים",
            bullets: ["חסרה שכבת סיכון."],
          },
        ],
        tables: [
          {
            type: "candidate",
            columns: ["מניה", "סקטור", "ראיה היסטורית", "Pipeline"],
            rows: [["GSL", "Industrials", "58.1% / 3.2%", "ראיה מאומתת קיימת"]],
          },
        ],
        caveats: ["הנתונים זמינים עד 2026-05-04."],
        confidence: {
          level: "moderate",
          explanation: "יש ראיה ציבורית, אך חסרה שכבת סיכון.",
        },
        sources: [
          { label: "featureScreenView", type: "pg_current" },
          { label: "validatedEdgeEvidenceView", type: "pipeline_validation" },
        ],
        followUps: ["בדוק את הסיכון ב-GSL."],
      }),
  );

  assert.equal(result.usedFallback, false);
  const rendered = renderAnalystBriefToAnswer(result.brief);
  assert.match(rendered.answer.summary, /השורה התחתונה/);
  assert.match(rendered.answer.summary, /מה נבדק/);
  assert.match(rendered.answer.summary, /\| מניה \| סקטור \| ראיה היסטורית \| Pipeline \|/);
  assert.equal(/סט־אפ טקטי|path-risk|base-rate|edge מאומת|buy|sell|stop-loss|sizing/i.test(rendered.answer.summary), false);
});
