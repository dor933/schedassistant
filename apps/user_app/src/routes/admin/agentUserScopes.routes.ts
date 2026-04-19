import { Router } from "express";
import { AgentUserScopesController } from "../../controllers/admin/agentUserScopes.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new AgentUserScopesController();

/**
 * Super-admin only — the whole feature is a tenant-ownership question, not a
 * routine admin task, so regular admins don't see it.
 *
 * Mounted at two different paths in admin/index.ts:
 *   /admin/google-users            → controller.listGoogleUsers
 *   /admin/agents/:agentId/user-scopes → list / grant / revoke
 */
router.use(requireSuperAdmin);

router.get("/google-users", controller.listGoogleUsers);
router.get("/agents/:agentId/user-scopes", controller.listForAgent);
router.post("/agents/:agentId/user-scopes", controller.grant);
router.delete("/agents/:agentId/user-scopes", controller.revoke);

export { router as agentUserScopesRouter };
