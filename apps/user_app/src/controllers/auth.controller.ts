import { Request, Response } from "express";
import { loginSchema, registerOrganizationSchema } from "@scheduling-agent/types";
import { AuthService } from "../services/auth.service";
import { ModelsService } from "../services/admin/models.service";
import { logger } from "../logger";

export class AuthController {
  private authService = new AuthService();
  private modelsService = new ModelsService();

  register = async (req: Request, res: Response) => {
    const parsed = registerOrganizationSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
      return res.status(400).json({ error: firstError });
    }

    try {
      const result = await this.authService.registerOrganization(parsed.data);
      return res.status(201).json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("Register error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  login = async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
      return res.status(400).json({ error: firstError });
    }

    try {
      const result = await this.authService.login(parsed.data.userName, parsed.data.password);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("Login error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  /** Public model catalog for the onboarding wizard (no auth). */
  publicModels = async (_req: Request, res: Response) => {
    try {
      const models = await this.modelsService.getAllModels();
      return res.json(models);
    } catch (err: any) {
      logger.error("/auth/public-models error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  me = async (req: Request, res: Response) => {
    try {
      const result = await this.authService.getMe(req.user!.userId);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("/me error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };
}
