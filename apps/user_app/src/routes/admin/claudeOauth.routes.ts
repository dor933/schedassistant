import { Router } from "express";
import { ClaudeOauthController } from "../../controllers/admin/claudeOauth.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new ClaudeOauthController();

// The token is a system-wide credential used by the agent_service container's
// Claude CLI. Restrict to super_admin — same gate as vendor API keys.
router.use(requireSuperAdmin);

router.get("/", controller.get);
router.put("/", controller.set);
router.delete("/", controller.remove);

export { router as claudeOauthRouter };
