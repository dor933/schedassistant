import { Router } from "express";
import { AgentUserScopesController } from "../../controllers/admin/agentUserScopes.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new AgentUserScopesController();

/**
 * Super-admin only — the whole feature is a tenant-ownership question, not a
 * routine admin task, so regular admins don't see it.
 *
 * Mounted at `/` in admin/index.ts so the same router covers both
 *   /admin/google-users            → controller.listGoogleUsers
 *   /admin/agents/:agentId/user-scopes → list / grant / revoke
 *
 * `requireSuperAdmin` is attached per-route (not via `router.use`) on purpose:
 * because this router is mounted at `/`, a `router.use`-style middleware would
 * fire for every `/admin/*` request (including siblings like `/admin/models`)
 * before Express tried to match a concrete handler — blocking plain admins
 * from every admin endpoint.
 */
router.get("/google-users", requireSuperAdmin, controller.listGoogleUsers);
router.get("/agents/:agentId/user-scopes", requireSuperAdmin, controller.listForAgent);
router.post("/agents/:agentId/user-scopes", requireSuperAdmin, controller.grant);
router.delete("/agents/:agentId/user-scopes", requireSuperAdmin, controller.revoke);

export { router as agentUserScopesRouter };
