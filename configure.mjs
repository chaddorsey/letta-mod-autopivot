#!/usr/bin/env node
/**
 * AutoPivot — interactive configurator (menu hub).
 *
 *   npx letta-mod-autopivot configure      (or: npm run configure)
 *   ── run in a REAL terminal (it's interactive; won't work piped/headless) ──
 *
 * A top-menu picker (like Claude Code's option screens): each row is a config field
 * showing its current value; pick one to edit, and you always land back at the menu, so
 * you can set fields in any order, review, and back out. Ctrl-C (or Esc) inside a field
 * bounces you back to the menu; Save writes, Cancel discards.
 *
 * Model entry is a `search` (autocomplete over your discovered models, or type a custom
 * handle). "Which models are local?" is a checkbox you verify — auto-detecting local is
 * unreliable (a proxy relays both cloud and local), and that flag gates the offline
 * profile. Discovery, probe-derivation, and validation reuse lib/configure-core.mjs.
 */
import { select, input, number, confirm, search, checkbox, Separator } from "@inquirer/prompts";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";
import { parseConfig } from "./lib/config.mjs";
import { buildConfig, discoverModels, deriveProbe, looksLocal, NEUTRAL_PROBE_URL } from "./lib/configure-core.mjs";

const CONFIG_PATH = join(homedir(), ".letta", "mods", "autopivot.config.json");
const PAGE = 20; // show long model lists without truncation

// Enable keypress events so we can catch Esc. inquirer puts stdin in raw mode while a
// prompt is active, so keypress events flow during prompts.
if (process.stdin.isTTY) readline.emitKeypressEvents(process.stdin);

const BACK = Symbol("back"); // returned by ask() when the user hits Esc / Ctrl-C

/**
 * Run an inquirer prompt with **Esc = go back**: an Escape (or Ctrl-C) aborts the prompt
 * (via its AbortSignal) and returns the BACK sentinel instead of a value, so callers can
 * bail to the menu. This is the only way to get Esc-to-back — the high-level prompts don't
 * expose it; only Ctrl-C throws, and Esc is otherwise swallowed.
 */
async function ask(promptFn, config) {
  const ac = new AbortController();
  const onKey = (_s, key) => { if (key?.name === "escape") ac.abort(); };
  process.stdin.on("keypress", onKey);
  try {
    return await promptFn(config, { signal: ac.signal });
  } catch (e) {
    if (e?.name === "AbortPromptError" || e?.name === "ExitPromptError") return BACK;
    throw e;
  } finally {
    process.stdin.removeListener("keypress", onKey);
  }
}

const shown = (v) => (v == null || v === "" ? "—" : Array.isArray(v) ? (v.length ? v.join(", ") : "—") : String(v));

/** Autocomplete model entry (search): TYPE TO FILTER your discovered models, or type a custom handle. */
function modelSearchConfig(message, models, def) {
  return {
    message: `${message} — type to search${def ? `  [current: ${def}]` : ""}:`,
    pageSize: PAGE,
    source: async (term) => {
      const t = String(term ?? "").toLowerCase();
      const matches = models.filter((m) => m.toLowerCase().includes(t));
      const choices = matches.map((m) => ({ name: m, value: m }));
      if (term && !models.includes(term)) choices.unshift({ name: `› use "${term}" (custom handle)`, value: term });
      return choices.length ? choices : models.map((m) => ({ name: m, value: m }));
    },
  };
}

function seedState(cur, models, providers) {
  const cloudModels = models.filter((m) => !looksLocal(m));
  const primary = cur?.primary ?? cloudModels[0] ?? models[0] ?? null;
  const probe = deriveProbe(primary, providers);
  const localRule = (cur?.rules ?? []).find((r) => r?.target?.local);
  const cloudRule = (cur?.rules ?? []).find((r) => r?.target && !r.target.local);
  const seededLocal = (cur?.rules ?? []).filter((r) => r?.target?.local).map((r) => r.target.model);
  return {
    primary,
    cloudFallback: cloudRule?.target?.model ?? cloudModels.find((m) => m !== primary) ?? null, // 2nd-most-recent cloud
    localSet: new Set(seededLocal.length ? seededLocal : models.filter(looksLocal)),
    offlineModel: localRule?.target?.model ?? null,
    contextWindow: localRule?.target?.contextWindow,
    probeUrl: cur?.reachability?.probeUrl || (probe.isLocal || !probe.url ? NEUTRAL_PROBE_URL : probe.url),
    probeIsLocal: probe.isLocal,
    intervalMs: cur?.reachability?.intervalMs ?? 15000,
    failureThreshold: cur?.reachability?.failureThreshold ?? 3,
    showModeText: cur?.statusline?.showModeText ?? true,
    replacePrimary: cur?.statusline?.replacePrimary ?? false,
    honesty: cur?.honesty ?? "transition",
  };
}

