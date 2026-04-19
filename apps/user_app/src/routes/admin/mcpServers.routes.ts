import { Router } from "express";
import { McpServersController } from "../../controllers/admin/mcpServers.controller";

const router = Router();
const controller = new McpServersController();

// MCP server mutations are intentionally omitted — the registry is a
// platform-wide resource managed out-of-band via direct DB access.
// See `mcpServers.controller.ts` for rationale.
router.get("/", controller.getAll);

export { router as mcpServersRouter };
