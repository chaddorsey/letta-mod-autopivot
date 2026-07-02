/**
 * AutoPivot — llm_end classification (pure, testable).
 *
 * letta-code 0.27.20 (PR #3164, "feat(mods): emit llm_end for provider errors") made
 * `llm_end` fire on FAILURE as well as success, carrying a structured error:
 *
 *     error?: { message, detail, errorType: "llm_error" | "local_backend_error", retryable }
 *     usage:  ModLlmUsage | null   // null on a failed request
 *
 * This is exactly the signal the failure seam was built to receive. When it's present we
 * fail over IMMEDIATELY — no need to wait out the stall watchdog's timeout. It also lets
 * us tell the user *why* (error type + message) and note whether the provider considered
 * it retryable.
 *
 * Graceful degradation: on 0.27.18/0.27.19 `event.error` is undefined and a failed
 * request emits no `llm_end` at all (probe-verified) — so the stall watchdog stays the
 * detector there, and this classifier simply treats a benign `llm_end` as success.
 *
 * NOTE (honest scope): the error carries no reset timestamp, so timer-based recovery
 * ("wait until the rate limit resets") is still not possible even on 0.27.20. Recovery
 * stays sticky (see index.mjs). `retryable` is surfaced but recovery remains user-driven.
 */

// stopReasons that denote a failed/aborted completion even without a structured error
// (older builds, or a user-aborted turn).
const FAILING_STOP_REASONS = new Set(["error", "aborted"]);

/**
 * Decide whether an `llm_end` event represents a failure, and produce the opaque
 * `reason` to hand the failure seam (string for the legacy path, rich object for 0.27.20+).
 *
 * @param {object} event - the llm_end event
 * @returns {{ failed: boolean, reason: (string | {source:string,errorType:string,message:string,retryable:boolean}) | null }}
 */
export function classifyLlmEnd(event) {
  const err = event?.error;
  if (err && typeof err === "object") {
    return {
      failed: true,
      reason: {
        source: "llm_end",
        errorType: err.errorType === "local_backend_error" ? "local_backend_error" : "llm_error",
        message: String(err.message ?? err.detail ?? "provider error"),
        retryable: err.retryable === true,
      },
    };
  }
  // Legacy / abort fast-path: some builds surface a failure only via stopReason.
  if (FAILING_STOP_REASONS.has(event?.stopReason)) {
    return { failed: true, reason: "error" };
  }
  return { failed: false, reason: null };
}

/** Short human label for a classified reason — used in the pivot announcement. */
export function describeReason(reason) {
  if (reason && typeof reason === "object") {
    const kind = reason.errorType === "local_backend_error" ? "local backend error" : "provider error";
    return reason.message ? `${kind}: ${reason.message}` : kind;
  }
  if (reason === "stall") return "no response (timed out)";
  if (reason === "manual") return "manual pivot";
  return "error";
}
