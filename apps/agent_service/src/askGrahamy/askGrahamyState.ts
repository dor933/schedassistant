import { Annotation } from "@langchain/langgraph";
import type { runGrahamyDeepAgent } from "./grahamyAgent";
import type {
  AnalystBriefSynthesisInput,
  AnalystBriefSynthesisResult,
} from "./analystBriefSynthesizer";
import type {
  ResearchPlanExecutor,
} from "./researchPlanner";
import type {
  CachedCapabilityView,
  PgCapabilityRunInput,
  PgCapabilityRunResult,
} from "./pgCapabilities/types";
import type {
  PipelineOverlayRunInput,
  PipelineOverlayRunResult,
} from "./pipelineOverlays/registry";
import type { buildResearchObjects } from "./researchObjectBuilder";
import { GrahamySnapshotClient } from "./snapshotClient";
import type { AskGrahamyResponse, AskGrahamyState } from "./types";

export type SnapshotClient = Pick<
  GrahamySnapshotClient,
  "fetchPublishedSnapshots"
>;

export type RunAskGrahamyGraphOptions = {
  snapshotClient?: SnapshotClient;
  /**
   * Test seam for the underlying capability SQL run. Returns the raw
   * `{views, warnings}` shape — `loadPgCapabilities` wraps this in cache
   * lookup/write logic via `executePgCapabilitiesWithCache`. Production
   * code leaves this undefined so `executePgCapabilities` is used.
   */
  pgCapabilityRunner?: (
    input: PgCapabilityRunInput,
  ) => Promise<PgCapabilityRunResult>;

  pipelineOverlayRunner?: (
    input: PipelineOverlayRunInput,
  ) => Promise<PipelineOverlayRunResult>;

  researchPlanExecutor?: ResearchPlanExecutor;

  analystBriefSynthesizer?: (
    input: AnalystBriefSynthesisInput,
  ) => Promise<AnalystBriefSynthesisResult>;


  researchObjectBuilder?: typeof buildResearchObjects;

  
  grahamyAgentRunner?: typeof runGrahamyDeepAgent;
};

export type AskGrahamyGraphState = AskGrahamyState & {
  options: RunAskGrahamyGraphOptions;
  snapshotClient: SnapshotClient;
  plannerHandled: boolean;
  response?: AskGrahamyResponse;
  error?: string;
};

function replaceStateValue<T>(state: T, update: T): T {
  return update !== undefined ? update : state;
}

export const AskGrahamyGraphAnnotation = Annotation.Root({
  internalUserId: Annotation<number>({
    reducer: replaceStateValue,
    default: () => 0,
  }),
  conversationId: Annotation<AskGrahamyState["conversationId"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  message: Annotation<string>({
    reducer: replaceStateValue,
    default: () => "",
  }),
  messageId: Annotation<AskGrahamyState["messageId"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  previousContext: Annotation<AskGrahamyState["previousContext"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  classification: Annotation<AskGrahamyState["classification"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  snapshots: Annotation<AskGrahamyState["snapshots"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  selectedTools: Annotation<AskGrahamyState["selectedTools"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  toolOutputs: Annotation<AskGrahamyState["toolOutputs"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  asOfDate: Annotation<AskGrahamyState["asOfDate"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  priorResearchObjects: Annotation<AskGrahamyState["priorResearchObjects"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  researchObjects: Annotation<AskGrahamyState["researchObjects"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  researchObjectsUpdated: Annotation<AskGrahamyState["researchObjectsUpdated"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  researchObjectCacheStats: Annotation<
    AskGrahamyState["researchObjectCacheStats"]
  >({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  priorCapabilityViews: Annotation<AskGrahamyState["priorCapabilityViews"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  pgCapabilityViews: Annotation<AskGrahamyState["pgCapabilityViews"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  pipelineOverlayViews: Annotation<AskGrahamyState["pipelineOverlayViews"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  compoundResearchContext: Annotation<
    AskGrahamyState["compoundResearchContext"]
  >({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  workflowExecutionResult: Annotation<
    AskGrahamyState["workflowExecutionResult"]
  >({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  evidencePack: Annotation<AskGrahamyState["evidencePack"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  analystBrief: Annotation<AskGrahamyState["analystBrief"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  capabilityViewsUpdated: Annotation<AskGrahamyState["capabilityViewsUpdated"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  capabilityViewCacheStats: Annotation<
    AskGrahamyState["capabilityViewCacheStats"]
  >({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  publicResearchView: Annotation<AskGrahamyState["publicResearchView"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  answer: Annotation<AskGrahamyState["answer"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  ui: Annotation<AskGrahamyState["ui"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  meta: Annotation<AskGrahamyState["meta"]>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  warnings: Annotation<string[]>({
    reducer: replaceStateValue,
    default: () => [],
  }),
  options: Annotation<RunAskGrahamyGraphOptions>({
    reducer: replaceStateValue,
    default: () => ({}),
  }),
  snapshotClient: Annotation<SnapshotClient>({
    reducer: replaceStateValue,
    default: () => new GrahamySnapshotClient(),
  }),
  plannerHandled: Annotation<boolean>({
    reducer: replaceStateValue,
    default: () => false,
  }),
  response: Annotation<AskGrahamyResponse | undefined>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
  error: Annotation<string | undefined>({
    reducer: replaceStateValue,
    default: () => undefined,
  }),
});

export type AskGrahamyLangGraphState = typeof AskGrahamyGraphAnnotation.State;

export function toAskGrahamyState(
  state: AskGrahamyLangGraphState | AskGrahamyGraphState,
): AskGrahamyState {
  return {
    ...state,
    warnings: [...(state.warnings ?? [])],
  };
}

export function patchFromAskGrahamyState(
  state: AskGrahamyState,
): Partial<AskGrahamyGraphState> {
  return {
    ...state,
    warnings: [...state.warnings],
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runGraphNode(
  state: AskGrahamyLangGraphState,
  action: () => Promise<Partial<AskGrahamyGraphState>>,
): Promise<Partial<AskGrahamyGraphState>> {
  if (state.error) return {};
  try {
    return await action();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export type { CachedCapabilityView };
