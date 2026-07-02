import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseConfig,
  loadConfig,
  defaultConfig,
  stripJsonc,
} from "../lib/config.mjs";

// ---- Unit 2: networkProbe (neutral action-availability probe) --------------

test("networkProbe absent → defaults present, empty probeUrl, no warning", () => {
  const { config, warnings } = parseConfig(JSON.stringify({ primary: "p", reachability: { probeUrl: "https://h" } }));
  assert.ok(config.networkProbe, "networkProbe block always present");
  assert.equal(config.networkProbe.probeUrl, ""); // empty → tri-state null → v1 behavior
  assert.equal(config.networkProbe.failureThreshold, 2); // default merged
  assert.ok(!warnings.some((w) => /networkProbe/i.test(w)), "no networkProbe warning when absent");
});

test("networkProbe present → merged with defaults", () => {
  const { config } = parseConfig(JSON.stringify({
    primary: "p",
    networkProbe: { probeUrl: "https://1.1.1.1", intervalMs: 30000 },
  }));
  assert.equal(config.networkProbe.probeUrl, "https://1.1.1.1");
  assert.equal(config.networkProbe.intervalMs, 30000); // overridden
  assert.equal(config.networkProbe.probeTimeoutMs, 4000); // default kept
});

test("defaultConfig includes a networkProbe skeleton", () => {
  assert.ok(defaultConfig().networkProbe);
  assert.equal(defaultConfig().networkProbe.probeUrl, "");
});

test("stall block (Phase 3a): default present when absent; global + per-rule override parsed", () => {
  const { config: c1 } = parseConfig(JSON.stringify({ primary: "p" }));
  assert.equal(c1.stall.timeoutMs, 90000); // cloud default

  const { config: c2 } = parseConfig(JSON.stringify({
    primary: "p",
    stall: { timeoutMs: 45000 },
    rules: [{ condition: "reachability", target: { model: "ollama/local", local: true }, isDegraded: true, stall: { timeoutMs: 200000 } }],
  }));
  assert.equal(c2.stall.timeoutMs, 45000);           // global override
  assert.equal(c2.rules[0].stall.timeoutMs, 200000); // explicit per-rule override wins
});

test("generalization: a LOCAL rung has automatic stall DISABLED by default (use /pivot down); cloud inherits the global default", () => {
  const { config } = parseConfig(JSON.stringify({
    primary: "cloud/primary",
    rules: [
      { condition: "reachability", target: { model: "ollama/local", local: true }, isDegraded: true }, // local, no stall set
      { condition: "reachability", target: { model: "openai/backup" }, isDegraded: true, reachability: { probeUrl: "https://b/h" } }, // cloud, no stall
    ],
  }));
  assert.equal(config.rules[0].stall.timeoutMs, 0);  // local → auto-stall OFF (a watchdog can't tell slow from hung; human wields /pivot down)
  assert.equal(config.rules[1].stall, undefined);    // cloud → inherits the global 90s default at resolve time
});

test("per-rule reachability probe (Phase 2): normalized when present, omitted when absent", () => {
  const { config } = parseConfig(JSON.stringify({
    primary: "p",
    rules: [
      { condition: "reachability", target: { model: "openai/backup" }, isDegraded: true, reachability: { probeUrl: "https://backup/health", intervalMs: 30000 } },
      { condition: "reachability", target: { model: "ollama/local", local: true }, isDegraded: true },
    ],
  }));
  // rule 0 carries its own probe (merged with defaults)
  assert.equal(config.rules[0].reachability.probeUrl, "https://backup/health");
  assert.equal(config.rules[0].reachability.intervalMs, 30000);
  assert.equal(config.rules[0].reachability.failureThreshold, 2); // default merged
  // rule 1 has no probe → terminus
  assert.equal(config.rules[1].reachability, undefined);
});

