import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchModels, buildConfig, buildStarterConfig, looksLocal, discoverProviders, recentModels, discoverModels, deriveProbe } from "../lib/configure-core.mjs";
import { parseConfig } from "../lib/config.mjs";

const AUTH = JSON.stringify({
  version: 1,
  providers: { ollama: { name: "ollama", base_url: "http://127.0.0.1:4000/v1", auth: { key: "sk-local" } } },
});
const SETTINGS = JSON.stringify({ recentModels: ["ollama/mc-brain-local-qwen"] });
const readFile = (p) => (p.includes("auth.json") ? AUTH : SETTINGS);

function fakeFetch(status, data, seen) {
  return async (url, opts) => {
    if (seen) seen.push({ url, opts });
    return { ok: status >= 200 && status < 300, status, json: async () => ({ data }) };
  };
}

test("fetchModels returns ids, drops wildcard, hits /v1/models", async () => {
  const seen = [];
  const ids = await fetchModels("http://h:4000/", "k", { fetch: fakeFetch(200, [{ id: "mc-brain" }, { id: "qwen" }, { id: "*" }], seen) });
  assert.deepEqual(ids, ["mc-brain", "qwen"]); // wildcard filtered
  assert.equal(seen[0].url, "http://h:4000/v1/models"); // trailing slash normalized
  assert.equal(seen[0].opts.headers.Authorization, "Bearer k");
});

test("fetchModels: a base_url already ending in /v1 doesn't become /v1/v1/models", async () => {
  const seen = [];
  await fetchModels("http://127.0.0.1:4000/v1", "k", { fetch: fakeFetch(200, [{ id: "m" }], seen) });
  assert.equal(seen[0].url, "http://127.0.0.1:4000/v1/models"); // NOT .../v1/v1/models
});

test("fetchModels: no key → no auth header", async () => {
  const seen = [];
  await fetchModels("http://h:4000", "", { fetch: fakeFetch(200, [], seen) });
  assert.equal(seen[0].opts.headers?.Authorization, undefined);
});

test("fetchModels: non-ok or throw → [] (caller falls back to manual)", async () => {
  assert.deepEqual(await fetchModels("http://h", "k", { fetch: fakeFetch(401, []) }), []);
  assert.deepEqual(await fetchModels("http://h", "k", { fetch: async () => { throw new Error("ECONNREFUSED"); } }), []);
});

test("buildConfig produces a config that validates with no warnings", () => {
  const config = buildConfig({
    primary: "ollama/mc-brain",
    offlineModel: "ollama/qwen",
    contextWindow: 32000,
    probeUrl: "http://h:4000/health/liveliness",
    intervalMs: 15000,
    failureThreshold: 3,
    showModeText: true,
    replacePrimary: false,
  });
  const { config: parsed, warnings } = parseConfig(JSON.stringify(config));
  assert.equal(warnings.length, 0); // valid end to end
  assert.equal(parsed.primary, "ollama/mc-brain");
  assert.equal(parsed.rules[0].target.model, "ollama/qwen");
  assert.equal(parsed.rules[0].target.local, true);
  assert.equal(parsed.rules[0].target.contextWindow, 32000);
  assert.equal(parsed.reachability.failureThreshold, 3);
});

test("discoverProviders reads auth.json → name/baseUrl/key", () => {
  const ps = discoverProviders({ readFile });
  assert.deepEqual(ps, [{ name: "ollama", baseUrl: "http://127.0.0.1:4000/v1", key: "sk-local" }]);
});

test("recentModels reads settings.json", () => {
  assert.deepEqual(recentModels({ readFile }), ["ollama/mc-brain-local-qwen"]);
});

test("discoverModels: prefixes provider name, unions with recents (recents first)", async () => {
  const { handles } = await discoverModels({
    readFile,
    fetch: fakeFetch(200, [{ id: "mc-brain-local-qwen" }, { id: "gpt-5.5" }]),
  });
  // recentModels first, then provider-prefixed (deduped: qwen already present from recents)
  assert.deepEqual(handles, ["ollama/mc-brain-local-qwen", "ollama/gpt-5.5"]);
});

test("deriveProbe: remote provider → usable probe; localhost → flagged", () => {
  const remote = deriveProbe("anthropic/claude", [{ name: "anthropic", baseUrl: "https://api.anthropic.com/v1" }]);
  assert.equal(remote.url, "https://api.anthropic.com/v1/models");
  assert.equal(remote.isLocal, false);

  const local = deriveProbe("ollama/mc-brain", [{ name: "ollama", baseUrl: "http://127.0.0.1:4000/v1" }]);
  assert.equal(local.isLocal, true); // always-up local proxy → can't detect upstream
  assert.equal(local.url, "http://127.0.0.1:4000/v1/models");
});

test("deriveProbe: unknown provider → empty url, no crash", () => {
  assert.deepEqual(deriveProbe("mystery/model", []), { url: "", isLocal: false, providerName: "mystery" });
});

test("buildConfig: omits contextWindow when not given; honesty default", () => {
  const config = buildConfig({ primary: "p", offlineModel: "o", probeUrl: "http://h" });
  assert.equal(config.rules[0].target.contextWindow, undefined);
  assert.equal(config.honesty, "transition");
  assert.equal(config.memorySync.enabled, false);
});

