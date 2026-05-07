import type {
  Classification,
  DecayRiskBucket,
  LiveConfirmationBucket,
  PublicFreshnessView,
  ValidatedEdgeEvidenceAnchorView,
  ValidatedEdgeEvidenceState,
  ValidatedEdgeEvidenceView,
} from "../types";
import { PipelineOverlayClient } from "./client";
import { mapManifestToPublicFreshness } from "./manifestFreshness";
import { createPublicOverlayResult } from "./publicMapper";
import type {
  PipelineClientResult,
  PipelineRegime,
} from "./types";

export type PipelineOverlayRunInput = {
  classification: Classification;
  message: string;
};

export type PipelineOverlayRunResult = {
  views: {
    validatedEdgeEvidenceView?: ValidatedEdgeEvidenceView;
  };
  warnings: string[];
};

type ValidatedEvidenceAnchorRequest =
  | {
      anchor: ValidatedEdgeEvidenceAnchorView;
      fetch: (client: PipelineOverlayClient) => Promise<PipelineClientResult>;
    }
  | {
      unavailableAnchor: ValidatedEdgeEvidenceAnchorView;
      warning: string;
    };

const VIEW_SCHEMA_VERSION = 1;
const SOURCE = "client_api_research_object" as const;

export async function executeValidatedEdgeEvidenceOverlay(
  input: PipelineOverlayRunInput,
  client = new PipelineOverlayClient(),
): Promise<PipelineOverlayRunResult> {
  if (input.classification.focus !== "validated_evidence") {
    return { views: {}, warnings: [] };
  }

  const request = resolveAnchorRequest(input.classification);
  const manifestResult = await client.fetchManifest();
  const freshness = freshnessFromManifestResult(manifestResult);

  if ("unavailableAnchor" in request) {
    const view = unavailableView(request.unavailableAnchor, request.warning, freshness);
    return { views: { validatedEdgeEvidenceView: view }, warnings: [request.warning] };
  }

  const rawResult = await request.fetch(client);
  if (!rawResult.ok) {
    const warning =
      rawResult.status === "not_modified"
        ? "Pipeline evidence is unavailable because no cached public overlay exists for the unchanged upstream response."
        : rawResult.warning;
    const view = unavailableView(request.anchor, warning, freshness);
    return { views: { validatedEdgeEvidenceView: view }, warnings: [warning] };
  }

  const mapped = mapValidatedEdgeEvidenceView({
    anchor: request.anchor,
    rawEnvelope: rawResult.rawEnvelope,
    freshness,
  });
  return {
    views: { validatedEdgeEvidenceView: mapped.view },
    warnings: mapped.warnings,
  };
}

