import type { Request, Response } from "express";
import { Readable } from "node:stream";
import { logger } from "../logger";

const AGENT_SERVICE_URL =
  process.env.AGENT_SERVICE_URL ?? "http://localhost:3001";

/**
 * Authenticated proxy for agent_service attachment downloads.
 *
 * The browser hits `/api/attachments?...` (auth-protected), we forward the
 * signed query to agent_service which verifies the HMAC and streams the file.
 * We pass through `Content-Type` / `Content-Disposition` / `Content-Length`
 * so the browser downloads with the original filename.
 */
export class AttachmentsController {
  download = async (req: Request, res: Response) => {
    const qs = new URLSearchParams();
    for (const key of ["a", "f", "e", "s"] as const) {
      const v = req.query[key];
      if (typeof v === "string") qs.set(key, v);
    }
    if (!qs.get("a") || !qs.get("f") || !qs.get("e") || !qs.get("s")) {
      return res.status(400).json({ error: "Missing attachment parameters." });
    }

    const url = `${AGENT_SERVICE_URL}/api/attachments?${qs.toString()}`;

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(url);
    } catch (err) {
      logger.error("Attachment proxy fetch failed", { error: String(err) });
      return res.status(502).json({ error: "Agent service unavailable." });
    }

    res.status(upstream.status);
    for (const header of [
      "content-type",
      "content-length",
      "content-disposition",
      "cache-control",
    ]) {
      const v = upstream.headers.get(header);
      if (v) res.setHeader(header, v);
    }

    if (!upstream.body) {
      return res.end();
    }

    const nodeStream = Readable.fromWeb(upstream.body as never);
    nodeStream.on("error", (err) => {
      logger.error("Attachment proxy stream error", { error: String(err) });
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    nodeStream.pipe(res);
    return;
  };
}
