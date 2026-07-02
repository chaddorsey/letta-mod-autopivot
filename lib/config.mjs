/**
 * AutoPivot — config loader.
 *
 * Loads the user's JSONC config (`~/.letta/mods/autopivot.config.json`) into a
 * fully-normalized object with sensible defaults. JSONC (JSON + `//` and `/* *​/`
 * comments) is used so the file the user edits is genuinely self-documenting —
 * plain JSON can't carry comments. (Plan Review #10.)
 *
 * Design notes for contributors:
 *  - `parseConfig(text)` is PURE (string in → {config, warnings} out) so it's
 *    trivially unit-testable; `loadConfig(path, deps)` is the thin file wrapper.
 *  - We never throw on bad input: a missing or malformed file yields safe defaults
 *    plus a human-readable warning the mod surfaces once. Trusted-local config, but
 *    we still fail soft so a typo can't wedge the agent.
 *  - No secrets live here. A probe that needs auth names an ENV VAR (`probeAuthEnv`);
 *    the token itself is never stored in the file (the file may be world-readable).
 *    (Plan Review #4.)
 */

// ---- Defaults (every field the rest of the mod may read) --------------------

// Per-mode signifiers for non-rule states. Each = { glyph, color, text }.
// Color + glyph + text together so meaning never rests on color alone (Review #5).
// Glyphs carry meaning by SHAPE as well as color (colorblind- and no-color-safe):
//   ● filled green = online   ◌ dotted amber = checking   ○ hollow red = offline
export const DEFAULT_SIGNIFIERS = {
  online: { glyph: "●", color: "green", text: "online" }, // standard green (greenBright is pale)
  unknown: { glyph: "◌", color: "gray", text: "checking" },
  checking: { glyph: "◌", color: "yellowBright", text: "checking" }, // retry/reconnect window
  forced: { glyph: "●", color: "yellowBright", text: "forced" }, // generic fallback
  forcedOnline: { glyph: "●", color: "yellowBright", text: "forced online" },
  forcedOffline: { glyph: "⊘", color: "#FFA500", text: "forced offline", bold: true }, // slashed dot, orange, bold
  noneReachable: { glyph: "⊗", color: "redBright", text: "no model", bold: true }, // nothing reachable (Phase 2 stranding guard)
  suspended: { glyph: "⚑", color: "yellow", text: "on fallback", bold: false }, // a rung stall-suspended; we failed over and are WORKING on a lower rung (Phase 3a) — not alarming
  unconfigured: { glyph: "⚙", color: "gray", text: "not configured" }, // no primary set → run /pivot setup (first-run onboarding)
};

export const DEFAULT_REACHABILITY = {
  // The probe URL MUST be your primary/brain endpoint (not a generic internet
  // check) so "online" tracks brain reachability. Empty by default → reachability
  // condition stays inert until configured.
  probeUrl: "",
  intervalMs: 20000, // steady-state probe cadence (relaxed; light on the network/battery)
  failureThreshold: 2, // consecutive failures before flipping to offline (hysteresis)
  recoveryThreshold: 2, // consecutive successes before flipping back online
  probeTimeoutMs: 4000, // a hung probe FAILS after this (fast offline detection)
  confirmIntervalMs: 5000, // re-probe quickly while a flip is pending → fast confirmation
  probeAuthEnv: "", // NAME of an env var holding a probe token, never the token
};

// Neutral NETWORK probe (Phase 1). Separate from `reachability` (the brain probe):
// reachability decides WHICH MODEL to run; networkProbe decides whether NETWORKED
// ACTIONS are available, which selects the honesty note variant. Point it at a
// neutral host you don't mind pinging (e.g. https://1.1.1.1 or https://example.com),
// NOT your provider — conflating "internet up" with "that provider up" is the bug
// Phase 1 fixes. Empty by default → action-availability is treated as unknown and
// the conservative offline/queue note is used (exactly v1 behavior).
export const DEFAULT_NETWORK_PROBE = {
  probeUrl: "",
  intervalMs: 20000,
  failureThreshold: 2,
  recoveryThreshold: 2,
  probeTimeoutMs: 4000,
  confirmIntervalMs: 5000,
  probeAuthEnv: "",
};