export function mapValidatedEdgeEvidenceView(input: {
  anchor: ValidatedEdgeEvidenceAnchorView;
  rawEnvelope: unknown;
  freshness: PublicFreshnessView;
}): { view: ValidatedEdgeEvidenceView; warnings: string[] } {
  const data = extractDataObject(input.rawEnvelope);
  if (!data) {
    const warning = "Pipeline evidence is unavailable for the requested input.";
    return {
      view: unavailableView(input.anchor, warning, input.freshness),
      warnings: [warning],
    };
  }

  const pipelineEvidence = recordAt(data, "pipeline_evidence") ??
    recordAt(data, "pipelineEvidence") ??
    recordAt(data, "evidence") ??
    {};
  const baseRate = recordAt(data, "base_rate") ?? recordAt(data, "baseRate");
  const pathRisk = recordAt(data, "path_risk") ?? recordAt(data, "pathRisk");
  const activeEdges = recordAt(pipelineEvidence, "active_edges") ??
    recordAt(pipelineEvidence, "activeEdges");
  const aggregateEvidence = activeEdges ?? pipelineEvidence;

  const explicitEvidenceState = normalizeEvidenceState(
    stringAt(data, "evidence_state") ??
      stringAt(data, "evidenceState") ??
      stringAt(pipelineEvidence, "evidence_state") ??
      stringAt(pipelineEvidence, "evidenceState"),
  );
  const totalEdges = numberAt(pipelineEvidence, "total_edges") ??
    numberAt(pipelineEvidence, "totalEdges") ??
    numberAt(activeEdges, "total") ??
    numberAt(activeEdges, "count") ??
    numberAt(pipelineEvidence, "accepted_edges") ??
    numberAt(data, "edge_count");
  const eventsTotal = numberAt(pipelineEvidence, "events_total") ??
    numberAt(pipelineEvidence, "eventsTotal") ??
    numberAt(pipelineEvidence, "event_count");
  const horizonEvidence = buildHorizonEvidence(aggregateEvidence);
  const baseRateSummary = buildBaseRateSummary(baseRate);
  const pipelineRiskBand = publicString(
    stringAt(pathRisk, "band") ??
      stringAt(pathRisk, "risk_band") ??
      stringAt(pipelineEvidence, "risk_band") ??
      stringAt(data, "pipeline_risk_band"),
  );
  const liveConfirmationBucket = buildLiveConfirmationBucket(pipelineEvidence);
  const decayRiskBucket = buildDecayRiskBucket(pipelineEvidence);

  const hasPublicEvidence =
    explicitEvidenceState ||
    totalEdges !== undefined ||
    eventsTotal !== undefined ||
    horizonEvidence.length > 0 ||
    baseRateSummary !== undefined ||
    pipelineRiskBand !== undefined ||
    liveConfirmationBucket !== undefined ||
    decayRiskBucket !== undefined;

  if (!hasPublicEvidence) {
    const warning = "Pipeline evidence is unavailable for the requested input.";
    return {
      view: unavailableView(input.anchor, warning, input.freshness),
      warnings: [warning],
    };
  }

  const evidenceState =
    explicitEvidenceState ?? evidenceStateFromCounts(totalEdges, horizonEvidence.length);
  const state = explicitEvidenceState ? "complete" : "partial";
  const warnings = [
    ...freshnessWarnings(input.freshness),
    ...validatedEvidenceWarnings(evidenceState, explicitEvidenceState, baseRateSummary),
    ...pipelineQualificationWarnings(liveConfirmationBucket, decayRiskBucket),
  ];
  const view: ValidatedEdgeEvidenceView = {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state,
    source: SOURCE,
    anchor: input.anchor,
    evidenceState,
    ...(totalEdges !== undefined ? { edgeCountBucket: edgeCountBucket(totalEdges) } : {}),
    ...(eventsTotal !== undefined ? { eventSampleBucket: eventSampleBucket(eventsTotal) } : {}),
    ...(horizonEvidence.length ? { horizonEvidence } : {}),
    ...(baseRateSummary ? { baseRateSummary } : {}),
    ...(pipelineRiskBand ? { pipelineRiskBand } : {}),
    ...(liveConfirmationBucket ? { liveConfirmationBucket } : {}),
    ...(decayRiskBucket ? { decayRiskBucket } : {}),
    interpretationBullets: interpretationBullets({
      anchor: input.anchor,
      evidenceState,
      edgeCountBucket: totalEdges !== undefined ? edgeCountBucket(totalEdges) : undefined,
      eventSampleBucket: eventsTotal !== undefined ? eventSampleBucket(eventsTotal) : undefined,
      hasBaseRate: !!baseRateSummary,
      pipelineRiskBand,
      liveConfirmationBucket,
      decayRiskBucket,
    }),
    freshness: input.freshness,
    warnings,
  };

  const mapped = createPublicOverlayResult(view);
  return {
    view: mapped.view ?? view,
    warnings: mapped.warnings,
  };
}

