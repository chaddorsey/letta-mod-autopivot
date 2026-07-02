import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, resolveLadder, buildRungs } from "../lib/resolver.mjs";

const reach = {
  condition: "reachability",
  target: { model: "ollama/local", local: true, contextWindow: 32000 },
  modeLabel: "offline", isDegraded: true,
};
const cost = {
  condition: "cost",
  target: { model: "openai/cheaper-cloud", local: false }, // a non-local target
  modeLabel: "budget", isDegraded: false,
};

test("no active conditions → primary, not degraded", () => {
  const r = resolve([reach], [], "anthropic/primary");
  assert.equal(r.model, "anthropic/primary");
  assert.equal(r.isDegraded, false);
  assert.equal(r.modeLabel, "primary");
});

test("only reachability active → its target + perMode, degraded", () => {
  const r = resolve([reach], ["reachability"], "anthropic/primary");
  assert.equal(r.model, "ollama/local");
  assert.equal(r.isDegraded, true);
  assert.deepEqual(r.perMode, { contextWindow: 32000 });
});

test("hard gate: cost rule above reachability, both active, offline → cost skipped (unreachable), reachability wins", () => {
  // cost is ordered FIRST and active, but its cloud target is ineligible while offline.
  const r = resolve([cost, reach], ["cost", "reachability"], "anthropic/primary");
  assert.equal(r.model, "ollama/local"); // not the cloud cost target
  assert.equal(r.matchedCondition, "reachability");
});

test("cost rule wins when online (reachability not active)", () => {
  const r = resolve([cost, reach], ["cost"], "anthropic/primary");
  assert.equal(r.model, "openai/cheaper-cloud");
  assert.equal(r.matchedCondition, "cost");
});

test("active condition with no matching rule → primary", () => {
  const r = resolve([reach], ["cost"], "anthropic/primary"); // cost active but no cost rule
  assert.equal(r.model, "anthropic/primary");
});

test("perMode carries contextWindow and reasoningEffort", () => {
  const rule = { condition: "reachability", target: { model: "m", local: true, contextWindow: 8000, reasoningEffort: "low" }, modeLabel: "offline", isDegraded: true };
  const r = resolve([rule], ["reachability"], "p");
  assert.deepEqual(r.perMode, { contextWindow: 8000, reasoningEffort: "low" });
});

test("manual online → primary even if reachability active", () => {
  const r = resolve([reach], ["reachability"], "anthropic/primary", { manualMode: "online" });
  assert.equal(r.model, "anthropic/primary");
  assert.equal(r.modeLabel, "primary");
});

test("manual offline → first local/degraded rule even if its condition is inactive", () => {
  const r = resolve([reach], [], "anthropic/primary", { manualMode: "offline" });
  assert.equal(r.model, "ollama/local");
  assert.equal(r.isDegraded, true);
});

test("manual offline with no local rule → primary", () => {
  const r = resolve([cost], [], "anthropic/primary", { manualMode: "offline" });
  assert.equal(r.model, "anthropic/primary");
});

// ---- Unit 3: the ladder resolver -------------------------------------------

// buildRungs: primary is rung 0 (probe "reachability"); each rule is a rung; a rule
// gets a per-rung probe id only when it carries its own reachability.probeUrl.
const localTerminus = { condition: "reachability", target: { model: "ollama/local", local: true, contextWindow: 32000 }, modeLabel: "offline", isDegraded: true };
const probedCloud = { condition: "reachability", target: { model: "openai/backup", local: false }, modeLabel: "backup", isDegraded: true, reachability: { probeUrl: "https://backup/health" } };

