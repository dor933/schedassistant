import type { Request, Response } from "express";
import { LibraryService } from "../../services/admin/library.service";
import { logger } from "../../logger";

export class LibraryController {
  private service = new LibraryService();

  list = async (_req: Request, res: Response) => {
    try {
      const files = await this.service.list();
      return res.json({ files });
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /admin/library error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  upload = async (req: Request, res: Response) => {
    const file = (req as any).file as
      | { originalname: string; buffer: Buffer; mimetype?: string }
      | undefined;
    if (!file) {
      return res.status(400).json({ error: "No file uploaded." });
    }
    try {
      const saved = await this.service.upload(
        file.originalname,
        file.buffer,
        file.mimetype,
      );
      return res.status(201).json(saved);
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("POST /admin/library error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  delete = async (req: Request, res: Response) => {
    try {
      await this.service.delete(String(req.params.fileName));
      return res.json({ deleted: true });
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("DELETE /admin/library/:fileName error:", err);
      return res.status(500).json({ error: err.message });
    }
  };

  download = async (req: Request, res: Response) => {
    try {
      const upstream = await this.service.openDownload(String(req.params.fileName));
      // Forward the upstream binary response unchanged. Preserving
      // Content-Disposition is what makes the browser save with the original
      // file name; Content-Type and Content-Length keep size/mime intact.
      const passthrough = ["content-type", "content-length", "content-disposition"];
      for (const h of passthrough) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      if (!upstream.body) {
        return res.status(502).json({ error: "Empty response from agent_service." });
      }
      const reader = upstream.body.getReader();
      res.status(upstream.status);
      // Pump the readable stream into the express response.
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(value);
      }
      return res.end();
    } catch (err: any) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      logger.error("GET /admin/library/:fileName/download error:", err);
      return res.status(500).json({ error: err.message });
    }
  };
}