function resolveAnchorRequest(
  classification: Classification,
): ValidatedEvidenceAnchorRequest {
  if (classification.intent === "comparison" && classification.comparison) {
    const comparison = classification.comparison;
    if (comparison.comparisonType === "symbol_vs_symbol") {
      const left = comparison.left.symbol.toUpperCase();
      const right = comparison.right.symbol.toUpperCase();
      return {
        anchor: {
          type: "comparison",
          label: `${left} vs ${right}`,
        },
        fetch: (client) => client.fetchSymbolComparison(left, right),
      };
    }
    if (comparison.comparisonType === "sector_vs_sector") {
      const left = comparison.left.sector;
      const right = comparison.right.sector;
      if (!left || !right) {
        return {
          unavailableAnchor: {
            type: "comparison",
            label: "sector comparison",
          },
          warning:
            "Pipeline validated evidence comparison is unavailable because a sector anchor is missing.",
        };
      }
      return {
        anchor: {
          type: "comparison",
          label: `${left} vs ${right}`,
        },
        fetch: (client) => client.fetchSectorComparison(left, right),
      };
    }
    return {
      unavailableAnchor: {
        type: "comparison",
        label: "stock versus sector",
      },
      warning:
        "Pipeline validated evidence comparison is unavailable for this comparison shape.",
    };
  }

  const symbol = classification.symbols[0]?.trim().toUpperCase();
  if (symbol) {
    return {
      anchor: { type: "stock", symbol, label: symbol },
      fetch: (client) => client.fetchTickerResearch(symbol),
    };
  }

  const sector = classification.sectors[0]?.trim();
  if (sector) {
    return {
      anchor: { type: "sector", sector, label: sector },
      fetch: (client) => client.fetchSectorResearch(sector),
    };
  }

  if (classification.regimeRequested) {
    const regime: PipelineRegime = "current";
    return {
      anchor: { type: "regime", regime, label: "current regime" },
      fetch: (client) => client.fetchRegimeResearch(regime),
    };
  }

  return {
    unavailableAnchor: {
      type: "stock",
      label: "missing stock, sector, or regime anchor",
    },
    warning:
      "Ask for a specific stock, sector, or regime to check pipeline validated evidence.",
  };
}

function freshnessFromManifestResult(result: PipelineClientResult): PublicFreshnessView {
  if (result.ok) return mapManifestToPublicFreshness(result.rawEnvelope);
  if (result.status === "not_modified") {
    return {
      state: "unknown",
      warning: "Pipeline freshness metadata is unchanged but no cached public freshness is available.",
    };
  }
  return {
    state: "unknown",
    warning: result.warning,
  };
}

function unavailableView(
  anchor: ValidatedEdgeEvidenceAnchorView,
  warning: string,
  freshness: PublicFreshnessView,
): ValidatedEdgeEvidenceView {
  return {
    viewSchemaVersion: VIEW_SCHEMA_VERSION,
    state: "unavailable",
    source: SOURCE,
    anchor,
    evidenceState: "unavailable",
    interpretationBullets: [],
    freshness,
    warnings: uniqueStrings([warning, ...freshnessWarnings(freshness)]),
  };
}

function buildBaseRateSummary(
  baseRate: Record<string, unknown> | undefined,
): ValidatedEdgeEvidenceView["baseRateSummary"] | undefined {
  if (!baseRate) return undefined;
  const hitRate = numberAt(baseRate, "hit_rate_pct") ??
    numberAt(baseRate, "hitRatePct") ??
    numberAt(baseRate, "hit_rate") ??
    numberAt(baseRate, "value");
  const median = numberAt(baseRate, "median_return_pct") ??
    numberAt(baseRate, "medianReturnPct") ??
    numberAt(baseRate, "median_return");
  const sampleAdequacy = publicString(
    stringAt(baseRate, "sample_adequacy") ??
      stringAt(baseRate, "sampleAdequacy"),
  );

  const summary = {
    ...(sampleAdequacy ? { sampleAdequacy } : {}),
    ...(hitRate !== undefined ? { hitRatePct: normalizePercent(hitRate) } : {}),
    ...(median !== undefined ? { medianReturnPct: normalizePercent(median) } : {}),
  };
  return Object.keys(summary).length ? summary : undefined;
}

