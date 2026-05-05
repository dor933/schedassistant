import type { PipelineOverlayRegistryEntry } from "./types";

export const PIPELINE_OVERLAY_REGISTRY: readonly PipelineOverlayRegistryEntry[] = [
  {
    overlayName: "validatedEdgeEvidence",
    supportedAnchors: ["stock", "sector", "regime", "symbol_comparison", "sector_comparison"],
    allowedClientApiSources: [
      "tickerResearch",
      "sectorResearch",
      "regimeResearch",
      "symbolComparison",
      "sectorComparison",
    ],
    mapperStatus: "placeholder",
    freshnessPolicy: "manifest_public_freshness",
    forbiddenFieldPolicy: "pipeline_overlay_public_safe",
  },
  {
    overlayName: "sentinelTracking",
    supportedAnchors: ["stock", "sector", "regime"],
    allowedClientApiSources: ["tickerResearch", "sectorResearch", "regimeResearch"],
    mapperStatus: "placeholder",
    freshnessPolicy: "manifest_public_freshness",
    forbiddenFieldPolicy: "pipeline_overlay_public_safe",
  },
  {
    overlayName: "coronerDecay",
    supportedAnchors: ["stock", "sector", "regime"],
    allowedClientApiSources: ["tickerResearch", "sectorResearch", "regimeResearch"],
    mapperStatus: "placeholder",
    freshnessPolicy: "manifest_public_freshness",
    forbiddenFieldPolicy: "pipeline_overlay_public_safe",
  },
  {
    overlayName: "dailyDecision",
    supportedAnchors: ["anchorless"],
    allowedClientApiSources: ["manifest"],
    mapperStatus: "placeholder",
    freshnessPolicy: "manifest_public_freshness",
    forbiddenFieldPolicy: "pipeline_overlay_public_safe",
  },
  {
    overlayName: "acceptedDiscovery",
    supportedAnchors: ["stock", "sector", "regime"],
    allowedClientApiSources: ["tickerResearch", "sectorResearch", "regimeResearch"],
    mapperStatus: "placeholder",
    freshnessPolicy: "manifest_public_freshness",
    forbiddenFieldPolicy: "pipeline_overlay_public_safe",
  },
  {
    overlayName: "researchCard",
    supportedAnchors: ["stock", "sector", "regime", "symbol_comparison", "sector_comparison"],
    allowedClientApiSources: [
      "tickerResearch",
      "sectorResearch",
      "regimeResearch",
      "symbolComparison",
      "sectorComparison",
    ],
    mapperStatus: "placeholder",
    freshnessPolicy: "manifest_public_freshness",
    forbiddenFieldPolicy: "pipeline_overlay_public_safe",
  },
] as const;

export function pipelineOverlayRegistryEntry(
  overlayName: PipelineOverlayRegistryEntry["overlayName"],
): PipelineOverlayRegistryEntry | undefined {
  return PIPELINE_OVERLAY_REGISTRY.find((entry) => entry.overlayName === overlayName);
}

