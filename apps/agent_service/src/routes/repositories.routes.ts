import { Router } from "express";
import { RepositoriesController } from "../controllers/repositories.controller";

const router = Router();
const repositoriesController = new RepositoriesController();

// ─── Remote branches (no clone needed) ──────────────────────────────────────
router.get("/remote-branches", repositoriesController.getRemoteBranches);

// ─── Unified setup & add-repo flows ─────────────────────────────────────────
router.post("/setup-project", repositoriesController.setupProject);
router.post("/add-repo", repositoriesController.addRepo);

// ─── Individual repo operations (used for editing existing projects) ───────
router.post("/:repoId/clone", repositoriesController.cloneRepo);
router.get("/:repoId/branches", repositoriesController.listBranches);
router.patch("/:repoId/branch", repositoriesController.setBranch);
router.post("/:repoId/generate-architecture", repositoriesController.generateArchitecture);
router.delete("/:repoId/local", repositoriesController.deleteLocal);

export { router as repositoriesRouter };
