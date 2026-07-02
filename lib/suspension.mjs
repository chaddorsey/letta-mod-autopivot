/**
 * AutoPivot — suspension lifecycle helpers (pure).
 *
 * These are the decision functions behind the stall-suspension lifecycle that index.mjs
 * wires to live timers/events (Phase 3a). Kept pure and separate so the tricky bits —
 * mapping a failure back to a rung, the recovery backoff curve, and the never-strand
 * guard — are unit-tested without a live host.
 *
 * Recovery is CLASS-BLIND by necessity (a mod can't read the error type or a reset
 * clock — probe-verified) and, crucially, UN-CONFIRMABLE: a reachability probe stays
 * green for the very failures we target (rate-limit / no-credit / auth), so we can't
 * trust it to certify a stalled rung. So a stall suspension is STICKY — the rung stays
 * out until the user runs `/pivot online` or a later completion on it succeeds. There is
 * deliberately no auto-retry timer: an unconfirmed timer-recovery bounces straight back
 * onto a still-broken rung (observed in smoke). See the plan's "Key Technical Decisions".
 */

/**
 * Map the model that actually ran (from `llm_start`) back to its rung index.
 * Returns the index, or null when no rung matches — the caller treats null as
 * "don't suspend" (the turn was mid-switch or on a model outside the ladder), which
 * avoids suspending the wrong rung under the N+1 switch lag.
 */
export function modelToRungIndex(rungs, model) {
  if (!model || !Array.isArray(rungs)) return null;
  const rung = rungs.find((r) => r.model === model);
  return rung ? rung.index : null;
}

/**
 * Never-strand guard: may we suspend rung `index` without leaving the ladder with zero
 * unsuspended rungs? Returns false when `index` is the last rung not already suspended —
 * the caller then keeps it eligible and surfaces an "all rungs failing" prompt instead of
 * blindly resending into a fully-suspended ladder.
 *
 * (This guards only against the suspension set covering every rung; probe-driven
 * emptiness is handled separately by resolveLadder's `none-reachable` result.)
 */
export function canSuspend(rungCount, suspended, index) {
  const next = new Set(suspended);
  next.add(index);
  return next.size < rungCount; // at least one rung remains unsuspended
}
