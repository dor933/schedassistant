import { tool } from "@langchain/core/tools";
import { z } from "zod";
import crypto from "node:crypto";
import { HumanMessage } from "@langchain/core/messages";
import { Agent, LLMModel } from "@scheduling-agent/database";
import { getGraph } from "../deps";
import { ensureSession } from "../sessionsManagment/sessionRegistry";
import { createThreadLockRedis, withThreadLockTimeout, LockTimeoutError } from "../worker/threadLock";
import { getRedisConfig } from "../redisClient";
import { setActiveConsultation, clearActiveConsultation } from "../consultationChain";
import { logger } from "../logger";

/**
 * Resolve the model slug for a target agent from the agent's own modelId.
 * Falls back to "gpt-4o" if no model is configured on the agent.
 */
async function resolveModelForAgent(agentId: string): Promise<string> {
  try {
    const agent = await Agent.findByPk(agentId, { attributes: ["modelId"] });
    if (agent?.modelId) {
      const model = await LLMModel.findByPk(agent.modelId, { attributes: ["slug"] });
      if (model) return model.slug;
    }
  } catch { /* fall through */ }
  return "gpt-4o";
}

const lockRedis = createThreadLockRedis(getRedisConfig());

/** Max time to wait for the target agent's lock (seconds). */
const CONSULT_LOCK_TIMEOUT_MS = Number(
  process.env.CONSULT_AGENT_LOCK_TIMEOUT_MS ?? 60_000, // 60s default
);

/** Max time for the entire consultation (graph.invoke) to complete (ms). */
const CONSULT_EXECUTION_TIMEOUT_MS = Number(
  process.env.CONSULT_AGENT_EXECUTION_TIMEOUT_MS ?? 300_000, // 5 min default
);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Synchronous agent-to-agent consultation tool (Tier 1).
 *
 * Includes two safety mechanisms:
 * 1. Lock timeout — if the target agent is busy, gives up after CONSULT_LOCK_TIMEOUT_MS
 * 2. Execution timeout — if the consultation takes too long, aborts after CONSULT_EXECUTION_TIMEOUT_MS
 */