test("buildConfig: no offlineModel → primary-only ladder (empty rules)", () => {
  const config = buildConfig({ primary: "p", probeUrl: "http://h" });
  assert.deepEqual(config.rules, []);
  assert.equal(config.primary, "p");
});

test("buildStarterConfig: builds the primary → secondary-cloud → local ladder from history", () => {
  const { config, picks } = buildStarterConfig({
    handles: ["anthropic/claude", "openai/gpt", "ollama/qwen"], // recents-first: 2 cloud, 1 local
    providers: [{ name: "anthropic", baseUrl: "https://api.anthropic.com/v1" }],
  });
  assert.equal(picks.primary, "anthropic/claude");       // most-recent cloud
  assert.equal(picks.cloudFallback, "openai/gpt");       // 2nd-most-recent cloud
  assert.equal(picks.fallback, "ollama/qwen");           // most-recent local
  assert.equal(picks.probeUrl, "https://api.anthropic.com/v1/models");
  const { warnings, config: parsed } = parseConfig(JSON.stringify(config));
  assert.equal(warnings.length, 0);
  assert.equal(parsed.primary, "anthropic/claude");
  // rung order: secondary cloud (non-local), then local terminus.
  assert.equal(parsed.rules[0].target.model, "openai/gpt");
  assert.equal(parsed.rules[0].target.local, false);
  assert.equal(parsed.rules[1].target.model, "ollama/qwen");
  assert.equal(parsed.rules[1].target.local, true);
});

test("buildStarterConfig: primary = most-recent CLOUD (skips a more-recent local); fallback = most-recent local", () => {
  const { picks } = buildStarterConfig({
    handles: ["ollama/qwen-local", "anthropic/claude", "ollama/glm-local"], // recents-first; local is #1
    providers: [{ name: "anthropic", baseUrl: "https://api.anthropic.com/v1" }],
  });
  assert.equal(picks.primary, "anthropic/claude");   // skipped the local qwen at index 0
  assert.equal(picks.fallback, "ollama/qwen-local"); // most-recent local
});

test("buildStarterConfig: two cloud, no local → primary + secondary-cloud, no local rung", () => {
  const { config, picks } = buildStarterConfig({
    handles: ["openai/gpt", "anthropic/claude"],
    providers: [{ name: "openai", baseUrl: "https://api.openai.com/v1" }],
  });
  assert.equal(picks.primary, "openai/gpt");
  assert.equal(picks.cloudFallback, "anthropic/claude");
  assert.equal(picks.fallback, null);                 // no local
  assert.equal(config.rules.length, 1);               // just the cloud fallback
  assert.equal(config.rules[0].target.model, "anthropic/claude");
  assert.equal(config.rules[0].target.local, false);
});

test("buildStarterConfig: single cloud only → primary-only ladder (no rules)", () => {
  const { config, picks } = buildStarterConfig({
    handles: ["openai/gpt"],
    providers: [{ name: "openai", baseUrl: "https://api.openai.com/v1" }],
  });
  assert.equal(picks.cloudFallback, null);
  assert.equal(picks.fallback, null);
  assert.deepEqual(config.rules, []);
});

test("buildStarterConfig: localhost primary → neutral internet probe (not the always-up localhost proxy)", () => {
  const { picks } = buildStarterConfig({
    handles: ["ollama/mc-brain", "ollama/local-qwen"],
    providers: [{ name: "ollama", baseUrl: "http://127.0.0.1:4000/v1" }],
  });
  assert.equal(picks.probeUrl, "https://1.1.1.1"); // neutral "am I online" default, not the always-up proxy
  assert.equal(picks.probeIsLocal, true);          // → setup output notes it + how to point at a specific server
});

test("buildStarterConfig: 'local' is judged by the MODEL name, not the provider prefix", () => {
  // A proxy provider (e.g. "ollama") can relay BOTH cloud and local models, so the
  // prefix must NOT make a cloud-relay model look local. Only the model part counts.
  const { picks } = buildStarterConfig({
    handles: ["ollama/mc-brain", "ollama/gpt-5.5", "ollama/mc-brain-local-qwen"],
    providers: [{ name: "ollama", baseUrl: "http://127.0.0.1:4000/v1" }],
  });
  assert.equal(picks.fallback, "ollama/mc-brain-local-qwen"); // the genuine local model, not ollama/gpt-5.5
});

test("buildStarterConfig: no models → null (caller falls back to the configurator)", () => {
  assert.equal(buildStarterConfig({ handles: [], providers: [] }), null);
});

test("looksLocal: judges the model name (after the provider prefix), not the provider", () => {
  assert.equal(looksLocal("ollama/mc-brain-local-qwen"), true);  // qwen/local
  assert.equal(looksLocal("lmstudio/glm-4.5-air"), true);        // glm
  assert.equal(looksLocal("ollama/gpt-5.5"), false);             // proxy prefix ≠ local
  assert.equal(looksLocal("anthropic/claude-opus-4-8"), false);
  assert.equal(looksLocal("openai/llama-guard"), true);          // llama
});
