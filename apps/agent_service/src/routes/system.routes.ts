import { Router } from "express";
import { SystemController } from "../controllers/system.controller";

const router = Router();
const controller = new SystemController();

// Container-level system settings. The user_app proxies here from the admin
// UI; access control happens in user_app (`requireSuperAdmin`).
router.get("/claude-oauth-token", controller.getClaudeOauthToken);
router.put("/claude-oauth-token", controller.setClaudeOauthToken);
router.delete("/claude-oauth-token", controller.deleteClaudeOauthToken);

router.get("/codex-api-key", controller.getCodexApiKey);
router.put("/codex-api-key", controller.setCodexApiKey);
router.delete("/codex-api-key", controller.deleteCodexApiKey);

router.get("/codex-auth-json", controller.getCodexAuthJson);
router.put("/codex-auth-json", controller.setCodexAuthJson);
router.delete("/codex-auth-json", controller.deleteCodexAuthJson);

router.post("/codex-config-toml/render", controller.renderCodexConfigToml);
router.post("/claude-mcp-config/render", controller.renderClaudeMcpConfig);
router.put("/codex-mcp-scripts/:id", controller.persistCodexMcpScript);
router.delete("/codex-mcp-scripts/:id", controller.deleteCodexMcpScript);

export { router as systemRouter };