export function ConsultAgentTool(
  callerAgentId: string,
  userId: number,
  groupId: string | null = null,
  singleChatId: string | null = null,
) {
  return tool(
    async (input) => {
      const { targetAgentId, request } = input;

      if (targetAgentId === callerAgentId) {
        return "Error: an agent cannot consult itself.";
      }

      const targetAgent = await Agent.findByPk(targetAgentId, {
        attributes: ["id", "activeThreadId", "definition"],
      });
      if (!targetAgent) {
        return `Error: agent "${targetAgentId}" not found.`;
      }

      const graph = getGraph();
      const lockKey = `agent:thread:${targetAgentId}`;
      const agentLabel = targetAgent.definition || targetAgentId;

      logger.info("ConsultAgent: starting sync consultation", {
        callerAgentId,
        targetAgentId,
        requestLen: request.length,
      });

      try {
        const answer = await withThreadLockTimeout(
          lockRedis,
          lockKey,
          CONSULT_LOCK_TIMEOUT_MS,
          async () => {
            let threadId = targetAgent.activeThreadId;
            if (!threadId) {
              threadId = crypto.randomUUID();
              await ensureSession(threadId, null, { agentId: targetAgentId });
              await Agent.update(
                { activeThreadId: threadId },
                { where: { id: targetAgentId } },
              );
            }

            // Resolve model from agent B's own config, NOT from agent A's conversation
            const modelSlug = await resolveModelForAgent(targetAgentId);

            // Mark Agent B as being consulted by Agent A so that if Agent B
            // delegates to a deep agent, the result can propagate back.
            await setActiveConsultation(targetAgentId, {
              originAgentId: callerAgentId,
              originGroupId: groupId,
              originSingleChatId: singleChatId,
              originUserId: userId,
            });

            const result = await withTimeout(
              graph.invoke(
                {
                  userId,
                  threadId,
                  groupId: null,
                  singleChatId: null,
                  agentId: targetAgentId,
                  modelSlug,
                  userInput: request,
                  messages: [
                    new HumanMessage({
                      content: `[Consultation request from another agent]\n\n${request}`,
                      name: "agent_consultation",
                    }),
                  ],
                },
                { configurable: { thread_id: threadId } },
              ),
              CONSULT_EXECUTION_TIMEOUT_MS,
              `Consultation with agent "${agentLabel}"`,
            );

            if (result.error) {
              return `Agent "${agentLabel}" encountered an error: ${result.error}`;
            }

            const messages: any[] = Array.isArray(result.messages) ? result.messages : [];
            const lastAi = [...messages]
              .reverse()
              .find(
                (m: any) =>
                  (typeof m._getType === "function" && m._getType() === "ai") ||
                  m.role === "assistant",
              );

            const rawContent = lastAi?.content;
            if (rawContent == null) return "The consulted agent did not produce a response.";
            if (typeof rawContent === "string") return rawContent;
            // content is an array of blocks (e.g. [{type:"thinking",...},{type:"text",text:"..."}])
            if (Array.isArray(rawContent)) {
              return rawContent
                .filter((b: any) => b?.type === "text" && typeof b.text === "string")
                .map((b: any) => b.text)
                .join("\n") || "The consulted agent did not produce a text response.";
            }
            return String(rawContent);
          },
        );

        await clearActiveConsultation(targetAgentId);

        logger.info("ConsultAgent: consultation completed", {
          callerAgentId,
          targetAgentId,
          answerLen: typeof answer === "string" ? answer.length : 0,
        });

        return typeof answer === "string" ? answer : String(answer);
      } catch (err: any) {
        await clearActiveConsultation(targetAgentId);
        if (err instanceof LockTimeoutError) {
          logger.warn("ConsultAgent: target agent is busy", {
            callerAgentId,
            targetAgentId,
            timeoutMs: CONSULT_LOCK_TIMEOUT_MS,
          });
          return (
            `Agent "${agentLabel}" is currently busy processing another request and could not be reached ` +
            `within ${Math.round(CONSULT_LOCK_TIMEOUT_MS / 1000)} seconds. ` +
            `Please inform the user that the agent is occupied and suggest trying again shortly, ` +
            `or consider delegating this to an executor agent using delegate_to_deep_agent if appropriate.`
          );
        }

        const isTimeout = err?.message?.includes("timed out");
        if (isTimeout) {
          logger.warn("ConsultAgent: execution timed out", {
            callerAgentId,
            targetAgentId,
            timeoutMs: CONSULT_EXECUTION_TIMEOUT_MS,
          });
          return (
            `Consultation with agent "${agentLabel}" timed out after ` +
            `${Math.round(CONSULT_EXECUTION_TIMEOUT_MS / 1000)} seconds. ` +
            `The task may be too complex for a synchronous consultation. ` +
            `Consider delegating it to an executor agent via delegate_to_deep_agent instead.`
          );
        }

        logger.error("ConsultAgent: consultation failed", {
          callerAgentId,
          targetAgentId,
          error: err?.message,
        });
        return `Error consulting agent "${agentLabel}": ${err?.message ?? "unknown error"}`;
      }
    },
    {
      name: "consult_agent",
      description:
        "Consult another agent for their expertise. The target agent will receive your request, " +
        "process it with its own knowledge and tools, and return an answer. " +
        "Use this when a task falls outside your specialization and another agent is better equipped to handle it. " +
        "This is a synchronous call — you will receive the answer immediately. " +
        "If the target agent is busy or the consultation takes too long, you will receive an error message.",
      schema: z.object({
        targetAgentId: z
          .string()
          .uuid()
          .describe("The ID of the agent to consult (from the agents table)."),
        request: z
          .string()
          .min(1)
          .describe("A clear, detailed description of what you need from the other agent."),
      }),
    },
  );
}
