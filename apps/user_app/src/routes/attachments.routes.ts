import { Router } from "express";
import { AttachmentsController } from "../controllers/attachments.controller";

const router = Router();
const controller = new AttachmentsController();

// No authMiddleware: this endpoint is reached by a plain <a href> click, which
// cannot attach an Authorization header. The signed + expiring query string
// (HMAC over {agentId, file, exp} with ATTACHMENT_SIGNING_SECRET) is the
// capability — it is only ever produced by the `send_file_to_user` tool and
// only ever delivered inside the target conversation's reply payload.
router.get("/", controller.download);

export { router as attachmentsRouter };
