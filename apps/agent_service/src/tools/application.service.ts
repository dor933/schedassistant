import type { CompiledStateGraph } from "@langchain/langgraph";
import { Agent } from "@scheduling-agent/database";
import type { ApplicationAgentState } from "../graphs/applicationGraph/state";
import { resolveOrCreateApplicationAgentThread } from "../utils/applicationAgentThread.service";
import { observeWithContext } from "../langfuse";
import { logger } from "../logger";

export type InvokeApplicationAgentInput = {
  agentId: string;
  input: string;
  /** Internal `users.id` of the calling primary's end user. */
  userId: number;
};

export type InvokeApplicationAgentResult =
  | { ok: true; output: string; userId: number; threadId: string }
  | { ok: false; status: number; error: string };

/**
 * Canonical invocation entry. Verifies the agent is of type 'application',
 * resolves a stable thread id for `(userId, agentId)`, and runs the
 * application graph. Called in-process by `invoke_application_agent`, the
 * tool that primary agents use to delegate to application agents.
 */
export async function invokeApplicationAgent(
  graph: CompiledStateGraph<any, any, any>,
  { agentId, input, userId }: InvokeApplicationAgentInput,
): Promise<InvokeApplicationAgentResult> {
  if (!agentId) {
    return { ok: false, status: 400, error: "agentId is required." };
  }
  if (!input || typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, status: 400, error: "input is required and must be a non-empty string." };
  }
  if (typeof userId !== "number") {
    return { ok: false, status: 400, error: "userId is required and must be a number." };
  }

  const agent = await Agent.findByPk(agentId, {
    attributes: ["id", "type", "agentName"],
  });
  if (!agent) {
    return { ok: false, status: 404, error: `Agent "${agentId}" not found.` };
  }
  if (agent.type !== "application") {
    return {
      ok: false,
      status: 400,
      error: `Agent "${agentId}" has type "${agent.type}", expected "application".`,
    };
  }

  // Stable thread per (user, application_agent). The inner deep agent's
  // PostgresSaver resumes its prior conversation under this thread id.
  const threadId = await resolveOrCreateApplicationAgentThread({
    userId,
    applicationAgentId: agentId,
  });

  logger.info("Application agent invoke", {
    agentId,
    agentName: agent.agentName,
    inputLength: input.length,
    userId,
    threadId,
  });

  try {
    // observeWithContext opens a parent Langfuse span for this whole request;
    // the inner deep-agent's CallbackHandler (wired in applicationCallModel)
    // attaches LLM/tool steps under it via OpenTelemetry context propagation.
    // No-op when LANGFUSE_*_KEY env vars aren't set.
    const finalState = (await observeWithContext(
      "application_agent_invoke",
      async () =>
        graph.invoke(
          {
            agentId,
            userId,
            applicationThreadId: threadId,
            request: input,
          },
          // The OUTER graph thread id is transient — we just need a unique value
          // for MemorySaver. The inner deep agent uses `applicationThreadId` from
          // state for its PostgresSaver, which is what actually matters.
          { configurable: { thread_id: `outer-${threadId}-${Date.now()}` } },
        ),
      {
        agentId,
        agentName: agent.agentName,
        userId,
        threadId,
        inputLength: input.length,
      },
    )) as ApplicationAgentState;

    if (finalState?.error) {
      return { ok: false, status: 500, error: finalState.error };
    }

    const output: string = finalState?.response ?? "";
    return { ok: true, output, userId, threadId };
  } catch (err: any) {
    const message = err?.message ?? String(err);
    logger.error("Application agent invoke failed", { agentId, userId, error: message });
    return { ok: false, status: 500, error: message };
  }
}
