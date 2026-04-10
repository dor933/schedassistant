import { Router } from "express";
import { ProjectsController } from "../../controllers/admin/projects.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new ProjectsController();

router.get("/", controller.getAll);
router.get("/remote-branches", controller.getRemoteBranches);
router.post("/setup", requireSuperAdmin, controller.setupProject);

router.patch("/:id", requireSuperAdmin, controller.update);
router.delete("/:id", requireSuperAdmin, controller.remove);
router.post("/:id/repositories", requireSuperAdmin, controller.addRepository);

router.patch("/repositories/:repoId", requireSuperAdmin, controller.updateRepository);
router.delete("/repositories/:repoId", requireSuperAdmin, controller.deleteRepository);
router.post("/repositories/:repoId/clone", requireSuperAdmin, controller.cloneRepository);
router.get("/repositories/:repoId/branches", controller.getBranches);
router.patch("/repositories/:repoId/branch", requireSuperAdmin, controller.setBranch);
router.post("/repositories/:repoId/generate-architecture", requireSuperAdmin, controller.generateArchitecture);

export { router as projectsRouter };