function buildHorizonEvidence(
  pipelineEvidence: Record<string, unknown>,
): NonNullable<ValidatedEdgeEvidenceView["horizonEvidence"]> {
  const explicit = arrayAt(pipelineEvidence, "horizon_evidence") ??
    arrayAt(pipelineEvidence, "horizonEvidence");
  if (explicit?.length) {
    return explicit
      .map((item) => horizonEvidenceFromRecord(asRecord(item)))
      .filter((item): item is NonNullable<ValidatedEdgeEvidenceView["horizonEvidence"]>[number] => !!item)
      .slice(0, 5);
  }

  const hitRates = recordAt(pipelineEvidence, "mean_hit_rate_by_horizon") ??
    recordAt(pipelineEvidence, "hit_rate_by_horizon") ??
    recordAt(pipelineEvidence, "hitRateByHorizon");
  const alphas = recordAt(pipelineEvidence, "mean_alpha_by_horizon") ??
    recordAt(pipelineEvidence, "alpha_by_horizon") ??
    recordAt(pipelineEvidence, "alphaByHorizon");
  const edges = recordAt(pipelineEvidence, "edges_by_horizon") ??
    recordAt(pipelineEvidence, "edgesByHorizon");

  const keys = Array.from(
    new Set([
      ...Object.keys(hitRates ?? {}),
      ...Object.keys(alphas ?? {}),
      ...Object.keys(edges ?? {}),
    ]),
  );
  return keys
    .map((key) => {
      const hitRate = numberAt(hitRates, key);
      const alpha = numberAt(alphas, key);
      const edgeCount = numberAt(edges, key);
      return {
        horizon: normalizeHorizonLabel(key),
        ...(hitRate !== undefined ? { hitRatePct: normalizePercent(hitRate) } : {}),
        ...(alpha !== undefined ? { alphaBucket: alphaBucket(alpha) } : {}),
        ...(edgeCount !== undefined
          ? { evidenceStrength: evidenceStrengthFromCount(edgeCount) }
          : {}),
      };
    })
    .filter((item) => item.hitRatePct !== undefined || item.alphaBucket || item.evidenceStrength)
    .slice(0, 5);
}

function horizonEvidenceFromRecord(
  item: Record<string, unknown> | undefined,
): NonNullable<ValidatedEdgeEvidenceView["horizonEvidence"]>[number] | undefined {
  if (!item) return undefined;
  const rawHorizon = stringAt(item, "horizon") ?? stringAt(item, "label");
  if (!rawHorizon) return undefined;
  const hitRate = numberAt(item, "hit_rate_pct") ??
    numberAt(item, "hitRatePct") ??
    numberAt(item, "hit_rate");
  const alpha = numberAt(item, "alpha") ?? numberAt(item, "mean_alpha");
  const evidenceStrength = publicString(
    stringAt(item, "evidence_strength") ??
      stringAt(item, "evidenceStrength"),
  );
  return {
    horizon: normalizeHorizonLabel(rawHorizon),
    ...(hitRate !== undefined ? { hitRatePct: normalizePercent(hitRate) } : {}),
    ...(alpha !== undefined ? { alphaBucket: alphaBucket(alpha) } : {}),
    ...(evidenceStrength ? { evidenceStrength } : {}),
  };
}

function normalizeEvidenceState(
  value: string | undefined,
): ValidatedEdgeEvidenceState | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (/(strong|robust|high).*(edge|evidence)|edge_evidence_strong|validated_strong/.test(normalized)) {
    return "edge_evidence_strong";
  }
  if (/(present|supported|validated|accepted|evidence_backed|positive)/.test(normalized)) {
    return "edge_evidence_present";
  }
  if (/mixed|divergent|conflict/.test(normalized)) return "mixed";
  if (/insufficient|thin|weak|base_rate_only|no_edge|none/.test(normalized)) {
    return "insufficient_data";
  }
  if (/unavailable|missing|not_found/.test(normalized)) return "unavailable";
  return undefined;
}

function evidenceStateFromCounts(
  edgeCount: number | undefined,
  horizonCount: number,
): ValidatedEdgeEvidenceState {
  if (edgeCount === undefined) {
    return horizonCount > 0 ? "edge_evidence_present" : "insufficient_data";
  }
  if (edgeCount >= 10) return "edge_evidence_strong";
  if (edgeCount > 0) return "edge_evidence_present";
  return "insufficient_data";
}

function validatedEvidenceWarnings(
  state: ValidatedEdgeEvidenceState | undefined,
  explicitState: ValidatedEdgeEvidenceState | undefined,
  baseRateSummary: ValidatedEdgeEvidenceView["baseRateSummary"] | undefined,
): string[] {
  const warnings: string[] = [];
  if (!explicitState) {
    warnings.push(
      "Pipeline evidence state was not explicit in the Client API response; public buckets are partial.",
    );
  }
  if ((state === "insufficient_data" || state === "unavailable") && baseRateSummary) {
    warnings.push(
      "Historical/base-rate evidence is available, but validated pipeline edge evidence is not established.",
    );
  }
  return warnings;
}

