import { Router } from "express";
import { PersonsController } from "../../controllers/admin/persons.controller";

const router = Router();
const personsController = new PersonsController();

router.post("/", personsController.create);

export { router as personsRouter };