test("buildRungs: primary is rung 0 with probe 'reachability'; terminus has no probe", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  assert.equal(rungs.length, 2);
  assert.deepEqual({ model: rungs[0].model, probeId: rungs[0].probeId, isDegraded: rungs[0].isDegraded }, { model: "anthropic/primary", probeId: "reachability", isDegraded: false });
  assert.equal(rungs[1].model, "ollama/local");
  assert.equal(rungs[1].probeId, null); // no per-rule probe → always-available terminus
  assert.equal(rungs[1].local, true);
  assert.deepEqual(rungs[1].perMode, { contextWindow: 32000 });
});

test("buildRungs: a rule with its own reachability.probeUrl gets a rung:<i> probe id", () => {
  const rungs = buildRungs("p", [probedCloud, localTerminus]);
  assert.equal(rungs[1].probeId, "rung:0"); // rule index 0 → rung:0
  assert.equal(rungs[2].probeId, null);
});

test("v1 EQUIVALENCE: resolveLadder matches resolve for the single-rule config across states", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  // online: brain reachable → primary (matches resolve with no active conditions)
  const online = resolveLadder(rungs, { reachability: "available" });
  const onlineV1 = resolve([localTerminus], [], "anthropic/primary");
  assert.equal(online.model, onlineV1.model);
  assert.equal(online.isDegraded, onlineV1.isDegraded);
  // offline: brain unreachable → local terminus (matches resolve with reachability active)
  const offline = resolveLadder(rungs, { reachability: "unreachable" });
  const offlineV1 = resolve([localTerminus], ["reachability"], "anthropic/primary");
  assert.equal(offline.model, offlineV1.model);
  assert.equal(offline.isDegraded, offlineV1.isDegraded);
  assert.deepEqual(offline.perMode, offlineV1.perMode);
});

test("auto walk: primary available → primary, not degraded", () => {
  const rungs = buildRungs("p", [localTerminus]);
  const r = resolveLadder(rungs, { reachability: "available" });
  assert.equal(r.model, "p");
  assert.equal(r.isDegraded, false);
});

test("multi-rung shift-up: skip unreachable rungs to the first available", () => {
  const rungs = buildRungs("p", [probedCloud, localTerminus]);
  // primary unreachable, backup probe unreachable → fall to the no-probe local terminus
  const r1 = resolveLadder(rungs, { reachability: "unreachable", "rung:0": "unreachable" });
  assert.equal(r1.model, "ollama/local");
  // primary unreachable, backup reachable → stop at backup (don't go all the way down)
  const r2 = resolveLadder(rungs, { reachability: "unreachable", "rung:0": "available" });
  assert.equal(r2.model, "openai/backup");
});

test("stranding guard: nothing reachable, no terminus → none-reachable (NOT pinned to a dead model)", () => {
  const rungs = buildRungs("p", []); // primary only, probed
  const r = resolveLadder(rungs, { reachability: "unreachable" });
  assert.equal(r.kind, "none-reachable");
  assert.equal(r.model, null); // caller will NOT switch to a dead model
});

test("missing health entry → treated as available (online-by-default, matches inert probe)", () => {
  const rungs = buildRungs("p", [localTerminus]);
  const r = resolveLadder(rungs, {}); // no reachability key at all (e.g. probe inert/empty URL)
  assert.equal(r.model, "p"); // primary stays
});

test("manual online → primary; warning set when the primary probe is unreachable", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  const ok = resolveLadder(rungs, { reachability: "available" }, { manualMode: "online" });
  assert.equal(ok.model, "anthropic/primary");
  assert.equal(ok.warning ?? null, null);
  const forced = resolveLadder(rungs, { reachability: "unreachable" }, { manualMode: "online" });
  assert.equal(forced.model, "anthropic/primary"); // user choice trumps
  assert.match(forced.warning, /unreachable/i); // but warned
});

test("manual offline → first local/degraded rung regardless of health", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  const r = resolveLadder(rungs, { reachability: "available" }, { manualMode: "offline" });
  assert.equal(r.model, "ollama/local");
  assert.equal(r.isDegraded, true);
});

