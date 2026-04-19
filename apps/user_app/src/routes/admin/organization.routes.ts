import { Router } from "express";
import { OrganizationController } from "../../controllers/admin/organization.controller";

const router = Router();
const controller = new OrganizationController();

router.get("/", controller.get);
router.patch("/summary", controller.setSummary);

export { router as organizationRouter };
