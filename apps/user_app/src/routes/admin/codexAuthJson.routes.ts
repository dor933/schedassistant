import { Router } from "express";
import { CodexAuthJsonController } from "../../controllers/admin/codexAuthJson.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new CodexAuthJsonController();

// System-wide credential (multi-secret JSON blob — id_token, access_token,
// refresh_token, account_id). Same gate as the API key.
router.use(requireSuperAdmin);

router.get("/", controller.get);
router.put("/", controller.set);
router.delete("/", controller.remove);

export { router as codexAuthJsonRouter };
