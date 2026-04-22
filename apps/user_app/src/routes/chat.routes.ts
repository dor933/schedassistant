import { Router } from "express";
import multer from "multer";
import { ChatController } from "../controllers/chat.controller";
import { authMiddleware } from "../middlewares/auth";

const router = Router();
const chatController = new ChatController();

/**
 * The upload limit is mirrored on the client (2 MB, .md/.txt only) — multer
 * enforces it at the boundary regardless, so a malformed client can't waste
 * the agent's workspace or overwhelm Redis-backed job payloads.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

// `upload.single("file")` accepts multipart/form-data but also allows plain
// JSON bodies (multer is a no-op when no multipart boundary is present), so
// the existing JSON-only chat path keeps working unchanged.
router.post("/", authMiddleware, upload.single("file"), chatController.send);

export { router as chatRouter };