function pipelineQualificationWarnings(
  liveConfirmationBucket: LiveConfirmationBucket | undefined,
  decayRiskBucket: DecayRiskBucket | undefined,
): string[] {
  const warnings: string[] = [];
  if (liveConfirmationBucket === "deteriorating") {
    warnings.push("Aggregate live tracking is deteriorating; interpret validated evidence with caution.");
  } else if (liveConfirmationBucket === "mixed") {
    warnings.push("Aggregate live tracking is mixed; this is not clean live confirmation.");
  }
  if (decayRiskBucket === "decay_elevated") {
    warnings.push("Aggregate decay risk is elevated; validated evidence should be interpreted with caution.");
  } else if (decayRiskBucket === "watch") {
    warnings.push("Aggregate decay risk is on watch; validated evidence should be interpreted with caution.");
  }
  return warnings;
}

function freshnessWarnings(freshness: PublicFreshnessView): string[] {
  if (freshness.warning) return [freshness.warning];
  return [];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function interpretationBullets(input: {
  anchor: ValidatedEdgeEvidenceAnchorView;
  evidenceState: ValidatedEdgeEvidenceState | undefined;
  edgeCountBucket?: string;
  eventSampleBucket?: string;
  hasBaseRate: boolean;
  pipelineRiskBand?: string;
  liveConfirmationBucket?: LiveConfirmationBucket;
  decayRiskBucket?: DecayRiskBucket;
}): string[] {
  const label = input.anchor.label ?? input.anchor.symbol ?? input.anchor.sector ??
    input.anchor.regime ?? "the requested anchor";
  const bullets: string[] = [];
  switch (input.evidenceState) {
    case "edge_evidence_strong":
      bullets.push(`Validated pipeline evidence is strong for ${label}.`);
      break;
    case "edge_evidence_present":
      bullets.push(`Validated pipeline evidence is present for ${label}.`);
      break;
    case "mixed":
      bullets.push(`Validated pipeline evidence is mixed for ${label}.`);
      break;
    case "insufficient_data":
      bullets.push(`Validated pipeline evidence is insufficient for ${label}.`);
      break;
    case "unavailable":
    default:
      bullets.push(`Validated pipeline evidence is unavailable for ${label}.`);
      break;
  }
  if (input.edgeCountBucket) {
    bullets.push(`Validated edge count bucket: ${input.edgeCountBucket}.`);
  }
  if (input.eventSampleBucket) {
    bullets.push(`Pipeline event sample bucket: ${input.eventSampleBucket}.`);
  }
  if (input.hasBaseRate) {
    bullets.push("Historical/base-rate evidence is included separately from validated pipeline evidence.");
  }
  if (input.pipelineRiskBand) {
    bullets.push(
      `Pipeline risk band: ${input.pipelineRiskBand}. This is not a daily drawdown probability.`,
    );
  }
  if (input.liveConfirmationBucket) {
    bullets.push(liveConfirmationBullet(input.liveConfirmationBucket));
  }
  if (input.decayRiskBucket) {
    bullets.push(decayRiskBullet(input.decayRiskBucket));
  }
  return bullets;
}

function liveConfirmationBullet(bucket: LiveConfirmationBucket): string {
  switch (bucket) {
    case "confirmed":
      return "Aggregate live tracking is confirming the validated evidence context.";
    case "mixed":
      return "Aggregate live tracking is mixed, so this is not clean live confirmation.";
    case "not_confirmed":
      return "Aggregate live tracking is not currently confirming the validated evidence context.";
    case "deteriorating":
      return "Aggregate live tracking is deteriorating; this is a caution signal, not trade advice.";
    case "insufficient_live_data":
    default:
      return "Aggregate live tracking data is insufficient.";
  }
}

function decayRiskBullet(bucket: DecayRiskBucket): string {
  switch (bucket) {
    case "no_recent_decay_warning":
      return "Aggregate decay checks show no recent decay warning.";
    case "watch":
      return "Aggregate decay checks are on watch; this is a caution signal, not proof the evidence is invalid.";
    case "decay_elevated":
      return "Aggregate decay risk is elevated; this is a caution signal, not proof the evidence is invalid.";
    case "insufficient_decay_data":
    default:
      return "Aggregate decay data is insufficient.";
  }
}

function buildLiveConfirmationBucket(
  pipelineEvidence: Record<string, unknown>,
): LiveConfirmationBucket | undefined {
  const nestedSentinel = recordAt(pipelineEvidence, "sentinel");
  const activePatterns = numberAt(nestedSentinel, "active_patterns") ??
    numberAt(nestedSentinel, "activePatterns") ??
    numberAt(pipelineEvidence, "sentinel_active_patterns") ??
    numberAt(pipelineEvidence, "sentinelActivePatterns");
  const lifecycleStates = recordAt(nestedSentinel, "lifecycle_states") ??
    recordAt(nestedSentinel, "lifecycleStates") ??
    recordAt(pipelineEvidence, "sentinel_lifecycle_states") ??
    recordAt(pipelineEvidence, "sentinelLifecycleStates");

  if (activePatterns === undefined && !lifecycleStates) return undefined;

  const trackingCount = sumLifecycleStates(lifecycleStates, (key) => /tracking/i.test(key)) ||
    Math.max(activePatterns ?? 0, 0);
  const positiveCount = sumLifecycleStates(lifecycleStates, (key) => /completed.*win|win/i.test(key));
  const adverseCount = sumLifecycleStates(
    lifecycleStates,
    (key) => !/tracking/i.test(key) && !(/completed.*win|win/i.test(key)),
  );
  const activeCount = Math.max(activePatterns ?? 0, trackingCount);

  if (activePatterns === undefined && !trackingCount && !adverseCount && !positiveCount) {
    return "insufficient_live_data";
  }
  if (activeCount <= 0 && adverseCount <= 0) return "not_confirmed";
  if (activeCount <= 0 && adverseCount > 0) return "deteriorating";
  if (adverseCount > 0) {
    return adverseCount >= Math.max(3, trackingCount * 2) ? "deteriorating" : "mixed";
  }
  return "confirmed";
}

function buildDecayRiskBucket(
  pipelineEvidence: Record<string, unknown>,
): DecayRiskBucket | undefined {
  const failures = numberAt(pipelineEvidence, "coroner_recent_failures_90d") ??
    numberAt(pipelineEvidence, "coronerRecentFailures90d");
  if (failures === undefined) return undefined;
  if (failures <= 0) return "no_recent_decay_warning";
  if (failures <= 2) return "watch";
  return "decay_elevated";
}

function sumLifecycleStates(
  states: Record<string, unknown> | undefined,
  predicate: (key: string) => boolean,
): number {
  if (!states) return 0;
  return Object.entries(states).reduce((sum, [key, value]) => {
    if (!predicate(key)) return sum;
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? sum + n : sum;
  }, 0);
}

function edgeCountBucket(value: number): string {
  if (value <= 0) return "none";
  if (value < 3) return "limited";
  if (value < 10) return "present";
  return "strong";
}

function eventSampleBucket(value: number): string {
  if (value <= 0) return "none";
  if (value < 30) return "thin";
  if (value < 100) return "adequate";
  return "robust";
}

function evidenceStrengthFromCount(value: number): string {
  if (value < 3) return "THIN";
  if (value < 10) return "ADEQUATE";
  return "ROBUST";
}

function alphaBucket(value: number): string {
  if (value >= 0.05) return "strong_positive";
  if (value > 0.01) return "positive";
  if (value < -0.01) return "negative";
  return "mixed";
}

function normalizePercent(value: number): number {
  const pct = Math.abs(value) <= 1 ? value * 100 : value;
  return Math.round(pct * 10) / 10;
}

function normalizeHorizonLabel(value: string): string {
  const match = value.match(/(\d+)/);
  return match ? `${match[1]}-day` : value;
}

function extractDataObject(value: unknown): Record<string, unknown> | undefined {
  const root = asRecord(value);
  if (!root) return undefined;
  return recordAt(root, "data") ?? root;
}

function recordAt(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return asRecord(value[key]);
}

function arrayAt(
  value: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  if (!value) return undefined;
  return Array.isArray(value[key]) ? value[key] as unknown[] : undefined;
}

function stringAt(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  if (!value) return undefined;
  return typeof value[key] === "string" && String(value[key]).trim()
    ? String(value[key]).trim()
    : undefined;
}

function numberAt(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  if (!value) return undefined;
  const raw = value[key];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function publicString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.trim().slice(0, 80);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return !!value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
