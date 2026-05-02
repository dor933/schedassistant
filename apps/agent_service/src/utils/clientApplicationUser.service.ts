import { ClientApplication, User } from "@scheduling-agent/database";
import { logger } from "../logger";

/**
 * Resolves the singleton client_applications row for v1.
 *
 * For v1 we run with a single shared `APPLICATION_AGENT_API_TOKEN` env var
 * and a single client app. The operator inserts ONE row into
 * `client_applications` and sets `DEFAULT_CLIENT_APPLICATION_ID` to its uuid.
 * When you onboard a second client, replace this with a per-token lookup
 * against `client_applications.api_token_hash`.
 */
export async function resolveDefaultClientApplication(): Promise<ClientApplication | null> {
  const id = process.env.DEFAULT_CLIENT_APPLICATION_ID;
  if (!id) return null;
  return ClientApplication.findByPk(id);
}

export type JitUserMetadata = {
  displayName?: string | null;
  email?: string | null;
  /** Anything else the upstream app wants the agent to be able to see. */
  extra?: Record<string, unknown> | null;
};

/**
 * Just-in-time provisioning: returns the internal `users` row for an external
 * user id, creating it (with `auth_provider='client_app'`, `password=null`)
 * the first time the user appears. On subsequent calls, optionally refreshes
 * cached profile fields from the supplied metadata.
 *
 * The returned `users.id` is the canonical identifier used everywhere
 * downstream — episodic memory scoping, consult_agent userId arg,
 * application_agent_threads partition key, etc.
 */
export async function resolveOrCreateClientUser(input: {
  clientApplication: ClientApplication;
  externalUserId: string;
  metadata?: JitUserMetadata;
}): Promise<User> {
  const { clientApplication, externalUserId, metadata } = input;

  // user_name is NOT NULL UNIQUE — derive a deterministic, namespaced value
  // so client-app users can never collide with native ones.
  const userName = `${clientApplication.slug}:${externalUserId}`;

  const externalMetadata = metadata?.extra ?? null;

  const [user, created] = await User.findOrCreate({
    where: {
      clientApplicationId: clientApplication.id,
      externalSub: externalUserId,
    },
    defaults: {
      userName,
      organizationId: clientApplication.organizationId,
      authProvider: "client_app",
      externalSub: externalUserId,
      clientApplicationId: clientApplication.id,
      displayName: metadata?.displayName ?? null,
      password: null,
      externalSyncedAt: new Date(),
      externalMetadata,
    },
  });

  if (created) {
    logger.info("ClientApplicationUser JIT-created", {
      userId: user.id,
      clientApplicationId: clientApplication.id,
      externalUserId,
    });
    return user;
  }

  // Existing row — opportunistically refresh cached fields if the caller
  // provided fresher data. Skip the write entirely when nothing has changed
  // to avoid a needless UPDATE per request.
  const updates: Partial<{
    displayName: string | null;
    externalSyncedAt: Date;
    externalMetadata: Record<string, unknown> | null;
  }> = {};

  if (metadata?.displayName !== undefined && metadata.displayName !== user.displayName) {
    updates.displayName = metadata.displayName;
  }
  if (externalMetadata !== undefined) {
    // JSONB equality is finicky; just stamp every time metadata is supplied.
    updates.externalMetadata = externalMetadata;
    updates.externalSyncedAt = new Date();
  }

  if (Object.keys(updates).length > 0) {
    await user.update(updates);
  }

  return user;
}
