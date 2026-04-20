import type { Request, Response } from "express";
import {
  LibraryServiceError,
  deleteLibraryFile,
  listLibraryFiles,
  readLibraryFile,
  saveLibraryFile,
} from "../services/library.service";
import { logger } from "../logger";

function handleError(res: Response, err: unknown, logContext: string): Response {
  if (err instanceof LibraryServiceError) {
    return res.status(err.status).json({ error: err.message });
  }
  const message = (err as any)?.message ?? "Internal error";
  logger.error(logContext, { error: message });
  return res.status(500).json({ error: message });
}

export class LibraryController {
  list = async (_req: Request, res: Response) => {
    try {
      const files = listLibraryFiles();
      return res.json({ files });
    } catch (err) {
      return handleError(res, err, "GET /library error");
    }
  };

  upload = async (req: Request, res: Response) => {
    try {
      const file = (req as any).file as
        | { originalname: string; buffer: Buffer }
        | undefined;
      if (!file) {
        return res.status(400).json({ error: "No file uploaded." });
      }
      const saved = saveLibraryFile(file.originalname, file.buffer);
      return res.status(201).json(saved);
    } catch (err) {
      return handleError(res, err, "POST /library error");
    }
  };

  read = async (req: Request, res: Response) => {
    try {
      const result = readLibraryFile(String(req.params.fileName));
      return res.json(result);
    } catch (err) {
      return handleError(res, err, "GET /library/:fileName error");
    }
  };

  delete = async (req: Request, res: Response) => {
    try {
      deleteLibraryFile(String(req.params.fileName));
      return res.json({ deleted: true });
    } catch (err) {
      return handleError(res, err, "DELETE /library/:fileName error");
    }
  };
}
