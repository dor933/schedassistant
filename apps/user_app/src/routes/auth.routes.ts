import { Router } from "express";
import { AuthController } from "../controllers/auth.controller";
import { authMiddleware } from "../middlewares/auth";

const router = Router();
const authController = new AuthController();

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/google", authController.googleLogin);
router.post("/google-bootstrap", authController.googleBootstrap);
router.post("/google-verify-domain", authController.googleVerifyDomain);
router.get("/public-models", authController.publicModels);
router.get("/me", authMiddleware, authController.me);

export { router as authRouter };