const toConfig = (s) => buildConfig({
  primary: s.primary, cloudFallback: s.cloudFallback, offlineModel: s.offlineModel, contextWindow: s.contextWindow,
  probeUrl: s.probeUrl, intervalMs: s.intervalMs, failureThreshold: s.failureThreshold,
  showModeText: s.showModeText, replacePrimary: s.replacePrimary, honesty: s.honesty,
});

// ---- field editors (Esc in any prompt → BACK, leaving that field unchanged) --

async function editPrimary(s, models) {
  const v = await ask(search, modelSearchConfig("Primary (online) model", models, s.primary));
  if (v !== BACK) s.primary = v;
}

async function editCloudFallback(s, models) {
  // Non-local models (per your verified local set) other than the primary. Used when you're
  // online but the primary rate-limits/fails; it shares the brain probe, so offline it's
  // skipped along with the primary and the ladder falls through to local.
  const pool = models.filter((m) => !s.localSet.has(m) && m !== s.primary);
  const choices = [...pool.map((m) => ({ name: m, value: m })), new Separator(), { name: "(none — no secondary cloud)", value: null }];
  const v = await ask(select, { message: "Secondary cloud fallback (on primary rate-limit/failure while online)", pageSize: PAGE, choices, default: s.cloudFallback ?? null });
  if (v !== BACK) s.cloudFallback = v;
}

async function editLocal(s, models) {
  if (!models.length) return;
  const v = await ask(checkbox, {
    message: "Check which models are LOCAL (space toggles; pre-checked = our guess — verify):",
    pageSize: PAGE,
    choices: models.map((m) => ({ name: m, value: m, checked: s.localSet.has(m) })),
  });
  if (v === BACK) return;
  s.localSet = new Set(v);
  if (s.offlineModel && !s.localSet.has(s.offlineModel)) s.offlineModel = null; // stale fallback → clear
}

async function editFallback(s, models) {
  const pool = s.localSet.size ? [...s.localSet].filter((m) => m !== s.primary) : models.filter((m) => m !== s.primary);
  if (!pool.length) { console.log("  (no eligible model — mark a local model first)"); return; }
  const choices = [...pool.map((m) => ({ name: m, value: m })), { name: "(none — primary-only ladder)", value: null }];
  const v = await ask(select, { message: "Offline / local fallback model", pageSize: PAGE, choices, default: s.offlineModel ?? pool[0] });
  if (v === BACK) return;
  s.offlineModel = v;
  if (s.offlineModel) {
    const cw = await ask(number, { message: "Offline context window in tokens (blank = model default):", required: false, default: s.contextWindow });
    if (cw !== BACK) s.contextWindow = cw;
  }
}

async function editProbe(s) {
  if (s.probeIsLocal) console.log(`  ⚠ couldn't derive a specific endpoint (localhost proxy) → defaulting to an internet check (${NEUTRAL_PROBE_URL}), which handles "offline → go local." For a SPECIFIC server (detect that box being down), enter its URL instead.`);
  const url = await ask(input, { message: "Reachability probe URL (returns <500 when your brain is reachable):", default: s.probeUrl || undefined });
  if (url === BACK) return; s.probeUrl = url;
  const iv = await ask(number, { message: "Steady probe interval (ms):", default: s.intervalMs });
  if (iv === BACK) return; s.intervalMs = iv;
  const ft = await ask(number, { message: "Failed probes before going offline:", default: s.failureThreshold });
  if (ft !== BACK) s.failureThreshold = ft;
}

