import type { PublicFreshnessView } from "../types";

export type PipelineClientApiSource =
  | "manifest"
  | "tickerResearch"
  | "sectorResearch"
  | "regimeResearch"
  | "symbolComparison"
  | "sectorComparison";

export type PipelineRegime = "current" | "RISK_ON" | "NEUTRAL" | "RISK_OFF";

export type PipelineOverlayName =
  | "validatedEdgeEvidence"
  | "sentinelTracking"
  | "coronerDecay"
  | "dailyDecision"
  | "acceptedDiscovery"
  | "researchCard";

export type PipelineOverlayAnchorType =
  | "stock"
  | "sector"
  | "regime"
  | "symbol_comparison"
  | "sector_comparison"
  | "anchorless";

export type PipelineClientOptions = {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type PipelineClientRequestOptions = {
  etag?: string;
};

export type PipelineClientSuccess = {
  ok: true;
  source: PipelineClientApiSource;
  statusCode: number;
  rawEnvelope: unknown;
  latencyMs: number;
  etag?: string;
};

export type PipelineClientNotModified = {
  ok: false;
  source: PipelineClientApiSource;
  status: "not_modified";
  statusCode: 304;
  latencyMs: number;
  etag?: string;
};

export type PipelineClientUnavailableReason =
  | "not_configured"
  | "bad_request"
  | "not_found"
  | "rate_limited"
  | "upstream_error"
  | "timeout"
  | "network_error";

export type PipelineClientUnavailable = {
  ok: false;
  source: PipelineClientApiSource;
  status: "unavailable";
  reason: PipelineClientUnavailableReason;
  statusCode?: number;
  latencyMs?: number;
  retryAfterSeconds?: number;
  warning: string;
};

export type PipelineClientResult =
  | PipelineClientSuccess
  | PipelineClientNotModified
  | PipelineClientUnavailable;

export type PipelineOverlayState = "complete" | "partial" | "unavailable";

export type PublicOverlayMapResult<TView> = {
  state: PipelineOverlayState;
  view?: TView;
  freshness?: PublicFreshnessView;
  warnings: string[];
};

export type PipelineOverlayRegistryEntry = {
  overlayName: PipelineOverlayName;
  supportedAnchors: PipelineOverlayAnchorType[];
  allowedClientApiSources: PipelineClientApiSource[];
  mapperStatus: "implemented" | "placeholder";
  freshnessPolicy: "manifest_public_freshness";
  forbiddenFieldPolicy: "pipeline_overlay_public_safe";
};
