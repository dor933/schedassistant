/**
 * Loopback routes consumed by the Codex stdio bridge
 * (`chat/codex/stdioToolsBridge.ts`), spawned per-turn as a Node
 * subprocess inside this same container. The bridge forwards Codex's
 * MCP `tools/list` / `tools/call` here so they land back on the live
 * in-process `toolRegistry` with closures intact.
 *
 * Mounted at `/internal/*` (NOT `/api/internal`) so it's distinct from
 * every browser-reachable surface and easy to firewall at the
 * load-balancer / ingress layer if we ever expose `/api` publicly.
 * The user_app proxy never forwards anything under `/internal`.
 *
 * Auth: per-turn JWT in `Authorization: Bearer …` header. See
 * `codexBridgeAuth.ts` and `internalTools.controller.ts`.
 */

import { Router } from "express";
import { InternalToolsController } from "../controllers/internalTools.controller";

const router = Router();
const controller = new InternalToolsController();

router.post("/tools/list", controller.list);
router.post("/tools/call", controller.call);

export { router as internalRouter };
