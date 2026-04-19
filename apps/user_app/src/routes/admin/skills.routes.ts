import { Router } from "express";
import { SkillsController } from "../../controllers/admin/skills.controller";

const router = Router();
const controller = new SkillsController();

// Skills are a platform-wide catalog (no `organizationId`). Since `super_admin`
// is now tenant-scoped, mutations happen out-of-band via direct DB access —
// see the mcpServers pattern for rationale.
router.get("/", controller.getAll);

export { router as skillsRouter };
