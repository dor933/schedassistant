import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rolesRouter } from "./roles.routes";
import { usersRouter } from "./users.routes";
import { agentsRouter } from "./agents.routes";
import { groupsRouter } from "./groups.routes";
import { modelsRouter } from "./models.routes";
import { mcpServersRouter } from "./mcpServers.routes";
import { skillsRouter } from "./skills.routes";
import { projectsRouter } from "./projects.routes";
import { roundtableRouter } from "./roundtable.routes";
import { toolsRouter } from "./tools.routes";
import { cronJobsRouter } from "./cronJobs.routes";
import { webSearchAgentRouter } from "./webSearchAgent.routes";
import { agentUserScopesRouter } from "./agentUserScopes.routes";
import { vendorApiKeysRouter } from "./vendorApiKeys.routes";
import { organizationRouter } from "./organization.routes";
import { libraryRouter } from "./library.routes";
import { embeddingConfigRouter } from "./embeddingConfig.routes";
// codex-auth-json: removed in slice 14. The Codex CLI auth.json is now
// stored as `key_type='auth_object'` on the regular per-org
// `organization_vendor_api_keys` row for the OpenAI vendor — no separate
// system-wide endpoint or storage path. Admins set/clear it via the
// vendor-api-keys admin endpoint with the new `authObject` body field.

const router = Router();

// All admin routes require auth + admin/super_admin role
router.use(authMiddleware, requireAdmin);

router.use("/roles", rolesRouter);
router.use("/users", usersRouter);
router.use("/agents", agentsRouter);
router.use("/groups", groupsRouter);
router.use("/mcp-servers", mcpServersRouter);
router.use("/skills", skillsRouter);
router.use("/projects", projectsRouter);
router.use("/roundtables", roundtableRouter);
router.use("/tools", toolsRouter);
router.use("/cron-jobs", cronJobsRouter);
router.use("/web-search-agent", webSearchAgentRouter);
router.use("/vendor-api-keys", vendorApiKeysRouter);
router.use("/organization", organizationRouter);
router.use("/library", libraryRouter);
router.use("/embedding-config", embeddingConfigRouter);
// Agent ↔ user Google scope grants (super_admin gated inside the router).
// Mounts at the admin root so the same router covers both
// /admin/google-users and /admin/agents/:agentId/user-scopes.
router.use("/", agentUserScopesRouter);
// models router handles /models, /vendors, and /single-chats paths
router.use("/", modelsRouter);

export { router as adminRouter };
