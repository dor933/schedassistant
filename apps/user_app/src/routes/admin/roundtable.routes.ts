import { Router } from "express";
import { RoundtableController } from "../../controllers/admin/roundtable.controller";

const router = Router();
const controller = new RoundtableController();

router.get("/", controller.getAll);
router.get("/:id", controller.getById);
router.post("/", controller.create);
router.post("/:id/stop", controller.stop);

export { router as roundtableRouter };
