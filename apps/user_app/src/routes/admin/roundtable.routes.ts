import { Router } from "express";
import { RoundtableController } from "../../controllers/admin/roundtable.controller";

const router = Router();
const controller = new RoundtableController();

router.get("/", controller.getAll);
router.get("/:id", controller.getById);
router.post("/", controller.create);
router.post("/:id/stop", controller.stop);
router.post("/:id/resume", controller.resume);
router.post("/:id/user-turn", controller.submitUserTurn);

export { router as roundtableRouter };
