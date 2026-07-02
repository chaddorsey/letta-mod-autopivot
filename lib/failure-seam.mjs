/**
 * AutoPivot — failure seam.
 *
 * A tiny synchronous "failure bus" that decouples any failure *producer* from the
 * suspension *consumer*. `report(rungId, reason)` fans out to every `onFailure`
 * subscriber; that's the whole contract.
 *
 * ── Why this is its own module (the honest framing) ──────────────────────────
 * Today there is one consumer (the suspension lifecycle in index.mjs) and the
 * producers are our own stall watchdog (`lib/failure-watch.mjs`) plus an
 * opportunistic `llm_end stopReason:"error"` fast-path. A plain callback would be
 * functionally equivalent RIGHT NOW.
 *
 * We keep the seam deliberately, as a SHOWCASE for the Letta mod competition:
 * AutoPivot's existence maps a real gap in the mod API. In letta-code 0.27.18 there
 * is NO first-class error/`provider_error` event — the only in-band failure signal
 * is an unmatched `llm_start` (probe-verified). This seam is the labeled socket that
 * signal plugs into, and it is exactly where a future `provider_error` event would
 * plug in too — with ZERO change to the consumer:
 *
 *     // stall watchdog (today):
 *     seam.report(model, "stall")
 *     // llm_end stopReason:"error" fast-path (today, smoke-gated):
 *     seam.report(model, "error")
 *     // provider_error (when Letta ships it):
 *     seam.report(model, { type: "rate_limit", resetsAt })   // ← same socket
 *
 * `reason` is intentionally opaque (a string today, a rich object tomorrow) so the
 * richer future signal needs no consumer rework. That is the point of the seam: it
 * documents the mod-API gap and shows precisely where the fix lands.
 */
export function makeFailureSeam() {
  const subs = new Set();
  return {
    /** Report that `rungId` failed. `reason` is opaque (string today, object later). */
    report(rungId, reason) {
      const failure = { rungId, reason };
      for (const fn of subs) {
        try { fn(failure); } catch { /* isolate — a bad subscriber must not break producers */ }
      }
    },
    /** Subscribe to failures. Returns an unsubscribe fn. */
    onFailure(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}