async function editOptions(s) {
  const a = await ask(confirm, { message: "Show mode text on the pill (e.g. 'offline')?", default: s.showModeText });
  if (a === BACK) return; s.showModeText = a;
  const b = await ask(confirm, { message: "Replace the host's agent·model statusline line (vs an additive line)?", default: s.replacePrimary });
  if (b === BACK) return; s.replacePrimary = b;
  const c = await ask(confirm, { message: "Inject the honest-offline note only on transition (vs every offline turn)?", default: s.honesty === "transition" });
  if (c !== BACK) s.honesty = c ? "transition" : "every-turn";
}

async function saveConfig(s) {
  const config = toConfig(s);
  const { warnings } = parseConfig(JSON.stringify(config));
  console.log("\nConfig preview:\n" + JSON.stringify(config, null, 2));
  if (warnings.length) { console.log("\n⚠ validation warnings:"); for (const w of warnings) console.log("  - " + w); }
  const ok = await ask(confirm, { message: `Write to ${CONFIG_PATH}?`, default: true });
  if (ok === BACK || !ok) return false;
  if (existsSync(CONFIG_PATH)) { copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`); console.log(`Backed up existing → ${CONFIG_PATH}.bak`); }
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  console.log(`\n✓ Wrote ${CONFIG_PATH}\n  Run /reload in your Letta Code TUI to apply.\n`);
  return true;
}

async function main() {
  console.log("\nAutoPivot configurator\n──────────────────────");
  let cur = null;
  if (existsSync(CONFIG_PATH)) {
    try { cur = parseConfig(readFileSync(CONFIG_PATH, "utf8")).config; console.log(`Editing existing config (${CONFIG_PATH})`); } catch { /* ignore */ }
  }
  console.log("Discovering your models from connected providers…");
  const { handles: models, providers } = await discoverModels();
  console.log(models.length ? `Found ${models.length} model(s) across ${providers.length} provider(s).` : "No models auto-discovered — you can type handles manually.");
  const s = seedState(cur, models, providers);

  // ── Guided first pass: walk the ladder fields in order, then land in the menu with the
  //    cursor on Save (so you review the full set first, then Enter to save — or edit more).
  //    (Esc/Ctrl-C in any field just skips it — leaving the seeded value — and moves on.)
  console.log("(Tip: Esc or Ctrl-C skips/backs out of a field.)\n");
  await editPrimary(s, models);
  await editCloudFallback(s, models);
  await editLocal(s, models);
  await editFallback(s, models);
  await editProbe(s);

  // ── Menu hub: review the values, Save (pre-highlighted), or edit any field. Esc = cancel. ──
  for (;;) {
    const choice = await ask(select, {
      message: "Review — Save (highlighted), or edit any field:",
      pageSize: PAGE,
      default: "save",
      choices: [
        { name: `Primary model      ${shown(s.primary)}`, value: "primary" },
        { name: `Cloud fallback     ${shown(s.cloudFallback)}`, value: "cloudfb" },
        { name: `Local models       ${shown([...s.localSet])}`, value: "local" },
        { name: `Offline fallback   ${shown(s.offlineModel)}`, value: "fallback" },
        { name: `Reachability probe ${shown(s.probeUrl)}`, value: "probe" },
        { name: `Options            text:${s.showModeText} replace:${s.replacePrimary} honesty:${s.honesty}`, value: "options" },
        new Separator(),
        { name: "✓ Save & write config", value: "save" },
        { name: "✗ Cancel (discard)", value: "cancel" },
      ],
    });
    if (choice === BACK || choice === "cancel") { console.log("Cancelled — nothing written."); return; }
    if (choice === "save") { if (await saveConfig(s)) return; else continue; }
    if (choice === "primary") await editPrimary(s, models);
    else if (choice === "cloudfb") await editCloudFallback(s, models);
    else if (choice === "local") await editLocal(s, models);
    else if (choice === "fallback") await editFallback(s, models);
    else if (choice === "probe") await editProbe(s);
    else if (choice === "options") await editOptions(s);
  }
}

main().catch((e) => {
  if (e?.name === "ExitPromptError") { console.log("\nCancelled."); process.exit(0); } // Ctrl-C at the menu
  console.error("Error:", e?.message ?? e);
  process.exit(1);
});
