/**
 * AutoPivot — conditions.
 *
 * A *condition* observes some signal and reports whether it is currently
 * "active" (tripped). Conditions are the pluggable unit of AutoPivot: add a new
 * one by implementing this shape — the engine, resolver, and statusline need no
 * changes (Plan R4).
 *
 *   Condition = {
 *     id,                       // "reachability" | "manual" | "cost" | "rateLimit"
 *     start(onChange),          // begin watching; call onChange() on a confirmed flip
 *     isActive() -> boolean,    // is it tripped right now?
 *     metric?() -> { label, value, ceiling, nearThreshold } | null,
 *     stop()                    // clean up timers/listeners
 *   }
 *
 * v1 BUILDS `reachability` (automatic) and `manual` (user override). `cost` and
 * `rateLimit` are documented STUBS that prove the shape — they implement the
 * interface but are inert until wired (see notes on each).
 */

// ---- Reachability (built) ---------------------------------------------------

/** Validate a probe URL. Only http(s); anything else is rejected (Review #4 SSRF). */
export function validateProbeUrl(url) {
  if (!url) return { ok: false, reason: "empty" };
  let u;
  try { u = new URL(url); } catch { return { ok: false, reason: "unparseable" }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `scheme ${u.protocol} not allowed (http/https only)` };
  }
  return { ok: true };
}

/**
 * Generic probe condition (the reusable core). Probes `rc.probeUrl` every
 * `rc.intervalMs`; flips `active` after `failureThreshold` consecutive failures and
 * back after `recoveryThreshold` consecutive successes (hysteresis → no flapping).
 * The returned object carries the given `id`, so the same machinery backs the
 * primary "reachability" probe, the neutral "network" probe (Phase 1), and the
 * per-rung "rung:N" probes (Phase 2) — one well-tested implementation, many uses.
 *
 * `active` means "the thing this probe watches is currently UNreachable." For the
 * reachability/rung probes that means offline/down; for the network probe it means
 * the network is down (→ actions unavailable). Callers interpret it per axis.
 *
 * Classification: any HTTP response with status < 500 (incl. 401/429) = reachable
 * (rate-limit handling belongs to the rateLimit condition); 5xx, timeout, DNS/TLS,
 * connection-refused = unreachable. Redirects are NOT followed (Review #4).
 *
 * deps (injectable for tests): { fetch, env, now, onProbe }.
 */
export function makeProbeCondition(id, rc, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());

  let active = false; // true = offline
  let fails = 0;
  let oks = 0;
  let lastProbeAt = 0;
  let timer = null;
  let onChangeCb = null;
  const valid = validateProbeUrl(rc?.probeUrl);

  function authHeaders() {
    const name = rc?.probeAuthEnv;
    const token = name ? env[name] : null;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // The unit-testable core: probe once and apply hysteresis. Returns true if a
  // confirmed flip happened. `cb` overrides the registered onChange (tests pass it
  // directly to drive probes deterministically without timers).
  const probeTimeoutMs = rc?.probeTimeoutMs ?? 4000;

  async function probeOnce(cb) {
    const notify = cb ?? onChangeCb;
    if (!valid.ok) return false; // can't probe → stays inactive (online-by-default)
    lastProbeAt = now();
    let reachable = false;
    // Fail a hung probe fast: abort after probeTimeoutMs so offline is detected
    // promptly instead of waiting for the OS TCP timeout.
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const killer = controller ? setTimeout(() => controller.abort(), probeTimeoutMs) : null;
    if (killer && typeof killer.unref === "function") killer.unref();
    try {
      const res = await fetchFn(rc.probeUrl, {
        method: "GET",
        redirect: "manual", // never follow redirects (no SSRF pivot)
        headers: authHeaders(),
        signal: controller?.signal,
      });
      reachable = typeof res?.status === "number" ? res.status < 500 : false;
    } catch {
      reachable = false; // timeout / abort / DNS / TLS / refused
    } finally {
      if (killer) clearTimeout(killer);
    }
    const wasActive = active;
    if (reachable) { oks++; fails = 0; if (active && oks >= rc.recoveryThreshold) active = false; }
    else { fails++; oks = 0; if (!active && fails >= rc.failureThreshold) active = true; }
    if (active !== wasActive && notify) notify(); // confirmed flip → engine onChange
    try { deps.onProbe?.(); } catch { /* UI callback isolated */ } // every probe → UI can show retry progress
    return active !== wasActive;
  }

  // Adaptive scheduling: probe at the relaxed `intervalMs` when state is settled,
  // but speed up to `confirmIntervalMs` while a flip is being confirmed (failures
  // accumulating toward offline, or successes toward recovery). Responsive on
  // change, light when stable.
  const intervalMs = rc?.intervalMs ?? 20000;
  const confirmIntervalMs = rc?.confirmIntervalMs ?? 5000;
  const pending = () => (!active && fails > 0) || (active && oks > 0);
  function scheduleNext() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runTick, pending() ? confirmIntervalMs : intervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  }
  async function runTick() { await probeOnce(); scheduleNext(); }

  return {
    id,
    start(onChange) {
      onChangeCb = onChange;
      if (!valid.ok) return; // nothing to probe; remain inert
      probeOnce().then(scheduleNext); // immediate probe, then self-schedule adaptively
    },
    stop() { if (timer) clearTimeout(timer); timer = null; onChangeCb = null; },
    isActive() { return active; },
    isStale(thresholdMs) { return now() - lastProbeAt > thresholdMs; },
    // A flip is being confirmed (the "trying to reconnect" window): failures
    // accumulating toward offline, or successes toward recovery — but not yet settled.
    isPending() {
      return (!active && fails > 0 && fails < rc.failureThreshold) ||
             (active && oks > 0 && oks < rc.recoveryThreshold);
    },
    pendingInfo() {
      return active
        ? { direction: "online", attempt: oks, threshold: rc.recoveryThreshold } // reconnecting
        : { direction: "offline", attempt: fails, threshold: rc.failureThreshold }; // dropping
    },
    metric() { return null; },
    // exposed for tests:
    probeOnce,
    _state: () => ({ active, fails, oks, lastProbeAt, valid }),
  };
}

