import { Router } from "express";
import { SkillsController } from "../../controllers/admin/skills.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new SkillsController();

router.get("/", controller.getAll);
router.post("/", requireSuperAdmin, controller.create);
router.patch("/:id", requireSuperAdmin, controller.update);
router.delete("/:id", requireSuperAdmin, controller.remove);

export { router as skillsRouter };