// Stall watchdog (Phase 3a). The failing-completion signal is an unmatched `llm_start`
// (no `llm_end`/`turn_end`) — detected purely by timeout, so `timeoutMs` MUST sit above
// legitimate slow turns. This especially matters for LOCAL models: a cold local turn can
// take minutes, so give local/fallback rungs a large per-rung `stall.timeoutMs` (a stall
// watchdog can't tell "slow" from "hung"). A stall suspension is STICKY — class-blind
// failures can't be confirmed as recovered, so a suspended rung stays out until you run
// `/pivot online` (or a later completion on it succeeds); there is no auto-retry timer,
// which is what avoids bouncing back onto a still-broken rung. Per-rung override via a
// rule's own `stall.timeoutMs`.
export const DEFAULT_STALL = {
  timeoutMs: 90000, // cloud default — no completion within this → suspend the rung
};

// Type-aware default (generalization): the automatic stall watchdog is for FAST-FAILING
// rungs — a cloud model that 401s / 429s / hangs cleanly, where a 90s non-completion is
// unambiguously broken. On a LOCAL rung it can't work: a stall watchdog can't tell "slow"
// from "hung," and a cold local turn legitimately takes minutes, so ANY automatic timeout
// is either a false-positive or a pointless multi-minute wait. So a local rung's automatic
// stall is DISABLED by default (0 = don't arm); the human is the right judge of a local
// hang and wields `/pivot down` to fail over instantly. Derived from the `local: true`
// flag users already set. A power user can set an explicit `stall.timeoutMs` on a local
// rung if they want an automatic backstop anyway.
export const LOCAL_STALL_TIMEOUT_MS = 0; // 0 = automatic stall disabled (use /pivot down)

export const DEFAULT_STATUSLINE = {
  replacePrimary: false, // false → additive line (order:-1), preserves host agent·model (Review #2)
  showModeText: true, // false → bare glyphs; a distinct offline glyph then carries meaning
  nearThresholdBand: 0.8, // metric shows when value ≥ band × ceiling (Review #5)
};

const DEFAULT_OFFLINE_SIGNIFIER = { glyph: "○", color: "redBright", text: "offline", bold: true }; // hollow red, bold
// When showModeText is false we fall back to a distinct glyph per state so shape
// distinguishes online vs offline without color or text.
export const NO_TEXT_GLYPHS = { online: "●", offline: "○" };

// Condition ids this build understands. Unknown ids are kept (pluggable) but warned.
const KNOWN_CONDITIONS = new Set(["reachability", "manual", "cost", "rateLimit"]);
const STATUS_DISPLAY = new Set(["always", "near-threshold", "never"]);

// ---- JSONC comment stripping (string-aware) ---------------------------------

