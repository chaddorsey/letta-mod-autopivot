/**
 * AutoPivot — condition-aware model switching + offline profile for Letta Code.
 *
 * Entry point. Wires the pure modules in lib/ into the mod lifecycle:
 *   config → conditions → engine → resolver → turn_start (switch + honesty)
 *   + a LIVE statusline pill (with retry/reconnect indicator) + /pivot commands
 *   + pivot announcements.
 *
 * What it does: automatically switch the active model based on prioritized
 * condition rules (v1 builds reachability + manual override), and — on a
 * local-backend agent — keep the agent honest when it drops to a local model.
 *
 * What it deliberately does NOT do: turn a cloud agent into a local one, replicate
 * server state offline, or sync memory. See README "Scope & boundary".
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { loadConfig, parseConfig, agentPrimary } from "./lib/config.mjs";
import { discoverModels, buildStarterConfig } from "./lib/configure-core.mjs";
import { makeReachabilityCondition, makeManualCondition, makeProbeCondition } from "./lib/conditions.mjs";
import { makeEngine } from "./lib/engine.mjs";
import { resolveLadder, buildRungs } from "./lib/resolver.mjs";
import { makeFailureSeam } from "./lib/failure-seam.mjs";
import { makeStallWatch } from "./lib/failure-watch.mjs";
import * as fsMod from "node:fs";
import { modelToRungIndex, canSuspend } from "./lib/suspension.mjs";
import { classifyRateLimit } from "./lib/rate-limit.mjs";
import { classifyLlmEnd, describeReason } from "./lib/llm-end.mjs";
import { decideTurn, injectNote, buildHonestyNote } from "./lib/turn.mjs";
import { renderPill, metricSegment } from "./lib/statusline.mjs";
import { buildStatusText } from "./lib/status.mjs";
import { loadState, saveState } from "./lib/state.mjs";
import { makeMemfsSeam } from "./lib/memfs-seam.mjs";

const MOD_DIR = join(homedir(), ".letta", "mods");
// User data lives in a STABLE dir (survives reinstalls), not next to the bundle.
const CONFIG_PATH = join(MOD_DIR, "autopivot.config.json");
const STATE_PATH = join(MOD_DIR, "autopivot.state.json");
// The bundled interactive configurator ships INSIDE the package, next to the mod entry
// (see package.json "files" + build:configure). Resolve it relative to THIS module so the
// `/pivot setup` hint points at wherever letta actually installed the package — not a
// hard-coded ~/.letta/mods path that only held for a hand-copied install. Candidates cover:
//   1. packaged install  — sibling of dist/autopivot.mjs      (the shipped layout)
//   2. running from source — repo/dist/autopivot-configure.cjs (after `npm run build`)
//   3. legacy manual copy  — ~/.letta/mods/autopivot-configure.cjs
// First that exists wins; otherwise fall back to the packaged path for the printed hint.
const CONFIGURE_PATH = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "autopivot-configure.cjs"),
    join(here, "dist", "autopivot-configure.cjs"),
    join(MOD_DIR, "autopivot-configure.cjs"),
  ];
  return candidates.find((c) => { try { return existsSync(c); } catch { return false; } }) ?? candidates[0];
})();

export default async function activate(letta) {
  const disposers = [];
  // letta.log goes to a per-agent debug log that is off by default, which is why
  // 284 restarts and a day of failovers left no trace anywhere an operator looks.
  // Mirror to a file we control. Cheap, append-only, and the ONLY way to see what
  // this mod decided.
  const traceFile = () => {
    try {
      const home = globalThis.process?.env?.HOME;
      return home ? `${home}/Library/Logs/autopivot.log` : null;
    } catch { return null; }
  };
  const trace = (m) => {
    try {
      const f = traceFile();
      if (!f) return;
      // Lazily imported so a bundler/runtime without fs still loads the mod.
      globalThis.__autopivotFs ??= fsMod;
      globalThis.__autopivotFs.appendFileSync(f, `[${new Date().toISOString()}] ${m}\n`);
    } catch { /* never fatal */ }
  };
  const log = (m) => {
    try { letta.log?.(`autopivot: ${m}`); } catch { /* no logger */ }
    trace(m);
  };

  const { config, warnings } = await loadConfig(CONFIG_PATH);
  log(`activate: pid=${globalThis.process?.pid} argv=${(globalThis.process?.argv ?? []).slice(1).join(" ")}`);
  // The host declares which event families it actually emits. llm_start/llm_end
  // only fire where provider requests run client-side; a surface that does them
  // elsewhere registers the handler and never calls it, which is indistinguishable
  // from "nothing ever failed".
  try {
    log(`capabilities: ${JSON.stringify(letta.capabilities ?? null)}`);
  } catch (e) { log(`capabilities unreadable: ${e?.message ?? e}`); }
  // THE failure detector depends on llm_start/llm_end, which only fire where
  // provider requests run client-side. Behind an App Server they do not, and
  // `events.on` still ACCEPTS the handler — so the mod looks installed, healthy
  // and armed while nothing can ever reach it. Say it out loud instead: an
  // operator debugging "why didn't it fail over" should not have to discover
  // this by instrumenting the mod, as happened on 2026-09-03.
  const llmEvents = letta.capabilities?.events?.llm;
  if (llmEvents === false) {
    log("DEGRADED: this host does not emit llm_start/llm_end (capabilities.events.llm=false). " +
        "Completion-failure detection — rate limits, auth failures, stalls — CANNOT run here. " +
        "The reachability ladder still works; failover on a failed completion does not.");
  }
  for (const w of warnings) log(w);

  const state = await loadState(STATE_PATH);
  const episode = { degraded: false };

  const manual = makeManualCondition(state.manualMode);
  // onProbe fires after every reachability probe so the UI can show retry progress
  // during the "trying to reconnect" window (not just on the settled flip).
  const reachability = makeReachabilityCondition(config.reachability, { onProbe: () => { try { updateUi(); } catch { /* ignore */ } } });

  // NETWORK probe (Phase 1) — the action-availability axis, separate from rung
  // health. When a neutral networkProbe is configured we use its signal to pick the
  // honesty note (offline/queue vs degraded-but-online). Unconfigured → null →
  // conservative offline note (exactly v1). It rides the engine for lifecycle +
  // change fan-out but is NOT a routing condition (no rule has condition "network").
  const networkConfigured = !!config.networkProbe?.probeUrl;
  const network = makeProbeCondition("network", config.networkProbe);
  const netStaleMs = Math.max(1, (config.networkProbe?.failureThreshold ?? 2) + 1) * (config.networkProbe?.intervalMs ?? 20000);

  // LADDER (Phase 2): primary is rung 0 (health = the brain reachability probe);
  // each rule is a rung. A rule with its own `reachability.probeUrl` gets a per-rung
  // probe so it walks by ITS OWN health (true multi-rung shift-up); a rule without
  // one is the always-available terminus. Build the per-rung probes here and a live
  // health map for resolveLadder.
  const rungs = buildRungs(config.primary, config.rules);
  const rungProbes = new Map(); // probeId → probe condition
  const addRungProbes = (rules, ns) => {
    (rules ?? []).forEach((rule, i) => {
      if (!rule?.reachability?.probeUrl) return;
      const id = `${ns}:${i}`;
      if (rungProbes.has(id)) return;
      rungProbes.set(id, makeProbeCondition(id, rule.reachability, { onProbe: () => { try { updateUi(); } catch { /* ignore */ } } }));
    });
  };
  addRungProbes(config.rules, "rung");
  // Per-agent ladders get their OWN probe ids, built once here at activate rather
  // than per turn: probes carry timers and state, and rebuilding them each turn
  // would restart every backoff. Namespacing keeps two agents' rung 1 from
  // sharing a health verdict when they are different models.
  for (const [key, override] of Object.entries(config.agents ?? {})) {
    if (Array.isArray(override?.rules)) addRungProbes(override.rules, `agent:${key}`);
  }
  function healthMap() {
    const h = { reachability: reachability.isActive() ? "unreachable" : "available" };
    for (const [id, c] of rungProbes) h[id] = c.isActive() ? "unreachable" : "available";
    return h;
  }

  const engine = makeEngine([manual, reachability, network, ...rungProbes.values()]);
  const seam = makeMemfsSeam(config.memorySync, letta.memorySync);

  // --- failure detection → rung suspension -------------------------------------
  // A rung can be REACHABLE yet fail the completion (rate-limit / no-credit / auth /
  // overflow). TWO detectors feed one swappable FAILURE SEAM:
  //   1. llm_end error (letta-code 0.27.20+, PR #3164) — structured error on the event →
  //      near-instant failover. This is the `provider_error`-shaped signal the seam was
  //      built for; it plugged in with zero consumer rework. See lib/llm-end.mjs.
  //   2. stall watchdog — on 0.27.18/0.27.19 a failed request emits NO llm_end at all
  //      (probe-verified), so an unmatched `llm_start` past a timeout is the only signal.
  //      Still the backstop for a true hang (no llm_end ever) on any version.
  // Keyed by AGENT, then rung index. Keying by index alone conflated agents:
  // rung 0 is already per-agent, so suspending Kinara's rung 0 marked index 0
  // suspended for the whole fleet and dropped every other agent off a healthy
  // primary. Harmless while all agents shared one primary; live the moment
  // per-agent overrides started resolving.
  const stallCfg = config.stall;
  const suspended = new Map(); // agentKey → Map(rungIndex → { count, until })
  const GLOBAL_AGENT = "__global__";
  const bucket = (agentKey) => {
    const k = agentKey ?? GLOBAL_AGENT;
    let b = suspended.get(k);
    if (!b) { b = new Map(); suspended.set(k, b); }
    return b;
  };
  // Reading the set is also where timed suspensions expire. A rate-limited rung
  // carries an `until`, and once the window closes it becomes eligible again on
  // its own — recovery-by-success cannot do this, because a suspended rung is
  // never given a turn to succeed on.
  const suspendedSet = (agentKey) => {
    const b = bucket(agentKey);
    const now = Date.now();
    for (const [idx, v] of [...b]) {
      if (v?.until && now >= v.until) b.delete(idx);
    }
    return new Set(b.keys());
  };
  const anySuspended = () => {
    for (const k of [...suspended.keys()]) if (suspendedSet(k).size > 0) return true;
    return false;
  };
  const failSeam = makeFailureSeam();
  // letta-code's llm_start/llm_end carry no per-call id and calls within a conversation
  // are sequential (tool loops = start→end→start→end), so we key by conversation id.
  const stallWatch = makeStallWatch({
    timeoutMs: stallCfg.timeoutMs,
    timeoutForModel: (model) => {
      const rung = rungs.find((r) => r.model === model);
      if (!rung || rung.index === 0) return undefined;       // primary uses the global timeout
      return config.rules[rung.index - 1]?.stall?.timeoutMs; // per-rung override, if set
    },
    onStall: (model, agentKey) => { try { failSeam.report(model, "stall", agentKey); } catch { /* ignore */ } },
  });

  const clearSuspension = (idx, agentKey) => { bucket(agentKey).delete(idx); };
  /**
   * The ladder as THIS agent sees it. Every suspension decision has to be made
   * against the agent's own rungs, or an index means one model here and another
   * there — which is the bug this keying replaced.
   */
  function ladderFor(agentKey) {
    const override = agentKey ? config.agents?.[agentKey] : null;
    if (!override) return rungs;
    return buildRungs(
      override.primary ?? config.primary,
      override.rules ?? config.rules,
      { probeNamespace: Array.isArray(override.rules) ? `agent:${agentKey}` : "rung" },
    );
  }

  // Recovery-by-success: a clean completion on a suspended rung clears it (e.g. after the
  // user /pivots back to it and it works).
  function noteSuccess(model, agentKey) {
    const idx = modelToRungIndex(ladderFor(agentKey), model);
    if (idx != null && bucket(agentKey).has(idx)) {
      clearSuspension(idx, agentKey);
      try { updateUi(); } catch { /* ignore */ }
    }
  }

  // Seam consumer: a rung failed → suspend it, unless that would strand the ladder
  // (never suspend the last rung). STICKY: a completion failure is class-blind and can't
  // be confirmed as recovered (unlike a reachability probe), so we do NOT auto-walk back
  // up to a stall-suspended rung — it stays out until the user runs /pivot online|auto or
  // a later completion on it succeeds. This is what prevents the bounce back to a
  // still-broken rung (and keeps the never-strand guard honest — a suspended rung stays
  // counted, so the fallback can't be suspended out from under us).
  disposers.push(failSeam.onFailure(({ rungId: model, reason, agentKey }) => {
    try {
      const ladder = ladderFor(agentKey);
      const idx = modelToRungIndex(ladder, model);
      if (idx == null) {
        // Dropping this silently is how a real provider failure becomes no
        // observable event at all. Suspending the wrong rung would be worse, so
        // the drop stays — but it must be visible, because "model not on the
        // ladder" is a CONFIG fault the operator can actually fix.
        log(`failure for off-ladder model ${model} ignored (agent=${agentKey ?? "-"}; ladder: ${ladder.map((r) => r.model).join(", ")})`);
        return;
      }
      if (bucket(agentKey).has(idx)) return; // already suspended → nothing to do
      // When 0.27.20+ hands us a structured error, tell the user what actually broke.
      const why = reason && typeof reason === "object" ? ` (${describeReason(reason)})` : "";
      if (!canSuspend(ladder.length, suspendedSet(agentKey), idx)) {
        announce(`⚠️ AutoPivot: all rungs failing${why} — staying on ${model}. Run /pivot online to retry.`);
        return;
      }
      // A rate limit is a rung that is HEALTHY and temporarily refusing. It still
      // gets suspended — you cannot use it — but with an expiry, so it returns by
      // itself. Without one it would sit out until /pivot online, since the only
      // other way back is a clean completion the suspension itself prevents.
      const { rateLimited, resetsAt } = classifyRateLimit(reason);
      bucket(agentKey).set(idx, { count: (bucket(agentKey).get(idx)?.count ?? 0) + 1, until: resetsAt ?? null });
      const next = computeView(null, agentKey ? { id: agentKey } : {}).desired;
      const backIn = resetsAt
        ? ` ${model} returns automatically in ${Math.max(1, Math.round((resetsAt - Date.now()) / 1000))}s.`
        : "";
      const what = rateLimited ? "rate-limited" : "failed";
      announce(`⚠️ AutoPivot: ${model} ${what}${why} → now on ${next ?? "(no model)"}.${backIn} Resend your message; /pivot online to retry.`);
      try { updateUi(); } catch { /* ignore */ }
    } catch (e) { log(`suspend: ${e?.message ?? e}`); }
  }));

  const staleMs = Math.max(1, config.reachability.failureThreshold + 1) * config.reachability.intervalMs;

  // Tri-state action availability: true (network confirmed up) | false (confirmed
  // down) | null (no probe, or not yet confirmed → treat as unknown = conservative).
  function actionsAvailable() {
    if (!networkConfigured) return null;
    if (network.isStale(netStaleMs)) return null;
    return !network.isActive();
  }
  // Headline label for /pivot status (omitted when unconfigured).
  function actionsLabel() {
    const a = actionsAvailable();
    if (a === null) return networkConfigured ? "unknown" : null;
    return a ? "online" : "offline";
  }

  // LIVE view — recomputed on demand (no caching). `checking` is the retry window
  // (a flip is being confirmed); `desired` is AutoPivot's target model.
  /**
   * Which agent is this turn for?
   *
   * The mod activates once per process but the App Server serves the whole fleet,
   * so identity must come from the TURN, not from activate(). memfs.memoryDir is
   * `~/.letta/agents/<agent-id>/memory`, which makes the id derivable without a
   * new host capability; ctx.agent is preferred when the host offers it.
   */
  function agentIdentity(ctx) {
    // TWO layouts, because the fleet moved and this regex did not:
    //   Docker-era  ~/.letta/agents/<id>/memory
    //   local       ~/.letta/lc-local-backend/memfs/<id>/memory
    // Matching only `agents/` silently returned null for every LOCAL agent, so
    // every per-agent override was dead and rung 0 was always the global
    // primary. An agent running its own override was therefore OFF-LADDER, and
    // an off-ladder failure is dropped — which is why a rate limit never failed
    // over (observed 2026-09-02 and again 2026-09-03).
    const id = ctx?.agent?.id
      ?? (String(ctx?.memfs?.memoryDir ?? "").match(/(?:agents|memfs)\/([^/]+)/)?.[1] ?? null);
    const name = ctx?.agent?.name ?? null;
    return { id, name };
  }

  function computeView(activeModelId, identity = {}) {
    const mode = manual.mode();
    // A per-agent override replaces rung 0 only; the rungs below stay global
    // (see normalizeAgents). Rebuilding rung 0 per turn is cheap — buildRungs is
    // a pure list construction, no probes are re-created.
    const agentTop = agentPrimary(config, identity);
    const effectiveRungs = (agentTop.primary === config.primary && !agentTop.ownRules)
      ? rungs
      : buildRungs(agentTop.primary, agentTop.rules, {
          probeNamespace: agentTop.ownRules ? `agent:${agentTop.key}` : "rung",
        });
    const resolved = resolveLadder(effectiveRungs, healthMap(),
      { manualMode: mode, suspended: suspendedSet(agentTop.key) });
    if (agentTop.matched && resolved.modeLabel === "primary") {
      resolved.perMode = { ...(resolved.perMode ?? {}), ...agentTop.perMode };
    }
    const pendingInfo = mode === "auto" && reachability.isPending?.() ? reachability.pendingInfo() : null;
    let kind;
    if (mode === "offline") kind = "forced-offline";
    else if (mode === "online") kind = "forced-online";
    else if (pendingInfo) kind = "checking";
    else if (resolved.kind === "none-reachable") kind = "none-reachable";
    // A stall-suspension is active and we failed over to a working rung → "on fallback"
    // (reassuring, not alarming). Only when auto and not otherwise none-reachable.
    else if (mode === "auto" && anySuspended()) kind = "suspended";
    else if (resolved.isDegraded) kind = "offline";
    else if (config.reachability.probeUrl && reachability.isStale(staleMs)) kind = "unknown";
    else kind = "online";
    if (!agentTop.primary) kind = "unconfigured"; // first-run: no primary set yet → run /pivot setup
    const ruleSignifier = (agentTop.rules ?? config.rules).find((x) => x.modeLabel === resolved.modeLabel)?.signifier ?? null;
    return { kind, desired: resolved.model, actual: activeModelId, ruleSignifier, resolved,
             pendingInfo, warning: resolved.warning ?? null,
             agentOverride: agentTop.matched ? agentTop.primary : null };
  }

  // --- statusline pill (live render; shows retry/reconnect during a flip) ---
  let panel = null;
  if (letta.capabilities?.ui?.panels) {
    panel = letta.ui.openPanel({
      id: "autopivot",
      order: config.statusline.replacePrimary ? 0 : -1,
      render: ({ width, row, chalk, model }) => {
        const v = computeView(model?.id);
        const left = renderPill({ kind: v.kind, model: v.desired ?? v.actual, ruleSignifier: v.ruleSignifier, checking: v.pendingInfo }, config, chalk);
        const entries = engine.all().map((c) => ({
          metric: c.metric ? c.metric.bind(c) : () => null,
          statusDisplay: config.rules.find((x) => x.condition === c.id)?.statusDisplay ?? "near-threshold",
        }));
        return row(left, metricSegment(entries), width);
      },
    });
    disposers.push(() => { try { panel.close(); } catch { /* ignore */ } });
  }

  // --- announcements: a single transient toast that updates in place ---
  let toastHandle = null, toastTimer = null;
  function announce(text) {
    log(text);
    if (!letta.capabilities?.ui?.panels) return;
    try {
      if (toastTimer) clearTimeout(toastTimer);
      toastHandle = letta.ui.openPanel({ id: "autopivot-toast", order: 50, render: () => text }); // replaces by id
      toastTimer = setTimeout(() => { try { toastHandle?.close(); } catch { /* ignore */ } toastHandle = null; }, 6000);
      if (typeof toastTimer?.unref === "function") toastTimer.unref();
    } catch { /* ignore */ }
  }

  function keyOf(v) {
    return v.kind === "checking" ? `checking·${v.pendingInfo.direction}·${v.pendingInfo.attempt}` : `${v.kind}·${v.desired}`;
  }
  function msgOf(v) {
    if (v.kind === "checking") {
      const verb = v.pendingInfo.direction === "online" ? "reconnecting" : "checking connection";
      return `⟳ AutoPivot: ${verb}… (${v.pendingInfo.attempt}/${v.pendingInfo.threshold})`;
    }
    if (v.kind === "offline") return `🔴 AutoPivot: offline → ${v.desired}`;
    if (v.kind === "online") return `🟢 AutoPivot: online → ${v.desired}`;
    if (v.kind === "none-reachable") return `⚠️ AutoPivot: no model reachable — staying put, not switching to a dead model`;
    return null; // forced/unknown announced elsewhere or not at all
  }

  // Repaint the pill + emit a toast when the user-visible status changes.
  let lastKey = keyOf(computeView(null)); // seed so we don't announce the startup state
  function updateUi() {
    try { panel?.update?.(); } catch { /* ignore */ }
    const v = computeView(null);
    const key = keyOf(v);
    if (key !== lastKey) {
      lastKey = key;
      const msg = msgOf(v);
      if (msg) announce(msg);
    }
  }

  disposers.push(engine.onChange(() => {
    try { seam.onLinkChange(reachability.isActive()); updateUi(); } catch { /* ignore */ }
  }));

  // --- turn_start: apply the switch + honesty (single handler; Q1 verified) ---
  if (letta.capabilities?.events?.turns) {
    disposers.push(letta.events.on("turn_start", async (event, ctx) => {
      try {
        seam.setMemoryDir(ctx?.memfs?.memoryDir);
        const v = computeView(ctx?.model?.id, agentIdentity(ctx));
        const decision = decideTurn({
          target: v.resolved, currentModelId: ctx?.model?.id, episode,
          memfsEnabled: ctx?.memfs?.enabled === true, honestyMode: config.honesty,
          actionsAvailable: actionsAvailable(), // network axis → which honesty note
        });
        episode.degraded = decision.episode.degraded;
        if (decision.switchTo) await ctx.conversation.updateLlmConfig({ model: decision.switchTo, ...decision.perMode });
        try { panel?.update?.(); } catch { /* ignore */ }
        if (decision.shouldInject) return { input: injectNote(event.input, buildHonestyNote(v.resolved.modeLabel, decision.noteVariant)) };
      } catch (e) {
        log(`turn_start error: ${e?.message ?? e}`); // isolate — never break the turn
      }
    }));
  }

  // --- Phase 3a: stall-watchdog event hooks (defensive — no known capability flag) ---
  // Register llm_start/llm_end/turn_end in try/catch: the guarding capability (if any) is
  // unknown, so we register optimistically; if an event isn't supported the watch stays
  // inert (v2.0 behavior unchanged).
  const cidOf = (event, ctx) => ctx?.conversation?.id ?? event?.conversationId ?? ctx?.conversationId ?? "default";
  for (const [name, handler] of [
    ["llm_start", (event, ctx) => {
      log(`llm_start model=${event?.model ?? ctx?.model?.id ?? "-"}`);
      stallWatch.markStart({ callId: cidOf(event, ctx), model: event?.model ?? ctx?.model?.id,
                            agentKey: agentPrimary(config, agentIdentity(ctx)).key });
      try { panel?.update?.(); } catch { /* ignore */ }
    }],
    ["llm_end", (event, ctx) => {
      stallWatch.markSettled(cidOf(event, ctx));
      const model = event?.model ?? ctx?.model?.id;
      // FAST PATH (letta-code 0.27.20+, PR #3164): llm_end now fires on FAILURE too,
      // carrying a structured `error` (errorType + message + retryable) with `usage:null`.
      // classifyLlmEnd reads it → we fail over IMMEDIATELY instead of waiting out the stall
      // watchdog. On 0.27.18/0.27.19 there's no error field (a failed request emits no
      // llm_end), so this cleanly degrades to "benign end = success" and the watchdog stays
      // the detector. See lib/llm-end.mjs.
      const agentKey = agentPrimary(config, agentIdentity(ctx)).key;
      const { failed, reason } = classifyLlmEnd(event);
      log(`llm_end model=${model} agent=${agentKey ?? "-"} failed=${failed} ` +
          `stopReason=${event?.stopReason ?? "-"} reason=${JSON.stringify(reason)?.slice(0, 160)}`);
      if (failed) { try { failSeam.report(model, reason, agentKey); } catch { /* ignore */ } }
      else noteSuccess(model, agentKey); // a clean completion clears this agent's suspension
    }],
    ["turn_end", (event, ctx) => { log("turn_end"); stallWatch.markSettled(cidOf(event, ctx)); }],
  ]) {
    try { disposers.push(letta.events.on(name, handler)); log(`registered handler: ${name}`); }
    catch (e) { log(`event ${name} unavailable: ${e?.message ?? e}`); }
  }

  // --- /pivot command: status | offline | online | auto ---
  if (letta.capabilities?.commands) {
    disposers.push(letta.commands.register({
      id: "pivot",
      description: "AutoPivot: status | setup (first-run) | down (fail over now) | offline | online | auto",
      async run(ctx) {
        const arg = String(ctx?.args ?? "").trim().toLowerCase();
        // The cudgel: "this rung is stuck/failing — drop me down NOW." The human is the
        // right judge of a hung LOCAL turn (a watchdog can't tell slow from hung), so this
        // is the primary tool for local hangs. It feeds the same failure seam an auto-stall
        // would (a third producer), suspending the current rung and walking down.
        if (arg === "down") {
          const cur = ctx?.model?.id;
          const idx = modelToRungIndex(rungs, cur);
          if (idx == null) return { type: "output", output: `AutoPivot: ${cur ?? "the current model"} isn't a configured rung — nothing to pivot down from.` };
          failSeam.report(cur, "manual");
          if (!suspended.has(idx)) {
            return { type: "output", output: `AutoPivot: ${cur} is the last available rung — nowhere to pivot down to. /pivot online to reset.` };
          }
          const v = computeView(cur);
          let landed = "";
          if (ctx?.conversation?.updateLlmConfig && v.desired && v.desired !== cur) {
            try { await ctx.conversation.updateLlmConfig({ model: v.desired, ...(v.resolved.perMode ?? {}) }); landed = " (applies on your next message)"; }
            catch (e) { log(`switch: ${e?.message ?? e}`); }
          }
          return { type: "output", output: `AutoPivot: suspended ${cur} → now on ${v.desired ?? "(no model)"}${landed}. /pivot online to retry ${cur}.` };
        }

        // First-run onboarding: auto-discover the user's models and write a labeled
        // starter config (they refine + /reload). Falls back to the configurator if
        // discovery finds nothing.
        if (arg === "setup") {
          try {
            const starter = buildStarterConfig(await discoverModels());
            if (!starter) {
              return { type: "output", output: `AutoPivot: couldn't auto-discover any models.\n  Run the full configurator in a terminal:  node ${CONFIGURE_PATH}\n  or copy autopivot.config.example.json → ${CONFIG_PATH} and edit.` };
            }
            const { config: cfg, picks } = starter;
            const { warnings: w } = parseConfig(JSON.stringify(cfg));
            const header = "// AutoPivot STARTER config — auto-picked from your connected models.\n" +
                           `// Edit freely, then /reload. Full menu (in a terminal): node ${CONFIGURE_PATH}\n`;
            await writeFile(CONFIG_PATH, header + JSON.stringify(cfg, null, 2) + "\n");
            let out = `AutoPivot: wrote a starter config → ${CONFIG_PATH}\n` +
                      `  primary:        ${picks.primary}\n` +
                      `  cloud fallback: ${picks.cloudFallback ?? "(only one cloud model discovered)"}\n` +
                      `  local fallback: ${picks.fallback ?? "(no local model found — add one for offline failover)"}\n` +
                      `  probe:          ${picks.probeUrl || "(unset — put your primary's endpoint in reachability.probeUrl)"}`;
            if (picks.probeIsLocal) out += `\n  ⚠ couldn't derive a specific endpoint (localhost proxy) → probe defaults to an internet check (${picks.probeUrl}), which handles "offline → go local." For a SPECIFIC server, set reachability.probeUrl to it.`;
            if (w.length) out += `\n  (validation: ${w.join("; ")})`;
            out += `\n\nThese are best GUESSES. To pick/verify every field (incl. which models are local),`;
            out += `\nrun the menu configurator in a terminal:\n  node ${CONFIGURE_PATH}`;
            out += `\nor just edit the file. Then /reload.`;
            return { type: "output", output: out };
          } catch (e) {
            return { type: "output", output: `AutoPivot setup failed: ${e?.message ?? e}\n  Fall back to the menu configurator:  node ${CONFIGURE_PATH}` };
          }
        }
        if (arg === "offline" || arg === "online" || arg === "auto") {
          // Manual online/auto is an explicit "trust the rungs again" → clear stall suspensions.
          // Clears the WHOLE fleet: "online" is the operator saying "retry
          // everything", and leaving another agent suspended would be a silent
          // partial reset.
          if (arg === "online" || arg === "auto") suspended.clear();
          manual.set(arg);
          state.manualMode = arg;
          try { await saveState(STATE_PATH, state); } catch (e) { log(`state save: ${e?.message ?? e}`); }
          const v = computeView(ctx?.model?.id);
          // Pre-empt the switch from the command so it lands on the user's NEXT message.
          let landed = "";
          if (ctx?.conversation?.updateLlmConfig && v.desired && v.desired !== ctx?.model?.id) {
            try {
              await ctx.conversation.updateLlmConfig({ model: v.desired, ...(v.resolved.perMode ?? {}) });
              landed = ` (applies on your next message)`;
            } catch (e) { log(`switch: ${e?.message ?? e}`); }
          }
          lastKey = keyOf(v); // don't double-announce via the auto toast
          try { panel?.update?.(); } catch { /* ignore */ }
          const mode = arg === "auto" ? "automatic switching" : `forced ${arg}`;
          // Manual override always trumps, but warn when forcing an unreachable rung (R5).
          const warn = v.warning ? `\n⚠ ${v.warning}` : "";
          return { type: "output", output: `AutoPivot: ${mode} → ${v.desired ?? "(no model reachable)"}${landed}.${warn}` };
        }
        if (arg && arg !== "status") {
          return { type: "output", output: `AutoPivot: unknown subcommand "${arg}". Use: status | setup | down | offline | online | auto` };
        }
        // Not configured yet → point the user straight at onboarding instead of an empty status.
        if (!config.primary) {
          return { type: "output", output:
            `AutoPivot isn't configured yet.\n` +
            `  • Quick (here in the TUI):   /pivot setup   — auto-writes a starter config from your models\n` +
            `  • Full menu (in a terminal): node ${CONFIGURE_PATH}   — pick/verify every field\n` +
            `Then /reload.` };
        }
        const v = computeView(ctx?.model?.id);
        const conditions = engine.all().map((c) => ({ id: c.id, active: c.isActive(), metric: c.metric ? c.metric.bind(c) : null }));
        const base = buildStatusText({ modeLabel: v.resolved.modeLabel, model: v.desired, manualMode: manual.mode(), conditions, actions: actionsLabel() });
        const susp = [...suspended.entries()]
          .map(([idx, s]) => `  - suspended: rung ${idx} (${rungs[idx]?.model ?? "?"}) — failed ×${s.count}; /pivot online to retry`)
          .join("\n");
        return { type: "output", output: susp ? `${base}\n${susp}` : base };
      },
    }));
  }

  engine.start();
  return () => {
    for (const d of disposers.reverse()) { try { d(); } catch { /* ignore */ } }
    try { if (toastTimer) clearTimeout(toastTimer); } catch { /* ignore */ }
    try { stallWatch.stop(); } catch { /* ignore */ }
    try { engine.stop(); } catch { /* ignore */ }
  };
}
