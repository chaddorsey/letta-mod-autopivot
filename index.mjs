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
import { loadConfig, parseConfig } from "./lib/config.mjs";
import { discoverModels, buildStarterConfig } from "./lib/configure-core.mjs";
import { makeReachabilityCondition, makeManualCondition, makeProbeCondition } from "./lib/conditions.mjs";
import { makeEngine } from "./lib/engine.mjs";
import { resolveLadder, buildRungs } from "./lib/resolver.mjs";
import { makeFailureSeam } from "./lib/failure-seam.mjs";
import { makeStallWatch } from "./lib/failure-watch.mjs";
import { modelToRungIndex, canSuspend } from "./lib/suspension.mjs";
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
  const log = (m) => { try { letta.log?.(`autopivot: ${m}`); } catch { /* no logger */ } };

  const { config, warnings } = await loadConfig(CONFIG_PATH);
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
  const rungProbes = new Map(); // probeId ("rung:<i>") → probe condition
  config.rules.forEach((rule, i) => {
    if (rule?.reachability?.probeUrl) {
      rungProbes.set(`rung:${i}`, makeProbeCondition(`rung:${i}`, rule.reachability, { onProbe: () => { try { updateUi(); } catch { /* ignore */ } } }));
    }
  });
  function healthMap() {
    const h = { reachability: reachability.isActive() ? "unreachable" : "available" };
    for (const [id, c] of rungProbes) h[id] = c.isActive() ? "unreachable" : "available";
    return h;
  }

  const engine = makeEngine([manual, reachability, network, ...rungProbes.values()]);
  const seam = makeMemfsSeam(config.memorySync, letta.memorySync);

  // --- Phase 3a: stall-based failure detection → rung suspension ---------------
  // A rung can be REACHABLE yet fail the completion (rate-limit / no-credit / auth /
  // overflow). The only in-band signal is an unmatched `llm_start` (probe-verified), so
  // a stall watchdog is the detector. It feeds a swappable FAILURE SEAM (a future
  // `provider_error` event would feed the same seam). `suspended` is ephemeral (reset on
  // /reload): rungIndex → { count, timer }.
  const stallCfg = config.stall;
  const suspended = new Map();
  const suspendedSet = () => new Set(suspended.keys());
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
    onStall: (model) => { try { failSeam.report(model, "stall"); } catch { /* ignore */ } },
  });

  const clearSuspension = (idx) => { suspended.delete(idx); };
  // Recovery-by-success: a clean completion on a suspended rung clears it (e.g. after the
  // user /pivots back to it and it works).
  function noteSuccess(model) {
    const idx = modelToRungIndex(rungs, model);
    if (idx != null && suspended.has(idx)) { clearSuspension(idx); try { updateUi(); } catch { /* ignore */ } }
  }

  // Seam consumer: a rung failed → suspend it, unless that would strand the ladder
  // (never suspend the last rung). STICKY: a completion failure is class-blind and can't
  // be confirmed as recovered (unlike a reachability probe), so we do NOT auto-walk back
  // up to a stall-suspended rung — it stays out until the user runs /pivot online|auto or
  // a later completion on it succeeds. This is what prevents the bounce back to a
  // still-broken rung (and keeps the never-strand guard honest — a suspended rung stays
  // counted, so the fallback can't be suspended out from under us).
  disposers.push(failSeam.onFailure(({ rungId: model }) => {
    try {
      const idx = modelToRungIndex(rungs, model);
      if (idx == null) return; // off-ladder or mid-switch → don't suspend the wrong rung
      if (suspended.has(idx)) return; // already suspended → nothing to do
      if (!canSuspend(rungs.length, suspendedSet(), idx)) {
        announce(`⚠️ AutoPivot: all rungs failing — staying on ${model}. Run /pivot online to retry.`);
        return;
      }
      suspended.set(idx, { count: (suspended.get(idx)?.count ?? 0) + 1 });
      const next = computeView(null).desired;
      announce(`⚠️ AutoPivot: ${model} failed → now on ${next ?? "(no model)"}. Resend your message; /pivot online to retry.`);
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
  function computeView(activeModelId) {
    const mode = manual.mode();
    const resolved = resolveLadder(rungs, healthMap(), { manualMode: mode, suspended: suspendedSet() });
    const pendingInfo = mode === "auto" && reachability.isPending?.() ? reachability.pendingInfo() : null;
    let kind;
    if (mode === "offline") kind = "forced-offline";
    else if (mode === "online") kind = "forced-online";
    else if (pendingInfo) kind = "checking";
    else if (resolved.kind === "none-reachable") kind = "none-reachable";
    // A stall-suspension is active and we failed over to a working rung → "on fallback"
    // (reassuring, not alarming). Only when auto and not otherwise none-reachable.
    else if (mode === "auto" && suspended.size > 0) kind = "suspended";
    else if (resolved.isDegraded) kind = "offline";
    else if (config.reachability.probeUrl && reachability.isStale(staleMs)) kind = "unknown";
    else kind = "online";
    if (!config.primary) kind = "unconfigured"; // first-run: no primary set yet → run /pivot setup
    const ruleSignifier = config.rules.find((x) => x.modeLabel === resolved.modeLabel)?.signifier ?? null;
    return { kind, desired: resolved.model, actual: activeModelId, ruleSignifier, resolved, pendingInfo, warning: resolved.warning ?? null };
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
        const v = computeView(ctx?.model?.id);
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
      stallWatch.markStart({ callId: cidOf(event, ctx), model: event?.model ?? ctx?.model?.id });
      try { panel?.update?.(); } catch { /* ignore */ }
    }],
    ["llm_end", (event, ctx) => {
      stallWatch.markSettled(cidOf(event, ctx));
      const model = event?.model ?? ctx?.model?.id;
      const sr = event?.stopReason;
      // Opportunistic FAST PATH: if the failure surfaces as a final error message, report
      // it immediately (near-instant failover) instead of waiting for the stall timeout.
      // Smoke-gated — the probe capture saw no llm_end on a 401, so this may never fire.
      if (sr === "error" || sr === "aborted") { try { failSeam.report(model, "error"); } catch { /* ignore */ } }
      else noteSuccess(model); // a clean completion clears any suspension on this rung
    }],
    ["turn_end", (event, ctx) => { stallWatch.markSettled(cidOf(event, ctx)); }],
  ]) {
    try { disposers.push(letta.events.on(name, handler)); }
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
          if (arg === "online" || arg === "auto") { for (const idx of [...suspended.keys()]) clearSuspension(idx); }
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
