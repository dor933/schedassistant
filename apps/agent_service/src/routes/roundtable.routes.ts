import { Router, type Request, type Response } from "express";
import { roundtableQueue } from "../queues/roundtable.bull";
import { Roundtable } from "@scheduling-agent/database";
import { logger } from "../logger";
import { getRoundtableGraph } from "../deps";
import { submitRoundtableUserTurn } from "../worker/roundtable.worker";

const router = Router();

/**
 * POST /api/roundtable/start
 * Enqueues the first roundtable_turn job. Called by user_app after creating the roundtable.
 */
router.post("/start", async (req: Request, res: Response) => {
  try {
    const { roundtableId, agentId, userId } = req.body;

    if (!roundtableId || !agentId || !userId) {
      return res.status(400).json({ error: "Missing roundtableId, agentId, or userId" });
    }

    await roundtableQueue.add("roundtable_turn", {
      roundtableId,
      agentId,
      roundNumber: 0,
      userId,
    });

    logger.info("Roundtable start: first turn enqueued", { roundtableId, agentId });
    return res.json({ ok: true, roundtableId });
  } catch (err: any) {
    logger.error("Roundtable start failed", { error: err?.message });
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

/**
 * POST /api/roundtable/stop
 * Stops a running roundtable early.
 */
router.post("/stop", async (req: Request, res: Response) => {
  try {
    const { roundtableId } = req.body;
    if (!roundtableId) {
      return res.status(400).json({ error: "Missing roundtableId" });
    }

    const [updated] = await Roundtable.update(
      { status: "completed" },
      { where: { id: roundtableId, status: "running" } },
    );

    if (updated === 0) {
      return res.status(404).json({ error: "Roundtable not found or not running" });
    }

    logger.info("Roundtable stopped", { roundtableId });
    return res.json({ ok: true });
  } catch (err: any) {
    logger.error("Roundtable stop failed", { error: err?.message });
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

/**
 * POST /api/roundtable/user-turn
 * Called by user_app when the human participant submits their contribution.
 * Saves the message, injects it into the LangGraph thread so subsequent agents
 * see it, emits a socket event, then enqueues the next round (or finalizes).
 */
router.post("/user-turn", async (req: Request, res: Response) => {
  try {
    const { roundtableId, userId, content } = req.body ?? {};
    if (!roundtableId || typeof userId !== "number") {
      return res
        .status(400)
        .json({ error: "Missing roundtableId or userId" });
    }

    const graph = getRoundtableGraph();
    const result = await submitRoundtableUserTurn(graph, {
      roundtableId,
      userId,
      content: typeof content === "string" ? content : "",
    });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    return res.json({ ok: true });
  } catch (err: any) {
    logger.error("Roundtable user-turn failed", { error: err?.message });
    return res.status(500).json({ error: err?.message ?? "Internal error" });
  }
});

export { router as roundtableRouter };
