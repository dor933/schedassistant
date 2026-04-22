import { Router } from "express";
import { AttachmentsController } from "../controllers/attachments.controller";

const router = Router();
const controller = new AttachmentsController();

router.get("/", controller.download);

export { router as attachmentsRouter };
