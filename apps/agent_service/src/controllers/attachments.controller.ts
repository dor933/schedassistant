import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";
import { Agent } from "@scheduling-agent/database";
import { verifyAttachmentSignature } from "../tools/sendFileTool";
import { logger } from "../logger";

const ALLOWED_EXT = new Set([".md", ".txt"]);

const MIME_BY_EXT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export class AttachmentsController {
  download = async (req: Request, res: Response) => {
    const agentId = typeof req.query.a === "string" ? req.query.a : "";
    const fileName = typeof req.query.f === "string" ? req.query.f : "";
    const expRaw = typeof req.query.e === "string" ? req.query.e : "";
    const sig = typeof req.query.s === "string" ? req.query.s : "";

    if (!agentId || !fileName || !expRaw || !sig) {
      return res.status(400).json({ error: "Missing attachment parameters." });
    }

    const exp = Number.parseInt(expRaw, 10);
    if (!Number.isFinite(exp)) {
      return res.status(400).json({ error: "Invalid expiry." });
    }

    try {
      if (!verifyAttachmentSignature(agentId, fileName, exp, sig)) {
        return res
          .status(403)
          .json({ error: "Attachment signature invalid or expired." });
      }
    } catch (err) {
      logger.error("Attachment signature verify failed", {
        error: String(err),
      });
      return res.status(500).json({ error: "Signature verification failed." });
    }

    const safeName = path.basename(fileName);
    if (!safeName || safeName === "." || safeName === "..") {
      return res.status(400).json({ error: "Invalid file name." });
    }
    const ext = path.extname(safeName).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return res.status(400).json({ error: "Unsupported file type." });
    }

    const agent = await Agent.findByPk(agentId, {
      attributes: ["id", "workspacePath"],
    });
    const workspace = agent?.workspacePath;
    if (!workspace) {
      return res.status(404).json({ error: "Agent workspace not found." });
    }

    const full = path.resolve(workspace, safeName);
    if (!full.startsWith(workspace + path.sep) && full !== workspace) {
      return res.status(400).json({ error: "Invalid file path." });
    }
    if (!fs.existsSync(full)) {
      return res.status(404).json({ error: "File not found." });
    }

    const stat = fs.statSync(full);
    res.setHeader(
      "Content-Type",
      MIME_BY_EXT[ext] ?? "application/octet-stream",
    );
    res.setHeader("Content-Length", String(stat.size));
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(safeName)}"`,
    );
    res.setHeader("Cache-Control", "private, no-store");

    fs.createReadStream(full)
      .on("error", (err) => {
        logger.error("Attachment stream error", {
          agentId,
          fileName: safeName,
          error: String(err),
        });
        if (!res.headersSent) res.status(500).end();
        else res.end();
      })
      .pipe(res);
    return;
  };
}
