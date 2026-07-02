/**
 * AutoPivot — resolver.
 *
 * Given the ordered rules, the currently-active condition ids, the primary model,
 * and the manual-override mode, decide which model to run and how. PURE + sync so
 * it's trivial to test and cheap to call on every turn_start.
 *
 * Rules: FIRST MATCH WINS, in config order (Plan R8/R9).
 *
 * Reachability is a HARD GATE, not a peer (Plan Review #8): when offline, a rule
 * whose target is NOT local is INELIGIBLE regardless of its position — so a
 * higher-priority cost/rate-limit rule can't route you to an unreachable cloud
 * model while you're offline. A target is "local/reachable" when `target.local`
 * is true (set in config for your local fallback).
 *
 * Manual override is special (not a route-to-target rule):
 *   - "online"  → force primary, ignore all conditions.
 *   - "offline" → behave as offline: pick the first local/degraded rule.
 *   - "auto"    → normal condition-driven resolution.
 */

function ruleResult(rule) {
  const perMode = {};
  if (rule.target.contextWindow !== undefined) perMode.contextWindow = rule.target.contextWindow;
  if (rule.target.reasoningEffort !== undefined) perMode.reasoningEffort = rule.target.reasoningEffort;
  return {
    model: rule.target.model ?? null,
    perMode,
    modeLabel: rule.modeLabel,
    isDegraded: rule.isDegraded === true,
    matchedCondition: rule.condition,
  };
}

function primaryResult(primary) {
  return { model: primary ?? null, perMode: {}, modeLabel: "primary", isDegraded: false, matchedCondition: null };
}

/**
 * @param {Array} rules - normalized rules in priority order
 * @param {Iterable<string>} activeConditionIds - ids active right now (engine order)
 * @param {string|null} primary - default model handle
 * @param {{manualMode?: "auto"|"online"|"offline"}} [opts]
 * @returns {{model, perMode, modeLabel, isDegraded, matchedCondition}}
 */
export function resolve(rules, activeConditionIds, primary, opts = {}) {
  const active = new Set(activeConditionIds ?? []);
  const manualMode = opts.manualMode ?? "auto";

  // Manual "online" wins over everything: force the primary model.
  if (manualMode === "online") return primaryResult(primary);

  // Offline when the user forces it OR (in auto) reachability is tripped.
  const offline = manualMode === "offline" || (manualMode === "auto" && active.has("reachability"));

  // Manual "offline": route to the first local/degraded rule, ignoring whether
  // its condition happens to be active (the user is forcing offline).
  if (manualMode === "offline") {
    const r = rules.find((x) => x.condition !== "manual" && (x.target.local === true || x.isDegraded === true));
    return r ? ruleResult(r) : primaryResult(primary);
  }

  // Auto: first active, eligible rule wins. Skip the synthetic "manual" condition.
  for (const rule of rules) {
    if (rule.condition === "manual") continue;
    if (!active.has(rule.condition)) continue;
    if (offline && rule.target.local !== true) continue; // hard gate: no unreachable target while offline
    return ruleResult(rule);
  }
  return primaryResult(primary);
}

// ---- Ladder resolver (v2.0) -------------------------------------------------
//
// The v2 reframe: not "first active condition" but "first REACHABLE rung." The
// ladder is the ordered list of model rungs — rung 0 is the primary (health = the
// brain "reachability" probe), rungs 1..N are the configured rules in order (health
// = each rule's own probe, or always-available when it has none). `resolveLadder`
// walks top→down and runs the highest rung that is currently reachable; if none is,
// it returns a `none-reachable` result rather than stranding the agent on a dead
// model (Stranding guard, R4). Manual override still trumps (R5).
//
// Why this supersedes `resolve`: cost/rate-limit (Phase 3/4, out of scope) are
// reframed by the design as per-rung triggers + global conditions, so the v1
// condition-first path has no v2 future. `resolve` is kept only as the v1-equivalence
// reference its tests assert against.

/**
 * Build the ordered rung descriptors from the primary + normalized rules.
 * A rule gets a per-rung probe id (`rung:<i>`) ONLY when it carries its own
 * `reachability.probeUrl`; otherwise its `probeId` is null = always-available
 * terminus (this is exactly v1's single local fallback).
 */
