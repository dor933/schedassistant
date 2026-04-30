import { Router } from "express";
import { CodexApiKeyController } from "../../controllers/admin/codexApiKey.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new CodexApiKeyController();

// Same gate as the Claude OAuth token: this is a system-wide credential
// used by the agent_service container's Codex CLI (OPENAI_API_KEY).
router.use(requireSuperAdmin);

router.get("/", controller.get);
router.put("/", controller.set);
router.delete("/", controller.remove);

export { router as codexApiKeyRouter };
