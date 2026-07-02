/**
 * AutoPivot — configurator core (pure, testable).
 *
 * Separated from the interactive CLI (configure.mjs) so the discovery and
 * config-assembly logic can be unit-tested without a TTY. All fs/fetch access is
 * injectable via `deps`.
 *
 * Auto-discovery makes the configurator plug-and-play: it reads letta's own
 * connected-provider config (no "what's your endpoint?" prompt) and derives the
 * reachability probe from the chosen primary model's provider.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const AUTH_PATH = () => join(homedir(), ".letta", "lc-local-backend", "providers", "auth.json");
const SETTINGS_PATH = () => join(homedir(), ".letta", "settings.json");

function readJson(path, deps) {
  try {
    const read = deps.readFile ?? ((p) => readFileSync(p, "utf8"));
    return JSON.parse(read(path));
  } catch { return null; }
}

const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url || "");

/**
 * Read letta's connected providers (BYOK + local). Returns
 * [{ name, baseUrl, key }] — the handle prefix is the provider `name`.
 */
export function discoverProviders(deps = {}) {
  const auth = readJson(deps.authPath ?? AUTH_PATH(), deps);
  const providers = auth?.providers && typeof auth.providers === "object" ? auth.providers : {};
  return Object.values(providers).map((p) => ({
    name: p?.name ?? p?.id ?? "provider",
    baseUrl: p?.base_url ?? "",
    key: p?.auth?.key ?? "",
  })).filter((p) => p.baseUrl);
}

/** Recently-used model handles (good "likely picks" to surface first). */
export function recentModels(deps = {}) {
  const s = readJson(deps.settingsPath ?? SETTINGS_PATH(), deps);
  return Array.isArray(s?.recentModels) ? s.recentModels : [];
}

/**
 * Discover available model handles by querying every connected provider's
 * /v1/models and prefixing ids with the provider name (`<name>/<id>`), unioned
 * with recentModels (listed first). Returns { handles, providers } so the caller
 * can also derive the probe. async because it hits the network.
 */
export async function discoverModels(deps = {}) {
  const providers = deps.providers ?? discoverProviders(deps);
  const recents = recentModels(deps);
  const handles = [...recents];
  for (const p of providers) {
    const ids = await fetchModels(p.baseUrl, p.key, deps); // bare ids
    for (const id of ids) {
      const handle = `${p.name}/${id}`;
      if (!handles.includes(handle)) handles.push(handle);
    }
  }
  return { handles, providers };
}

/**
 * Derive the reachability probe target from the chosen primary handle's provider.
 * Returns { url, isLocal, providerName }. `isLocal` true means the endpoint is a
 * localhost proxy that's always up → the caller should warn and ask for the real
 * upstream instead.
 */
export function deriveProbe(primaryHandle, providers) {
  const prefix = String(primaryHandle ?? "").split("/")[0];
  const p = (providers ?? []).find((x) => x.name === prefix);
  if (!p?.baseUrl) return { url: "", isLocal: false, providerName: prefix || null };
  const url = `${p.baseUrl.replace(/\/+$/, "")}/models`;
  return { url, isLocal: isLocalUrl(p.baseUrl), providerName: p.name };
}

/**
 * Fetch the model handles a provider exposes (the same list `/model` shows).
 * deps.fetch is injectable for tests. Returns [] on any failure (caller falls
 * back to manual entry).
 */
