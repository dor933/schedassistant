import { Router } from "express";
import multer from "multer";
import { LibraryController } from "../../controllers/admin/library.controller";

const router = Router();
const controller = new LibraryController();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.get("/", controller.list);
router.post("/", upload.single("file"), controller.upload);
router.delete("/:fileName", controller.delete);

export { router as libraryRouter };
