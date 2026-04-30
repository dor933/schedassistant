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
import { claudeOauthRouter } from "./claudeOauth.routes";
import { codexApiKeyRouter } from "./codexApiKey.routes";
import { codexAuthJsonRouter } from "./codexAuthJson.routes";

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
router.use("/claude-oauth-token", claudeOauthRouter);
router.use("/codex-api-key", codexApiKeyRouter);
router.use("/codex-auth-json", codexAuthJsonRouter);
// Agent ↔ user Google scope grants (super_admin gated inside the router).
// Mounts at the admin root so the same router covers both
// /admin/google-users and /admin/agents/:agentId/user-scopes.
router.use("/", agentUserScopesRouter);
// models router handles /models, /vendors, and /single-chats paths
router.use("/", modelsRouter);

export { router as adminRouter };