export async function fetchModels(baseUrl, apiKey, deps = {}) {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  try {
    // letta's provider base_url may ALREADY end in /v1 (e.g. http://host:4000/v1). Strip a
    // trailing /v1 (and slashes) before appending /v1/models, so we don't hit /v1/v1/models
    // — which 404s and silently collapses discovery to only recentModels (fewer models than
    // the /model picker shows).
    const base = baseUrl.replace(/\/+$/, "").replace(/\/v1$/i, "");
    const res = await fetchFn(`${base}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!res?.ok) return [];
    const body = await res.json();
    const ids = (body?.data ?? []).map((m) => m?.id).filter((s) => typeof s === "string" && s);
    // Hide the wildcard passthrough entry some proxies expose.
    return ids.filter((id) => id !== "*");
  } catch {
    return [];
  }
}

/**
 * Assemble a normalized config object from answers. The shape matches what
 * lib/config.mjs parseConfig validates; callers should validate before writing.
 */
export function buildConfig(a) {
  // Rungs below the primary, in order: an optional SECONDARY CLOUD fallback (used when
  // you're online but the primary cloud rate-limits/fails), then an optional LOCAL fallback
  // (the offline terminus). Either can be omitted. A primary-only ladder has no rules.
  const rules = [];
  // Secondary cloud: non-local, so with no own probe it inherits the brain probe (offline
  // gates it with the primary → the ladder falls through to local). Give it its own probe
  // only if it's a genuinely independent cloud endpoint. This is also the natural slot for
  // a cost fallback (a cheaper cloud model) later.
  if (a.cloudFallback) {
    const rule = {
      condition: "reachability",
      target: { model: a.cloudFallback, local: false },
      modeLabel: "cloud-fallback",
      isDegraded: false,
      statusDisplay: "near-threshold",
    };
    if (a.cloudFallbackProbeUrl) rule.reachability = { probeUrl: a.cloudFallbackProbeUrl };
    rules.push(rule);
  }
  if (a.offlineModel) {
    const target = { model: a.offlineModel, local: true };
    if (a.contextWindow) target.contextWindow = a.contextWindow;
    if (a.reasoningEffort) target.reasoningEffort = a.reasoningEffort;
    rules.push({
      condition: "reachability",
      target,
      modeLabel: "offline",
      isDegraded: true,
      statusDisplay: "near-threshold",
      signifier: { glyph: "○", color: "redBright", text: "offline", bold: true },
    });
  }

  return {
    primary: a.primary ?? null,
    rules,
    reachability: {
      probeUrl: a.probeUrl ?? "",
      intervalMs: a.intervalMs ?? 15000,
      failureThreshold: a.failureThreshold ?? 3,
      recoveryThreshold: a.recoveryThreshold ?? 2,
      probeTimeoutMs: a.probeTimeoutMs ?? 4000,
      confirmIntervalMs: a.confirmIntervalMs ?? 5000,
      probeAuthEnv: a.probeAuthEnv ?? "",
    },
    statusline: {
      replacePrimary: a.replacePrimary === true,
      showModeText: a.showModeText !== false,
      nearThresholdBand: a.nearThresholdBand ?? 0.8,
    },
    honesty: a.honesty === "every-turn" ? "every-turn" : "transition",
    memorySync: { enabled: a.memorySyncEnabled === true },
  };
}

// When we can't derive a specific brain endpoint (localhost proxy / unknown provider), we
// default the reachability probe to a neutral internet check. Rationale: the stall watchdog
// (Phase 3a) now catches provider-specific failures → cloud fallback, so reachability's
// remaining job is "am I online? → go local," which a neutral host answers. Users who want
// to detect a SPECIFIC server being down (not just the internet) point it there instead.
export const NEUTRAL_PROBE_URL = "https://1.1.1.1";

// Heuristic: does a model handle look like a LOCAL model? (used to auto-pick a fallback)
// Tested against the MODEL part (after the provider `/`), because a provider name like
// "ollama" is often a proxy relaying BOTH cloud and local models — so the prefix means
// nothing; the model name is the signal. Deliberately excludes provider names.
const LOCAL_MODEL_RE = /(local|qwen|glm|llama|mlx|mistral|gemma|phi\b|lmstudio|codestral)/i;
/** Best-GUESS whether a handle is a local model — a pre-check hint for the configurator's
 *  verify step, and the auto-pick for /pivot setup. Judged by the model name (after the
 *  provider `/`), since a proxy provider relays both cloud and local. Always user-verifiable. */
export const looksLocal = (handle) => LOCAL_MODEL_RE.test(String(handle).split("/").pop() ?? "");

/**
 * Assemble a best-guess STARTER config from auto-discovery (the `/pivot setup` path).
 * Picks: primary = your most-likely model (recents-first from discoverModels), fallback =
 * a local-looking model if one is present (marked `local:true`), probe = auto-derived from
 * the primary's provider (blank when that's a localhost/always-up endpoint, so it isn't a
 * useless probe). Returns { config, picks } — `picks` explains the guesses for the header
 * comment and the setup output. Returns null when discovery found no models. The result is
 * a STARTER: clearly labeled, meant to be refined. Validate before writing.
 */
export function buildStarterConfig({ handles = [], providers = [] } = {}) {
  if (!handles.length) return null;
  // `handles` is recents-first (usage history). Build the ladder from it:
  //   primary        = most-recent CLOUD model (your daily driver)
  //   cloudFallback  = 2nd-most-recent CLOUD model (used when the primary rate-limits/fails)
  //   offlineModel   = most-recent LOCAL model (the offline terminus)
  const cloud = handles.filter((h) => !looksLocal(h));
  const local = handles.filter((h) => looksLocal(h));
  const primary = cloud[0] ?? handles[0];
  const cloudFallback = cloud.find((h) => h !== primary) ?? null;
  const offlineModel = local[0] ?? null;
  const probe = deriveProbe(primary, providers);
  // Specific brain endpoint if we could derive one; else a neutral internet check so
  // offline→local works out of the box (rather than an always-up localhost probe or none).
  const probeUrl = (probe.isLocal || !probe.url) ? NEUTRAL_PROBE_URL : probe.url;
  const config = buildConfig({ primary, cloudFallback, offlineModel, probeUrl });
  return {
    config,
    picks: {
      primary,
      cloudFallback,                                // null → only one cloud model discovered
      fallback: offlineModel,                       // null → no local model found
      probeUrl,
      probeIsLocal: probe.isLocal,                  // true → user must point the probe at their real upstream
      providerCount: providers.length,
      modelCount: handles.length,
    },
  };
}
