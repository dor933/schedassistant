import { Request, Response } from "express";
import {
  googleBootstrapSchema,
  googleLoginSchema,
  googleVerifyDomainSchema,
  loginSchema,
  registerOrganizationSchema,
} from "@scheduling-agent/types";
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

  /**
   * Pre-registration Google sign-in for the onboarding wizard. No tenant
   * exists yet, so we verify the token against env-level client ids and
   * return a short-lived ticket the wizard carries until it calls
   * `/auth/register`. The ticket is rejected if any org already uses this
   * Workspace domain — only one tenant per domain.
   */
  googleBootstrap = async (req: Request, res: Response) => {
    const parsed = googleBootstrapSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
      return res.status(400).json({ error: firstError });
    }

    try {
      const result = await this.authService.bootstrapGoogleIdentity(
        parsed.data.idToken,
      );
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("Google bootstrap error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  /**
   * DNS-TXT domain ownership verification for the onboarding wizard. The
   * wizard posts the unverified bootstrap ticket; the server re-derives the
   * expected TXT token, runs a live lookup on the admin's `hd` domain, and
   * mints a new ticket with `verifiedDomain: true` on match.
   */
  googleVerifyDomain = async (req: Request, res: Response) => {
    const parsed = googleVerifyDomainSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
      return res.status(400).json({ error: firstError });
    }

    try {
      const result = await this.authService.verifyGoogleDomain(parsed.data.ticket);
      return res.json(result);
    } catch (err: any) {
      if (err.status) {
        // Preserve structured hints (expected TXT value, hd) so the UI can
        // re-display them without re-calling /auth/google-bootstrap.
        const body: Record<string, unknown> = { error: err.message };
        if (err.details) body.details = err.details;
        return res.status(err.status).json(body);
      }
      logger.error("Google verify-domain error", { error: err?.message });
      return res.status(500).json({ error: "Internal server error." });
    }
  };

  /**
   * Google Workspace SSO with JIT provisioning. The client posts the id token
   * received from Google Identity Services; the server verifies it, matches
   * the tenant by workspace domain, and creates the user on first sign-in.
   */
  googleLogin = async (req: Request, res: Response) => {
    const parsed = googleLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      const firstError = parsed.error.errors[0]?.message ?? "Invalid input.";
      return res.status(400).json({ error: firstError });
    }

    try {
      const result = await this.authService.loginWithGoogle(parsed.data.idToken);
      return res.json(result);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("Google login error", { error: err?.message });
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
