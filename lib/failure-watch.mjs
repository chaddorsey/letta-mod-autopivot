/**
 * AutoPivot — stall watchdog.
 *
 * The ONLY reliable in-band signal of a completion failure in letta-code 0.27.18 is an
 * unmatched `llm_start`: the failing turn fires `llm_start` then never fires `llm_end`
 * or `turn_end` (probe-verified 2026-07-01). This watchdog turns that observable into a
 * failover trigger: arm a timer on each request, and if it isn't settled within the
 * timeout, declare the rung that ran it failed.
 *
 * Two things the design got wrong in review, fixed here:
 *  - KEY BY CALL, NOT CONVERSATION. A single turn can fire MANY llm_start/llm_end pairs
 *    (tool-use loops). Keying by conversation lets an early settle cancel a later call's
 *    timer and silence a real stall. We key by a caller-supplied monotonic `callId`, so
 *    overlapping calls are independent.
 *  - REPORT THE ACTUALLY-RUNNING MODEL. `updateLlmConfig` takes effect N+1, so the mod's
 *    *desired* rung can differ from what actually ran. `markStart` records the model that
 *    actually fired (from `event.model`/`ctx.model.id`); `onStall` hands that back so the
 *    caller suspends the right rung.
 *
 * Pure + fully testable: all timing goes through injected `deps.{setTimer,clearTimer,now}`
 * (defaults to the host timers), so tests drive stalls synchronously.
 */
export function makeStallWatch({ timeoutMs = 90000, timeoutForModel, onStall, deps = {} } = {}) {
  const setTimer = deps.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); if (typeof t?.unref === "function") t.unref(); return t; });
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const now = deps.now ?? (() => Date.now());

  // callId -> { model, timer, startedAt }. One entry per in-flight LLM request.
  const inflight = new Map();

  function markStart({ callId, model, agentKey = null }) {
    if (callId == null) return; // no id → can't track this call; stay inert (see plan nil-cid note)
    // Defensive: if this callId is somehow already armed, clear the old timer first.
    const prior = inflight.get(callId);
    if (prior) clearTimer(prior.timer);
    const ms = timeoutForModel?.(model) ?? timeoutMs;
    if (!(ms > 0)) return; // 0 / negative → automatic stall disabled for this model (e.g. local rungs; use /pivot down)
    const timer = setTimer(() => {
      inflight.delete(callId);
      try { onStall?.(model, agentKey); } catch { /* isolate — a bad handler must not break the watch */ }
    }, ms);
    inflight.set(callId, { model, agentKey, timer, startedAt: now() });
  }

  // Called by BOTH llm_end and turn_end — whichever settles the call first. Idempotent.
  function markSettled(callId) {
    const rec = inflight.get(callId);
    if (!rec) return; // unknown or already-settled → no-op
    clearTimer(rec.timer);
    inflight.delete(callId);
  }

  function stop() {
    for (const { timer } of inflight.values()) clearTimer(timer);
    inflight.clear();
  }

  return { markStart, markSettled, stop, _inflightSize: () => inflight.size };
}
