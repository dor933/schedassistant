import { AgentUserScope, User } from "@scheduling-agent/database";
import type { GoogleScope } from "@scheduling-agent/types";

/**
 * Single authoritative check: does `authorityAgentId` hold `scope` over the
 * user identified by `subjectEmail`'s Google data? Returns the subject's
 * Workspace email on allow (callers need it for DWD impersonation) or a
 * reason string on deny.
 *
 * Primary agents delegate workspace ops by email (they don't know internal
 * user ids). The workspace agent translates email → user id here and then
 * runs the scope check.
 *
 * `authorityAgentId` is the *primary* agent — the caller. System agents
 * spawned via delegate_to_deep_agent don't have their own scope grants;
 * they inherit from the caller, so this function is always called with
 * the caller's id.
 */
export async function resolveScopedSubject(
  authorityAgentId: string,
  subjectEmail: string,
  scope: GoogleScope,
): Promise<{ ok: true; email: string } | { ok: false; reason: string }> {
  const normalized = subjectEmail.trim().toLowerCase();
  if (!normalized) {
    return { ok: false, reason: "Missing subject email." };
  }

  const subject = await User.findOne({
    where: { userName: normalized },
    attributes: ["id", "userName", "externalSub", "authProvider"],
  });

  if (!subject) {
    return {
      ok: false,
      reason:
        `No user with email "${normalized}" exists in this workspace. ` +
        `Call \`list_google_workspace_grants\` to see the users you have permission to act on.`,
    };
  }

  const grant = await AgentUserScope.findOne({
    where: { agentId: authorityAgentId, subjectUserId: subject.id, scope },
    attributes: ["id"],
  });

  if (!grant) {
    return {
      ok: false,
      reason:
        `Access denied. The calling agent has no "${scope}" grant on ${normalized}. ` +
        `A super admin must grant this permission in Admin → Google Permissions before ` +
        `this action can be performed. Use \`list_google_workspace_grants\` to see what is allowed.`,
    };
  }
  if (!subject.externalSub || subject.authProvider !== "google") {
    return {
      ok: false,
      reason:
        `${normalized} has not authenticated with Google, so their Workspace identity ` +
        `cannot be impersonated.`,
    };
  }
  return { ok: true, email: subject.userName };
}