test("stripJsonc removes comments but preserves URLs inside strings", () => {
  const text = `{
    // line comment
    "probeUrl": "https://host/health", /* block */
    "x": 1 // trailing
  }`;
  const obj = JSON.parse(stripJsonc(text));
  assert.equal(obj.probeUrl, "https://host/health"); // the // in https:// must survive
  assert.equal(obj.x, 1);
});

test("happy path: well-formed config normalizes with defaults filled", () => {
  const { config, warnings } = parseConfig(JSON.stringify({
    primary: "anthropic/claude",
    rules: [{ condition: "reachability", target: { model: "ollama/local", local: true }, isDegraded: true }],
    reachability: { probeUrl: "https://h/health" },
  }));
  assert.equal(config.primary, "anthropic/claude");
  assert.equal(config.rules.length, 1);
  const r = config.rules[0];
  assert.equal(r.target.model, "ollama/local");
  assert.equal(r.target.local, true);
  assert.equal(r.statusDisplay, "near-threshold"); // default filled
  assert.deepEqual(r.signifier, { glyph: "○", color: "redBright", text: "offline", bold: true }); // degraded default (hollow red, bold)
  assert.equal(config.reachability.failureThreshold, 2); // default merged
  assert.equal(config.reachability.probeTimeoutMs, 4000); // fail-fast default present
  assert.equal(config.statusline.replacePrimary, false); // additive default
  assert.equal(config.honesty, "transition");
  assert.equal(warnings.length, 0);
});

test("edge: empty rules → primary-only, no warnings about rules", () => {
  const { config } = parseConfig(JSON.stringify({ primary: "m", rules: [] }));
  assert.deepEqual(config.rules, []);
  assert.equal(config.primary, "m");
});

test("edge: missing primary warns but does not throw", () => {
  const { config, warnings } = parseConfig(JSON.stringify({ rules: [] }));
  assert.equal(config.primary, null);
  assert.ok(warnings.some((w) => /primary/.test(w)));
});

test("error: malformed JSONC → defaults + warning, never throws", () => {
  const { config, warnings } = parseConfig("{ not valid json ");
  assert.deepEqual(config, defaultConfig());
  assert.ok(warnings.some((w) => /not valid JSONC/.test(w)));
});

test("error: non-object root → defaults + warning", () => {
  const { config, warnings } = parseConfig("42");
  assert.deepEqual(config, defaultConfig());
  assert.ok(warnings.some((w) => /not an object/.test(w)));
});

test("edge: unknown condition id is kept but warned", () => {
  const { config, warnings } = parseConfig(JSON.stringify({
    primary: "m",
    rules: [{ condition: "phase-of-moon", target: { model: "x" } }],
  }));
  assert.equal(config.rules[0].condition, "phase-of-moon");
  assert.ok(warnings.some((w) => /unknown condition/.test(w)));
});

test("edge: invalid statusDisplay falls back to near-threshold with a warning", () => {
  const { config, warnings } = parseConfig(JSON.stringify({
    primary: "m",
    rules: [{ condition: "reachability", target: { model: "x" }, statusDisplay: "sometimes" }],
  }));
  assert.equal(config.rules[0].statusDisplay, "near-threshold");
  assert.ok(warnings.some((w) => /invalid statusDisplay/.test(w)));
});

test("edge: rules not an array → treated as empty + warning", () => {
  const { config, warnings } = parseConfig(JSON.stringify({ primary: "m", rules: { not: "array" } }));
  assert.deepEqual(config.rules, []);
  assert.ok(warnings.some((w) => /not an array/.test(w)));
});

test("loadConfig: missing file → defaults + warning (injected reader throws)", async () => {
  const { config, warnings } = await loadConfig("/nope/autopivot.config.json", {
    read: () => { throw new Error("ENOENT"); },
  });
  assert.deepEqual(config, defaultConfig());
  assert.ok(warnings.some((w) => /no config file/.test(w)));
});

test("loadConfig: reads via injected reader and parses", async () => {
  const { config } = await loadConfig("/x", {
    read: () => `{ "primary": "ollama/local" /* mine */ }`,
  });
  assert.equal(config.primary, "ollama/local");
});
