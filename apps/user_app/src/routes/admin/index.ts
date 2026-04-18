import { Router } from "express";
import { authMiddleware } from "../../middlewares/auth";
import { requireAdmin } from "../../middlewares/requireAdmin";
import { rolesRouter } from "./roles.routes";
import { usersRouter } from "./users.routes";
import { agentsRouter } from "./agents.routes";
import { groupsRouter } from "./groups.routes";
import { modelsRouter } from "./models.routes";
import { mcpServersRouter } from "./mcpServers.routes";
import { skillsRouter } from "./skills.routes";
import { projectsRouter } from "./projects.routes";
import { roundtableRouter } from "./roundtable.routes";
import { toolsRouter } from "./tools.routes";
import { cronJobsRouter } from "./cronJobs.routes";
import { webSearchAgentRouter } from "./webSearchAgent.routes";

const router = Router();

// All admin routes require auth + admin/super_admin role
router.use(authMiddleware, requireAdmin);

router.use("/roles", rolesRouter);
router.use("/users", usersRouter);
router.use("/agents", agentsRouter);
router.use("/groups", groupsRouter);
router.use("/mcp-servers", mcpServersRouter);
router.use("/skills", skillsRouter);
router.use("/projects", projectsRouter);
router.use("/roundtables", roundtableRouter);
router.use("/tools", toolsRouter);
router.use("/cron-jobs", cronJobsRouter);
router.use("/web-search-agent", webSearchAgentRouter);
// models router handles /models, /vendors, and /single-chats paths
router.use("/", modelsRouter);

export { router as adminRouter };
