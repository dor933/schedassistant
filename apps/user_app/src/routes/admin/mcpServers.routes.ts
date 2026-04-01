import { Router } from "express";
import { McpServersController } from "../../controllers/admin/mcpServers.controller";

const router = Router();
const controller = new McpServersController();

router.get("/", controller.getAll);
router.post("/", controller.create);

export { router as mcpServersRouter };
