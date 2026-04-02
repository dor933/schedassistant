import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rolesRouter } from "./roles.routes";
import { usersRouter } from "./users.routes";
import { agentsRouter } from "./agents.routes";
import { groupsRouter } from "./groups.routes";
import { modelsRouter } from "./models.routes";
import { mcpServersRouter } from "./mcpServers.routes";
import { systemAgentsRouter } from "./systemAgents.routes";

const router = Router();

// All admin routes require auth + admin/super_admin role
router.use(authMiddleware, requireAdmin);

router.use("/roles", rolesRouter);
router.use("/users", usersRouter);
router.use("/agents", agentsRouter);
router.use("/groups", groupsRouter);
router.use("/mcp-servers", mcpServersRouter);
router.use("/system-agents", systemAgentsRouter);
// models router handles /models, /vendors, and /single-chats paths
router.use("/", modelsRouter);

export { router as adminRouter };
