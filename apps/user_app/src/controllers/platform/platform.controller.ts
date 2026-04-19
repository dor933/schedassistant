import { Request, Response } from "express";
import { PlatformAuthService } from "../../services/platform/platformAuth.service";
import { PlatformCatalogService } from "../../services/platform/platformCatalog.service";
import { logger } from "../../logger";

function handleError(res: Response, err: any, scope: string) {
  if (err?.status) return res.status(err.status).json({ error: err.message });
  logger.error(`Platform ${scope} error`, { error: err?.message });
  return res.status(500).json({ error: "Internal server error." });
}

export class PlatformController {
  private authService = new PlatformAuthService();
  private catalog = new PlatformCatalogService();

  // ── Auth ───────────────────────────────────────────────────────────────

  login = async (req: Request, res: Response) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "email and password are required." });
    }
    try {
      const result = await this.authService.login(email, password);
      return res.json(result);
    } catch (err: any) {
      return handleError(res, err, "login");
    }
  };

  me = async (req: Request, res: Response) => {
    try {
      const result = await this.authService.getMe(req.platformAdmin!.platformAdminId);
      return res.json(result);
    } catch (err: any) {
      return handleError(res, err, "me");
    }
  };

  // ── MCP servers ────────────────────────────────────────────────────────

  listMcpServers = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.catalog.listMcpServers());
    } catch (err: any) {
      return handleError(res, err, "GET /mcp-servers");
    }
  };

  createMcpServer = async (req: Request, res: Response) => {
    try {
      const server = await this.catalog.createMcpServer(req.body ?? {});
      return res.status(201).json(server);
    } catch (err: any) {
      return handleError(res, err, "POST /mcp-servers");
    }
  };

  updateMcpServer = async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid server id." });
    }
    try {
      const result = await this.catalog.updateMcpServer(id, req.body ?? {});
      return res.json(result);
    } catch (err: any) {
      return handleError(res, err, "PATCH /mcp-servers/:id");
    }
  };

  deleteMcpServer = async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: "Invalid server id." });
    }
    try {
      return res.json(await this.catalog.deleteMcpServer(id));
    } catch (err: any) {
      return handleError(res, err, "DELETE /mcp-servers/:id");
    }
  };

  // ── Skills ─────────────────────────────────────────────────────────────

  listSkills = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.catalog.listSkills());
    } catch (err: any) {
      return handleError(res, err, "GET /skills");
    }
  };

  createSkill = async (req: Request, res: Response) => {
    try {
      const skill = await this.catalog.createSkill(req.body ?? {});
      return res.status(201).json(skill);
    } catch (err: any) {
      return handleError(res, err, "POST /skills");
    }
  };

  updateSkill = async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id." });
    try {
      const skill = await this.catalog.updateSkill(id, req.body ?? {});
      return res.json(skill);
    } catch (err: any) {
      return handleError(res, err, "PATCH /skills/:id");
    }
  };

  deleteSkill = async (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id." });
    try {
      return res.json(await this.catalog.deleteSkill(id));
    } catch (err: any) {
      return handleError(res, err, "DELETE /skills/:id");
    }
  };

  // ── Models + vendors ───────────────────────────────────────────────────

  listModels = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.catalog.listModels());
    } catch (err: any) {
      return handleError(res, err, "GET /models");
    }
  };

  listVendors = async (_req: Request, res: Response) => {
    try {
      return res.json(await this.catalog.listVendors());
    } catch (err: any) {
      return handleError(res, err, "GET /vendors");
    }
  };

  createModel = async (req: Request, res: Response) => {
    try {
      const result = await this.catalog.createModel(req.body ?? {});
      return res.status(201).json(result);
    } catch (err: any) {
      return handleError(res, err, "POST /models");
    }
  };

  deleteModel = async (req: Request, res: Response) => {
    try {
      return res.json(await this.catalog.deleteModel(req.params.id as string));
    } catch (err: any) {
      return handleError(res, err, "DELETE /models/:id");
    }
  };

  setVendorApiKey = async (req: Request, res: Response) => {
    const { apiKey } = req.body ?? {};
    if (apiKey !== undefined && typeof apiKey !== "string") {
      return res.status(400).json({ error: "apiKey must be a string." });
    }
    try {
      const result = await this.catalog.setVendorApiKey(req.params.id as string, apiKey);
      return res.json(result);
    } catch (err: any) {
      return handleError(res, err, "PATCH /vendors/:id/api-key");
    }
  };
}
