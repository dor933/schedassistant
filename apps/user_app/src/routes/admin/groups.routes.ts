import { Router } from "express";
import { GroupsController } from "../../controllers/admin/groups.controller";

const router = Router();
const groupsController = new GroupsController();

router.get("/", groupsController.getAll);
router.post("/", groupsController.create);
router.patch("/:id", groupsController.rename);
router.delete("/:id", groupsController.remove);
router.get("/:groupId/members", groupsController.getMembers);
router.post("/:groupId/members", groupsController.addMember);
router.delete("/:groupId/members/:userId", groupsController.removeMember);

export { router as groupsRouter };
