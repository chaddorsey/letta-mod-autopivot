/**
 * AutoPivot — statusline rendering (pure).
 *
 * Renders the mode pill + active model + optional metric. Default panel order is
 * -1 (additive — preserves the host's built-in agent·model line); index.mjs only
 * uses order:0 (replace) when the user opts in (Plan Review #2).
 *
 * Accessibility (Review #5): meaning never rests on color alone. With text on
 * (default) every state shows a word; with text OFF, online/offline use distinct
 * GLYPHS (● vs ○) so shape still distinguishes them. `chalk` is injected by the
 * host render context; tests pass an identity chalk to assert on plain text.
 *
 * Pill states: "online" | "offline" | "forced" | "unknown" | "none-reachable".
 *   - online        : primary / not degraded
 *   - offline       : a degraded rule is active (uses that rule's signifier)
 *   - forced        : manual override in force (distinct marker so a stuck override is obvious)
 *   - unknown       : reachability hasn't produced a confirmed reading yet (probe warmup)
 *   - none-reachable: no rung is reachable and there's no local terminus — we did NOT
 *                     strand on a dead model (Phase 2 stranding guard, R4)
 */
import { NO_TEXT_GLYPHS } from "./config.mjs";

function colorize(chalk, color, text, bold) {
  if (!chalk) return text;
  // Support hex colors (e.g. "#FFA500" orange) via chalk.hex, since chalk has no
  // named "orange"; fall back to named colors ("green", "redBright", …).
  let styler;
  if (typeof color === "string" && color.startsWith("#") && typeof chalk.hex === "function") styler = chalk.hex(color);
  else if (typeof chalk[color] === "function") styler = chalk[color];
  else styler = (s) => s;
  if (bold && styler && typeof styler.bold === "function") styler = styler.bold; // thicken thin glyphs
  return styler(text);
}

/** Resolve the {glyph,color,text} to show for a pill kind, honoring showModeText. */
export function resolveSignifier(kind, cfg, ruleSignifier) {
  let sig;
  if (kind === "offline") sig = ruleSignifier ?? { glyph: "○", color: "redBright", text: "offline" };
  else if (kind === "checking") sig = cfg.signifiers.checking;
  else if (kind === "forced-offline") sig = cfg.signifiers.forcedOffline;
  else if (kind === "forced-online") sig = cfg.signifiers.forcedOnline;
  else if (kind === "forced") sig = cfg.signifiers.forced;
  else if (kind === "unknown") sig = cfg.signifiers.unknown;
  else if (kind === "none-reachable") sig = cfg.signifiers.noneReachable;
  else if (kind === "suspended") sig = cfg.signifiers.suspended;
  else if (kind === "unconfigured") sig = cfg.signifiers.unconfigured;
  else sig = cfg.signifiers.online;

  if (!cfg.statusline.showModeText) {
    // Bare glyph — keep online/offline shapes distinct so color isn't the only cue.
    const glyph =
      kind === "offline" ? NO_TEXT_GLYPHS.offline
      : kind === "online" ? NO_TEXT_GLYPHS.online
      : sig.glyph;
    return { glyph, color: sig.color, text: "" };
  }
  return { glyph: sig.glyph, color: sig.color, text: sig.text };
}

/**
 * Render the left pill segment: colored glyph + (text) + active model.
 * @param {{kind, model, ruleSignifier?}} view
 */
export function renderPill(view, cfg, chalk) {
  const sig = resolveSignifier(view.kind, cfg, view.ruleSignifier);
  const dot = colorize(chalk, sig.color, sig.glyph, sig.bold);
  // During the retry window, show "checking N/M" (dropping) or "reconnecting N/M"
  // (recovering) so the user sees active polling, Google-Docs style.
  let text = sig.text;
  if (view.kind === "checking" && view.checking && cfg.statusline.showModeText) {
    const verb = view.checking.direction === "online" ? "reconnecting" : "checking";
    text = `${verb} ${view.checking.attempt}/${view.checking.threshold}`;
  }
  const label = text ? " " + text : "";
  const model = view.model ? " " + view.model : "";
  return dot + label + model;
}

/**
 * Render the right metric segment from active/always conditions.
 * @param {Array<{metric: Function, statusDisplay: string}>} entries
 * @returns {string} "" when nothing qualifies.
 */
export function metricSegment(entries) {
  const parts = [];
  for (const e of entries ?? []) {
    if (e.statusDisplay === "never") continue;
    const m = typeof e.metric === "function" ? e.metric() : null;
    if (!m) continue;
    const show = e.statusDisplay === "always" || (e.statusDisplay === "near-threshold" && m.nearThreshold);
    if (!show) continue;
    const val = m.ceiling != null && isFinite(m.ceiling) ? `${fmt(m.value)}/${fmt(m.ceiling)}` : `${fmt(m.value)}`;
    parts.push(`${m.label} ${val}`);
  }
  return parts.join(" · ");
}

function fmt(n) {
  if (typeof n !== "number") return String(n);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
