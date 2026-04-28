import type { CompiledStateGraph } from "@langchain/langgraph";
import { Agent } from "@scheduling-agent/database";
import type { ApplicationAgentState } from "../graphs/applicationGraph/state";
import { resolveOrCreateApplicationAgentThread } from "./applicationAgentThread.service";
import {
  resolveDefaultClientApplication,
  resolveOrCreateClientUser,
  type JitUserMetadata,
} from "./clientApplicationUser.service";
import { logger } from "../logger";

export type InvokeApplicationAgentInput = {
  agentId: string;
  input: string;
  /**
   * The internal `users.id` representing the end user. For REST callers this
   * is JIT-resolved from `externalUserId`; for primary-tool delegations this
   * is the calling primary's `state.userId`.
   */
  userId: number;
};

export type InvokeApplicationAgentForExternalUserInput = {
  agentId: string;
  input: string;
  /** The upstream client app's user identifier (string; we accept any shape). */
  externalUserId: string;
  /** Optional cached profile fields refreshed each invocation. */
  userMetadata?: JitUserMetadata;
};

export type InvokeApplicationAgentResult =
  | { ok: true; output: string; userId: number; threadId: string }
  | { ok: false; status: number; error: string };

/**
 * Canonical invocation entry. Verifies the agent is of type 'application',
 * resolves a stable thread id for `(userId, agentId)`, and runs the
 * application graph. Used by both the REST controller (after JIT user
 * resolution) and by the `invoke_application_agent` tool that primary
 * agents call.
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
    const finalState = (await graph.invoke(
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

/**
 * REST entry point. JIT-resolves the external user id to an internal
 * `users.id`, then defers to `invokeApplicationAgent`. The single shared
 * `APPLICATION_AGENT_API_TOKEN` already authenticated the request — this
 * function trusts that the controller has done the auth check.
 */
export async function invokeApplicationAgentForExternalUser(
  graph: CompiledStateGraph<any, any, any>,
  { agentId, input, externalUserId, userMetadata }: InvokeApplicationAgentForExternalUserInput,
): Promise<InvokeApplicationAgentResult> {
  if (!externalUserId || typeof externalUserId !== "string") {
    return { ok: false, status: 400, error: "externalUserId is required and must be a string." };
  }

  const clientApplication = await resolveDefaultClientApplication();
  if (!clientApplication) {
    return {
      ok: false,
      status: 500,
      error:
        "No default client application configured. Insert a row into `client_applications` and set `DEFAULT_CLIENT_APPLICATION_ID` to its uuid.",
    };
  }

  const user = await resolveOrCreateClientUser({
    clientApplication,
    externalUserId,
    metadata: userMetadata,
  });

  return invokeApplicationAgent(graph, {
    agentId,
    input,
    userId: user.id,
  });
}
