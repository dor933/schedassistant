import { Agent, Group, SingleChat } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Resolves the canonical (active) thread for a conversation.
 *
 * After thread rotation the client may still send the old thread ID.
 * This function looks up `active_thread_id` on the conversation table
 * and returns it if set, otherwise falls back to the client-supplied ID.
 */
export async function resolveCanonicalThreadId(
  clientThreadId: string,
  groupId: string | null | undefined,
  singleChatId: string | null | undefined,
): Promise<string> {
  if (groupId) {
    const group = await Group.findByPk(groupId, {
      attributes: ["activeThreadId"],
    });
    if (group?.activeThreadId) {
      if (group.activeThreadId !== clientThreadId) {
        logger.info("Resolved canonical thread (group)", {
          groupId,
          clientThreadId,
          canonicalThreadId: group.activeThreadId,
        });
      }
      return group.activeThreadId;
    }
  } else if (singleChatId) {
    const sc = await SingleChat.findByPk(singleChatId, {
      attributes: ["activeThreadId", "agentId"],
    });
    let canonical: string | null = null;
    if (sc?.agentId) {
      const agent = await Agent.findByPk(sc.agentId, {
        attributes: ["activeThreadId", "groupId"],
      });
      if (agent && !agent.groupId && agent.activeThreadId) {
        canonical = agent.activeThreadId;
      }
    }
    if (!canonical && sc?.activeThreadId) {
      canonical = sc.activeThreadId;
    }
    if (canonical) {
      if (canonical !== clientThreadId) {
        logger.info("Resolved canonical thread (single chat)", {
          singleChatId,
          clientThreadId,
          canonicalThreadId: canonical,
        });
      }
      return canonical;
    }
  }

  return clientThreadId;
}
