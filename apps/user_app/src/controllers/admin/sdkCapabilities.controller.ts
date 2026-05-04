import { Request, Response } from "express";
import { SdkCapability } from "@scheduling-agent/database";
import { logger } from "../../logger";

/**
 * Admin endpoint for the `sdk_capabilities` enum table (introduced by
 * migration 145). Currently 2 rows: `filesystem` and `bash`. Returned
 * in slug-alphabetical order so the UI can render a stable checkbox list
 * next to the MCP-servers picker.
 *
 * Read-only — the rows are seeded by migration; admins can only attach /
 * detach them per agent via the agents endpoints.
 */
export class SdkCapabilitiesController {
  getAll = async (_req: Request, res: Response) => {
    try {
      const rows = await SdkCapability.findAll({
        attributes: ["id", "slug", "name", "description"],
        order: [["slug", "ASC"]],
      });
      return res.json(
        rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          description: r.description ?? null,
        })),
      );
    } catch (err: any) {
      logger.error("GET /sdk-capabilities error", { error: err?.message ?? String(err) });
      return res.status(500).json({ error: err?.message ?? "Internal server error." });
    }
  };
}