/**
 * Remove `//` line and `/* *​/` block comments while respecting string literals,
 * so a URL like "http://host" inside a string is never mangled.
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") { out += next ?? ""; i++; continue; } // escaped char passes through
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    out += c;
  }
  return out;
}

// ---- Normalization ----------------------------------------------------------

function normalizeRule(rule, warnings, index) {
  const r = rule && typeof rule === "object" ? rule : {};
  if (!KNOWN_CONDITIONS.has(r.condition)) {
    warnings.push(`rule[${index}]: unknown condition "${r.condition}" (kept; not built in v1 unless it's reachability/manual)`);
  }
  const target = r.target && typeof r.target === "object" ? r.target : {};
  let statusDisplay = r.statusDisplay ?? "near-threshold";
  if (!STATUS_DISPLAY.has(statusDisplay)) {
    warnings.push(`rule[${index}]: invalid statusDisplay "${r.statusDisplay}" → "near-threshold"`);
    statusDisplay = "near-threshold";
  }
  const isDegraded = r.isDegraded === true; // default false
  const out = {
    condition: r.condition ?? null,
    target: {
      model: target.model ?? null,
      local: target.local === true, // marks a local/reachable target (used by the offline hard-gate)
      contextWindow: target.contextWindow ?? undefined,
      reasoningEffort: target.reasoningEffort ?? undefined,
    },
    modeLabel: r.modeLabel ?? (isDegraded ? "offline" : r.condition ?? "mode"),
    isDegraded,
    statusDisplay,
    signifier: normalizeSignifier(r.signifier, isDegraded),
  };
  // Optional PER-RUNG reachability probe (Phase 2): when a rule carries its own
  // probe, that rung walks by its OWN health (a true multi-rung ladder). Normalized
  // like the top-level reachability so each rung shares the probe knobs/defaults.
  // Absent → the rung has no probe → it's the always-available terminus (v1).
  if (r.reachability && typeof r.reachability === "object") {
    out.reachability = { ...DEFAULT_REACHABILITY, ...r.reachability };
  }
  // Per-rung stall timeout (Phase 3a). Explicit override wins; otherwise a LOCAL rung
  // gets the larger local default automatically (see LOCAL_STALL_TIMEOUT_MS), and a cloud
  // rung inherits the global default at resolve time (no per-rung entry needed).
  if (r.stall && typeof r.stall === "object" && r.stall.timeoutMs !== undefined) {
    out.stall = { timeoutMs: r.stall.timeoutMs };
  } else if (out.target.local === true) {
    out.stall = { timeoutMs: LOCAL_STALL_TIMEOUT_MS };
  }
  return out;
}

function normalizeSignifier(sig, isDegraded) {
  const base = isDegraded ? DEFAULT_OFFLINE_SIGNIFIER : DEFAULT_SIGNIFIERS.online;
  const s = sig && typeof sig === "object" ? sig : {};
  return {
    glyph: s.glyph ?? base.glyph,
    color: s.color ?? base.color,
    text: s.text ?? base.text,
    bold: s.bold ?? base.bold ?? false,
  };
}

/** Build the default config skeleton (used when the file is missing/unparseable). */
export function defaultConfig() {
  return {
    primary: null, // user must set their primary model handle
    rules: [],
    reachability: { ...DEFAULT_REACHABILITY },
    networkProbe: { ...DEFAULT_NETWORK_PROBE },
    stall: { ...DEFAULT_STALL },
    statusline: { ...DEFAULT_STATUSLINE },
    honesty: "transition", // inject the offline note once per degraded episode (Review #3)
    memorySync: { enabled: false }, // onReconnect callback is wired in code, not JSON
    signifiers: { ...DEFAULT_SIGNIFIERS },
  };
}

/** PURE: JSONC text → { config, warnings }. Never throws. */
export function parseConfig(text) {
  const warnings = [];
  let raw;
  try {
    raw = JSON.parse(stripJsonc(text));
  } catch (e) {
    warnings.push(`config is not valid JSONC (${e.message}); using defaults`);
    return { config: defaultConfig(), warnings };
  }
  if (!raw || typeof raw !== "object") {
    warnings.push("config root is not an object; using defaults");
    return { config: defaultConfig(), warnings };
  }
  const base = defaultConfig();
  const rules = Array.isArray(raw.rules)
    ? raw.rules.map((r, i) => normalizeRule(r, warnings, i))
    : [];
  if (!Array.isArray(raw.rules) && raw.rules !== undefined) {
    warnings.push("`rules` is not an array; treating as empty");
  }
  if (!raw.primary) warnings.push("no `primary` model handle set; routing will no-op until configured");

  const honesty = raw.honesty === "every-turn" ? "every-turn" : "transition";

  return {
    config: {
      primary: raw.primary ?? null,
      rules,
      reachability: { ...base.reachability, ...(raw.reachability ?? {}) },
      networkProbe: { ...base.networkProbe, ...(raw.networkProbe ?? {}) },
      stall: { ...base.stall, ...(raw.stall ?? {}) },
      statusline: { ...base.statusline, ...(raw.statusline ?? {}) },
      honesty,
      memorySync: { enabled: raw.memorySync?.enabled === true },
      signifiers: { ...base.signifiers, ...(raw.signifiers ?? {}) },
    },
    warnings,
  };
}

/**
 * Load + parse the config file. `deps.read(path)` is injectable for tests;
 * defaults to fs. A missing file is normal (→ defaults + warning), not an error.
 */
export async function loadConfig(path, deps = {}) {
  let read = deps.read;
  if (!read) {
    const { readFileSync } = await import("node:fs");
    read = (p) => readFileSync(p, "utf8");
  }
  let text;
  try {
    text = read(path);
  } catch {
    const config = defaultConfig();
    return { config, warnings: [`no config file at ${path}; using defaults`] };
  }
  return parseConfig(text);
}
