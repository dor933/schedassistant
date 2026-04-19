/**
 * Bootstrap a platform admin. Run out-of-band (never from the app runtime):
 *
 *   PLATFORM_ADMIN_EMAIL=you@company.com \
 *   PLATFORM_ADMIN_PASSWORD='strong-password' \
 *   npx ts-node apps/user_app/scripts/create-platform-admin.ts
 *
 * Upserts on email, so re-running with the same email rotates the password
 * hash. We never commit credentials to the repo — they come from env vars
 * at provisioning time, same pattern as any other secret.
 */
import bcrypt from "bcrypt";
import { PlatformAdmin, sequelize } from "@scheduling-agent/database";

async function main() {
  const email = process.env.PLATFORM_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      "Error: PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be set.",
    );
    process.exit(1);
  }

  if (password.length < 12) {
    // 12 is a floor, not a policy — platform admins can bypass every tenant
    // boundary, so a weak credential is worse here than for any tenant user.
    console.error("Error: PLATFORM_ADMIN_PASSWORD must be at least 12 characters.");
    process.exit(1);
  }

  await sequelize.authenticate();

  const passwordHash = await bcrypt.hash(password, 12);

  const existing = await PlatformAdmin.findOne({ where: { email } });
  if (existing) {
    await existing.update({ passwordHash });
    console.log(`Rotated password for existing platform admin: ${email}`);
  } else {
    const created = await PlatformAdmin.create({ email, passwordHash });
    console.log(`Created platform admin: ${email} (id=${created.id})`);
  }

  await sequelize.close();
}

main().catch((err) => {
  console.error("Failed to create platform admin:", err);
  process.exit(1);
});
