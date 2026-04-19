import { Router } from "express";
import { PlatformController } from "../controllers/platform/platform.controller";
import { requirePlatformAdmin } from "../middlewares/platformAuth";

const router = Router();
const controller = new PlatformController();

// Unauthenticated — platform-admin login itself.
router.post("/auth/login", controller.login);

// Everything below requires a platform-admin JWT (disjoint from tenant JWTs).
router.use(requirePlatformAdmin);

router.get("/auth/me", controller.me);

// MCP servers
router.get("/mcp-servers", controller.listMcpServers);
router.post("/mcp-servers", controller.createMcpServer);
router.patch("/mcp-servers/:id", controller.updateMcpServer);
router.delete("/mcp-servers/:id", controller.deleteMcpServer);

// Skills
router.get("/skills", controller.listSkills);
router.post("/skills", controller.createSkill);
router.patch("/skills/:id", controller.updateSkill);
router.delete("/skills/:id", controller.deleteSkill);

// Models + vendor API keys
router.get("/models", controller.listModels);
router.post("/models", controller.createModel);
router.delete("/models/:id", controller.deleteModel);
router.get("/vendors", controller.listVendors);
router.patch("/vendors/:id/api-key", controller.setVendorApiKey);

export { router as platformRouter };
