/**
 * Evaluate the shared Actions run-time requirement against completed run metadata.
 * The input uses the run_started_at and updated_at fields returned for a completed run.
 * No clock or workflow process is started here; actual elapsed time comes from Actions readback.
 */
export const REPOSITORY_WORKFLOW_DURATION_LIMIT_MS = 60_000;

export function evaluateWorkflowRunDuration(run) {
  if (run?.status !== "completed") {
    return { measured: false, accepted: false, durationMs: null, reason: "workflow run is not completed" };
  }

  const startedAt = Date.parse(run.run_started_at);
  const updatedAt = Date.parse(run.updated_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(updatedAt) || updatedAt < startedAt) {
    return { measured: false, accepted: false, durationMs: null, reason: "workflow run timestamps are invalid" };
  }

  const durationMs = updatedAt - startedAt;
  return {
    measured: true,
    accepted: durationMs < REPOSITORY_WORKFLOW_DURATION_LIMIT_MS,
    durationMs,
    reason: durationMs < REPOSITORY_WORKFLOW_DURATION_LIMIT_MS ? null : "workflow run reached the duration limit",
  };
}
