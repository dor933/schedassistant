import { Router } from "express";
import { VendorApiKeysController } from "../../controllers/admin/vendorApiKeys.controller";
import { requireSuperAdmin } from "../../middlewares/requireSuperAdmin";

const router = Router();
const controller = new VendorApiKeysController();

// Only the org's super admin handles vendor credentials. Regular admins can
// see the vendor catalog via /admin/vendors but cannot view or edit keys.
router.use(requireSuperAdmin);

router.get("/", controller.list);
router.put("/:vendorId", controller.set);
router.delete("/:vendorId", controller.remove);

export { router as vendorApiKeysRouter };
