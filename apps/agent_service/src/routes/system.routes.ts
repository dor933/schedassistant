import { Router } from "express";
import { SystemController } from "../controllers/system.controller";

const router = Router();
const controller = new SystemController();

// Container-level system settings. The user_app proxies here from the admin
// UI; access control happens in user_app (`requireSuperAdmin`).
router.get("/claude-oauth-token", controller.getClaudeOauthToken);
router.put("/claude-oauth-token", controller.setClaudeOauthToken);
router.delete("/claude-oauth-token", controller.deleteClaudeOauthToken);
router.post("/claude-oauth-token/probe", controller.probeClaudeOauthToken);

export { router as systemRouter };
