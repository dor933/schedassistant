import { Router } from "express";
import { UsersController } from "../../controllers/admin/users.controller";

const router = Router();
const usersController = new UsersController();

router.get("/", usersController.getAll);
router.post("/", usersController.create);
router.patch("/:id", usersController.update);

export { router as usersRouter };
