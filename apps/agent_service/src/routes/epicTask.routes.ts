import { Router, Request, Response, NextFunction } from "express";
import { EpicTaskService } from "../services/epicTask.service";
import { logger } from "../logger";

const router = Router();
const service = new EpicTaskService();

// ─── Webhook shared-secret guard ────────────────────────────────────────────
//
// The GitHub Actions workflows in `.github/workflows/pr-*.yml` POST to the
// `/hooks/pr-*` endpoints below. They authenticate with a shared secret sent
// in the `X-Webhook-Secret` header. The same value must be set as the
// `EPIC_WEBHOOK_SECRET` env var on this service AND as a GitHub repo secret
// consumed by the workflows.
//
// If the secret is not configured on the server, all hook calls are rejected
// (fail-closed) — we never want these endpoints to be open.

function requireWebhookSecret(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.EPIC_WEBHOOK_SECRET;
  if (!expected) {
    logger.error("EPIC_WEBHOOK_SECRET is not configured — rejecting webhook call", {
      route: req.path,
    });
    return res.status(500).json({ error: "webhook secret not configured" });
  }
  const got = req.get("x-webhook-secret");
  if (!got || got !== expected) {
    logger.warn("Rejected webhook call with invalid or missing X-Webhook-Secret", {
      route: req.path,
      hasHeader: Boolean(got),
    });
    return res.status(401).json({ error: "unauthorized" });
  }
  return next();
}

// ─── PR Approval Webhook (called by GitHub Actions) ─────────────────────────

router.post("/hooks/pr-approved", requireWebhookSecret, async (req: Request, res: Response) => {
  try {
    const { repositoryId, prNumber } = req.body;
    if (!repositoryId || !prNumber) {
      return res.status(400).json({ error: "repositoryId and prNumber are required" });
    }
    const result = await service.handlePrApproval(repositoryId, prNumber);
    return res.json({
      stageId: result.stage.id,
      prStatus: "approved",
      readyTaskCount: result.readyTasks.length,
      readyTaskIds: result.readyTasks.map((t) => t.id),
      epicCompleted: result.epicCompleted,
    });
  } catch (err: any) {
    return res.status(404).json({ error: err.message });
  }
});

// ─── PR Changes Requested Webhook (called by GitHub Actions) ────────────────

router.post("/hooks/pr-changes-requested", requireWebhookSecret, async (req: Request, res: Response) => {
  try {
    const { repositoryId, prNumber, comments, reviewBody } = req.body;
    if (!repositoryId || !prNumber) {
      return res.status(400).json({ error: "repositoryId and prNumber are required" });
    }
    const result = await service.handlePrChangesRequested(
      repositoryId,
      prNumber,
      Array.isArray(comments) ? comments : [],
      typeof reviewBody === "string" ? reviewBody : null,
    );
    return res.json({
      stageId: result.stage.id,
      prStatus: "changes_requested",
      retryTaskIds: result.retryTaskIds,
    });
  } catch (err: any) {
    return res.status(404).json({ error: err.message });
  }
});

export { router as epicTaskRouter };
