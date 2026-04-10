/**
 * Returns true when a BullMQ requestId indicates the job is a system-triggered
 * epic execution (continuation, delegation, PR retry, completion) rather than
 * a regular user-initiated message to the epic orchestrator.
 */
export function isEpicExecutionRequest(requestId?: string | null): boolean {
  if (!requestId) return false;
  return (
    requestId.startsWith("epic-continuation-") ||
    requestId.startsWith("epic-delegation-") ||
    requestId.startsWith("epic-completed-")
  );
}
