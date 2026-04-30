import { Router } from "express";
import { McpServersController } from "../../controllers/admin/mcpServers.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new McpServersController();

router.get("/", controller.getAll);
router.post("/", requireSuperAdmin, controller.create);
router.patch("/:id", requireSuperAdmin, controller.update);
router.delete("/:id", requireSuperAdmin, controller.remove);
router.post("/:id/install", requireSuperAdmin, controller.install);

export { router as mcpServersRouter };