export function buildRungs(primary, rules = []) {
  const rungs = [{
    index: 0, // stable identity for the suspension channel (Phase 3a)
    model: primary ?? null,
    perMode: {},
    modeLabel: "primary",
    isDegraded: false,
    local: false,
    probeId: "reachability", // rung 0 health = the brain probe
  }];
  rules.forEach((rule, i) => {
    const perMode = {};
    if (rule?.target?.contextWindow !== undefined) perMode.contextWindow = rule.target.contextWindow;
    if (rule?.target?.reasoningEffort !== undefined) perMode.reasoningEffort = rule.target.reasoningEffort;
    rungs.push({
      index: i + 1, // rung 0 is the primary; rules start at 1
      model: rule?.target?.model ?? null,
      perMode,
      modeLabel: rule?.modeLabel ?? "mode",
      isDegraded: rule?.isDegraded === true,
      local: rule?.target?.local === true,
      // Health source: its own probe if it has one; else a LOCAL rung is the
      // always-available terminus (probeId null), while a CLOUD fallback with no probe
      // inherits the brain/"reachability" probe — so "offline" (brain down) gates every
      // cloud rung together and the ladder falls through to the local terminus.
      probeId: rule?.reachability?.probeUrl
        ? `rung:${i}`
        : (rule?.target?.local === true ? null : "reachability"),
    });
  });
  return rungs;
}

function rungResult(rung) {
  if (!rung) return { model: null, perMode: {}, modeLabel: "none-reachable", isDegraded: false, kind: "none-reachable" };
  return { model: rung.model ?? null, perMode: rung.perMode ?? {}, modeLabel: rung.modeLabel, isDegraded: rung.isDegraded === true };
}

// A rung is available unless (a) it is SUSPENDED (Phase 3a — a completion-failure was
// attributed to it), or (b) its probe explicitly reports "unreachable" (v2.0). The
// suspension check comes FIRST and is keyed by rung index, so it works even for a
// probe-less terminus rung (probeId null) — which the health map alone cannot suspend,
// since a probe-less rung is otherwise always available. A missing health entry →
// available (online-by-default, matching an inert/empty-URL probe).
function rungAvailable(rung, health, suspended) {
  if (suspended?.has(rung.index)) return false; // stall-suspended → out, regardless of probe
  if (!rung.probeId) return true;
  return health?.[rung.probeId] !== "unreachable";
}

/**
 * @param {Array} rungs   ordered rung descriptors (rung 0 = primary), from buildRungs
 * @param {Object} health map of probeId → "available" | "unreachable"
 * @param {{manualMode?: "auto"|"online"|"offline", suspended?: Set<number>}} [opts]
 *        suspended: rung indices currently stall-suspended (Phase 3a).
 * @returns {{model, perMode, modeLabel, isDegraded, kind?, warning?}}
 */
export function resolveLadder(rungs, health = {}, opts = {}) {
  const manualMode = opts.manualMode ?? "auto";
  const suspended = opts.suspended; // Set<number> of rung indices, or undefined
  const primary = rungs?.[0] ?? null;
  const noneReachable = { model: null, perMode: {}, modeLabel: "none-reachable", isDegraded: false, kind: "none-reachable" };

  if (!primary) return noneReachable;

  // Manual "online" forces the primary — user choice trumps health/suspension (R5), but
  // warn when we're forcing a rung that appears unavailable.
  if (manualMode === "online") {
    const res = rungResult(primary);
    if (!rungAvailable(primary, health, suspended)) res.warning = `forcing ${primary.model ?? "primary"} which appears unreachable`;
    return res;
  }

  // Manual "offline" routes to the first local/degraded rung, ignoring health.
  if (manualMode === "offline") {
    const r = (rungs ?? []).find((x) => x.local === true || x.isDegraded === true);
    return r ? rungResult(r) : rungResult(primary);
  }

  // Auto: highest available rung wins (dynamic shift-up).
  for (const rung of rungs) {
    if (rungAvailable(rung, health, suspended)) return rungResult(rung);
  }
  // Nothing available and no always-available terminus → don't strand on a dead model.
  return noneReachable;
}