/**
 * Reachability condition — the primary "brain" probe. Thin wrapper over
 * `makeProbeCondition` fixing `id:"reachability"` so existing callers/tests and the
 * resolver's hard-gate keep working unchanged.
 */
export function makeReachabilityCondition(rc, deps = {}) {
  return makeProbeCondition("reachability", rc, deps);
}

// ---- Manual override (built) ------------------------------------------------

/**
 * Manual override condition. Highest precedence by convention (place its rule
 * first). `set("offline"|"online"|"auto")` forces a mode; "auto" clears it.
 * Persisted by the caller (Unit 6) so it survives /reload.
 */
export function makeManualCondition(initial = "auto") {
  let mode = initial === "offline" || initial === "online" ? initial : "auto";
  let onChangeCb = null;
  return {
    id: "manual",
    start(onChange) { onChangeCb = onChange; },
    stop() { onChangeCb = null; },
    // "active" means an override is in force; the resolver/forced-state UI reads mode().
    isActive() { return mode !== "auto"; },
    mode() { return mode; },
    set(next) {
      const m = next === "offline" || next === "online" ? next : "auto";
      if (m !== mode) { mode = m; if (onChangeCb) onChangeCb(); }
    },
    metric() { return null; },
  };
}

// ---- Designed stubs (not wired in v1) ---------------------------------------

/**
 * Cost ceiling (STUB). Intended: accumulate spend from `llm_end` usage ×
 * `model.cost` and trip when spend ≥ ceiling for the window. Wire by feeding
 * `record(usage, cost)` from an `llm_end` listener and a window reset. Inert here.
 */
export function makeCostCondition(opts = {}) {
  let spend = 0;
  const ceiling = opts.ceiling ?? Infinity;
  return {
    id: "cost",
    start() {}, stop() {},
    record(usage, cost) {
      if (!usage || !cost) return;
      spend += (usage.promptTokens ?? 0) / 1e6 * (cost.input ?? 0)
             + (usage.completionTokens ?? 0) / 1e6 * (cost.output ?? 0);
    },
    reset() { spend = 0; },
    isActive() { return spend >= ceiling; },
    metric() { return { label: "cost", value: spend, ceiling, nearThreshold: spend >= 0.8 * ceiling }; },
  };
}

/**
 * Rate-limit (STUB). NOTE: provider rate-limit headers are NOT exposed to mods,
 * so this is a SELF-TRACKED budget — count requests/tokens in a rolling window and
 * trip at a % of a user-configured budget (not the provider's real limit). Inert.
 */
export function makeRateLimitCondition(opts = {}) {
  let used = 0;
  const budget = opts.budget ?? Infinity;
  return {
    id: "rateLimit",
    start() {}, stop() {},
    record(n = 1) { used += n; },
    reset() { used = 0; },
    isActive() { return used >= budget; },
    metric() { return { label: "rate", value: used, ceiling: budget, nearThreshold: used >= 0.8 * budget }; },
  };
}