test("empty / null primary ladder → none-reachable, no throw", () => {
  assert.equal(resolveLadder([], {}).kind, "none-reachable");
  const rungs = buildRungs(null, []);
  const r = resolveLadder(rungs, { reachability: "unreachable" });
  assert.equal(r.kind, "none-reachable");
});

// ---- Phase 3a: suspension channel (keyed by rung index, works for probe-less rungs) --

test("buildRungs stamps a stable `index` on every rung", () => {
  const rungs = buildRungs("p", [probedCloud, localTerminus]);
  assert.deepEqual(rungs.map((r) => r.index), [0, 1, 2]);
});

test("suspending rung 0 walks past it (same as probe-unreachable)", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  const r = resolveLadder(rungs, { reachability: "available" }, { suspended: new Set([0]) });
  assert.equal(r.model, "ollama/local"); // primary suspended → terminus
});

test("P0 FIX: a PROBE-LESS terminus rung CAN be suspended (health map alone can't do this)", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]); // rung 1 has probeId null
  // Sanity: without suspension it's available even with an unrelated unreachable primary.
  const before = resolveLadder(rungs, { reachability: "unreachable" });
  assert.equal(before.model, "ollama/local");
  // With rung 1 suspended, primary unreachable, nothing left → none-reachable.
  const r = resolveLadder(rungs, { reachability: "unreachable" }, { suspended: new Set([1]) });
  assert.equal(r.kind, "none-reachable"); // proves the probe-less rung was actually removed
});

test("every rung index suspended → none-reachable", () => {
  const rungs = buildRungs("p", [localTerminus]);
  const r = resolveLadder(rungs, { reachability: "available" }, { suspended: new Set([0, 1]) });
  assert.equal(r.kind, "none-reachable");
});

test("empty/absent suspended → identical to v2.0 resolution", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  const a = resolveLadder(rungs, { reachability: "available" });
  const b = resolveLadder(rungs, { reachability: "available" }, { suspended: new Set() });
  assert.deepEqual(a, b);
  assert.equal(b.model, "anthropic/primary");
});

test("suspension + probe-unreachability combine (both remove a rung)", () => {
  const rungs = buildRungs("p", [probedCloud, localTerminus]); // rung1 probed, rung2 terminus
  // primary suspended, backup probe unreachable → fall to the terminus.
  const r = resolveLadder(rungs, { reachability: "available", "rung:0": "unreachable" }, { suspended: new Set([0]) });
  assert.equal(r.model, "ollama/local");
});

test("cloud fallback without its own probe SHARES the brain probe (offline gates all cloud → local)", () => {
  const cloudFb = { condition: "reachability", target: { model: "openai/backup", local: false }, modeLabel: "cloud-fallback", isDegraded: false };
  const rungs = buildRungs("anthropic/primary", [cloudFb, localTerminus]);
  assert.equal(rungs[1].probeId, "reachability"); // shared with the primary, not null, not rung:*
  assert.equal(rungs[2].probeId, null);           // local terminus stays always-available

  // Offline: the brain probe is unreachable → BOTH clouds gated out → local terminus.
  const off = resolveLadder(rungs, { reachability: "unreachable" });
  assert.equal(off.model, "ollama/local");

  // Online + primary stall-suspended → secondary cloud (shares a healthy brain probe).
  const cloudFail = resolveLadder(rungs, { reachability: "available" }, { suspended: new Set([0]) });
  assert.equal(cloudFail.model, "openai/backup");

  // Fully online, nothing suspended → primary.
  assert.equal(resolveLadder(rungs, { reachability: "available" }).model, "anthropic/primary");
});

test("manual online warns when the forced primary is suspended", () => {
  const rungs = buildRungs("anthropic/primary", [localTerminus]);
  const r = resolveLadder(rungs, { reachability: "available" }, { manualMode: "online", suspended: new Set([0]) });
  assert.equal(r.model, "anthropic/primary"); // user choice still trumps
  assert.match(r.warning, /unreachable/i);
});
