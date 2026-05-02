import { Router } from "express";
import { SystemController } from "../controllers/system.controller";

const router = Router();
const controller = new SystemController();

// Container-level system settings. The user_app proxies here from the admin
// UI; access control happens in user_app (`requireSuperAdmin`).
//
// The `claude-oauth-token` routes were removed: Anthropic auth now flows
// per-org via `organization_vendor_api_keys` (resolved by `resolveOrgVendor`
// + scrubbed/injected by SDK helpers). No deployment-level shared token
// survives.
//
// The `codex-api-key` routes were removed (slice 22 follow-up): the
// legacy `runCliExecution` engine that consumed `process.env.OPENAI_API_KEY`
// was deleted. Per-org credentials are pinned per-call by the SDK helpers,
// no host-level fallback is read by anything.

// `/codex-auth-json` system-wide routes were removed in slice 14.
// The Codex CLI auth.json is now stored per-org as `key_type='auth_object'`
// on the `organization_vendor_api_keys` row for the OpenAI vendor.
// `runOpenAiCodexSdk` materialises it to a per-turn temp $HOME at
// invocation time — no system-wide file, no shared admin endpoint.

router.post("/codex-config-toml/render", controller.renderCodexConfigToml);
router.post("/claude-mcp-config/render", controller.renderClaudeMcpConfig);
router.put("/codex-mcp-scripts/:id", controller.persistCodexMcpScript);
router.delete("/codex-mcp-scripts/:id", controller.deleteCodexMcpScript);

export { router as systemRouter };
