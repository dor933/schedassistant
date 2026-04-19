import { AgentUserScope, User } from "@scheduling-agent/database";
import type { GoogleScope } from "@scheduling-agent/types";

/**
 * Single authoritative check: does `authorityAgentId` hold `scope` over
 * `subjectUserId`'s Google data? Returns the subject's Workspace email on
 * allow (callers need it for DWD impersonation) or null on deny.
 *
 * `authorityAgentId` is the *primary* agent — the caller. System agents
 * spawned via delegate_to_deep_agent don't have their own scope grants;
 * they inherit from the caller, so this function is always called with
 * the caller's id.
 */
export async function resolveScopedSubject(
  authorityAgentId: string,
  subjectUserId: number,
  scope: GoogleScope,
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const [grant, subject] = await Promise.all([
    AgentUserScope.findOne({
      where: { agentId: authorityAgentId, subjectUserId, scope },
      attributes: ["id"],
    }),
    User.findByPk(subjectUserId, {
      attributes: ["id", "userName", "externalSub", "authProvider"],
    }),
  ]);

  if (!grant) {
    return {
      ok: false,
      reason:
        `Access denied. Agent ${authorityAgentId} has no "${scope}" grant ` +
        `on user ${subjectUserId}. A super admin must grant this permission ` +
        `in Admin → Google Permissions before you can perform this action.`,
    };
  }
  if (!subject) {
    return { ok: false, reason: `User ${subjectUserId} not found.` };
  }
  if (!subject.externalSub || subject.authProvider !== "google") {
    return {
      ok: false,
      reason:
        `User ${subjectUserId} has not authenticated with Google, so their ` +
        `Workspace identity cannot be impersonated.`,
    };
  }
  return { ok: true, email: subject.userName };
}
