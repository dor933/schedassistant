import { Router } from "express";
import { AskGrahamyController } from "../controllers/askGrahamy.controller";
import { requireApplicationToken } from "../middleware/requireApplicationToken";

const router = Router();
const controller = new AskGrahamyController();

router.use(requireApplicationToken);
router.post("/classify", controller.classify);
router.post("/", controller.ask);

export { router as askGrahamyRouter };
