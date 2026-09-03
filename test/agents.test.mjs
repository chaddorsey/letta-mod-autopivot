import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig, agentPrimary } from "../lib/config.mjs";

const cfg = (raw) => parseConfig(JSON.stringify(raw));

test("agentPrimary: no agents map → global primary, no match", () => {
  const { config } = cfg({ primary: "A" });
  assert.deepEqual(agentPrimary(config, { id: "x", name: "y" }),
    { primary: "A", rules: [], ownRules: false, key: null, perMode: {}, matched: null });
});

test("agentPrimary: an agent WITHOUT its own rules shares the global rungs", () => {
  const { config } = cfg({
    primary: "A",
    rules: [{ condition: "reachability", target: { model: "GLOBAL-FALLBACK" } }],
    agents: { "agent-1": { primary: "B" } },
  });
  const r = agentPrimary(config, { id: "agent-1" });
  assert.equal(r.primary, "B");
  assert.equal(r.ownRules, false);
  assert.equal(r.rules[0].target.model, "GLOBAL-FALLBACK");
});

test("agentPrimary: an agent WITH its own rules does not inherit the global ones", () => {
  // The point of the feature: one fleet cannot express "Kinara falls back to a
  // paid frontier model, pulse falls back to something cheap" with one list.
  const { config } = cfg({
    primary: "A",
    rules: [{ condition: "reachability", target: { model: "GLOBAL-FALLBACK" } }],
    agents: {
      "agent-1": {
        primary: "B",
        rules: [{ condition: "reachability", target: { model: "MINE" } }],
      },
    },
  });
  const r = agentPrimary(config, { id: "agent-1" });
  assert.equal(r.ownRules, true);
  assert.equal(r.rules.length, 1);
  assert.equal(r.rules[0].target.model, "MINE");
  assert.equal(r.key, "agent-1");
});

test("agentPrimary: a non-array rules override falls back to the global rungs", () => {
  // Degrading to the shared ladder beats running an agent with NO fallback.
  const { config, warnings } = cfg({
    primary: "A",
    rules: [{ condition: "reachability", target: { model: "GLOBAL-FALLBACK" } }],
    agents: { "agent-1": { primary: "B", rules: "nope" } },
  });
  const r = agentPrimary(config, { id: "agent-1" });
  assert.equal(r.ownRules, false);
  assert.equal(r.rules[0].target.model, "GLOBAL-FALLBACK");
  assert.ok(warnings.some((w) => w.includes("rules")));
});

test("agentPrimary: id match wins and reports how it matched", () => {
  const { config } = cfg({ primary: "A", agents: { "agent-1": { primary: "B" } } });
  const r = agentPrimary(config, { id: "agent-1", name: "unused" });
  assert.equal(r.primary, "B");
  assert.equal(r.matched, "id");
});

test("agentPrimary: name match when no id match", () => {
  const { config } = cfg({ primary: "A", agents: { pulse: { primary: "C" } } });
  assert.equal(agentPrimary(config, { id: "nope", name: "pulse" }).primary, "C");
});

test("agentPrimary: id is preferred over name when both would match", () => {
  const { config } = cfg({ primary: "A", agents: { "agent-1": { primary: "B" }, pulse: { primary: "C" } } });
  assert.equal(agentPrimary(config, { id: "agent-1", name: "pulse" }).primary, "B");
});

test("agentPrimary: carries contextWindow/reasoningEffort as perMode", () => {
  const { config } = cfg({ primary: "A", agents: { pulse: { primary: "C", contextWindow: 32000, reasoningEffort: "low" } } });
  assert.deepEqual(agentPrimary(config, { name: "pulse" }).perMode,
    { contextWindow: 32000, reasoningEffort: "low" });
});

test("agentPrimary: an unlisted agent is unaffected by other overrides", () => {
  const { config } = cfg({ primary: "A", agents: { pulse: { primary: "C" } } });
  assert.equal(agentPrimary(config, { id: "other", name: "other" }).primary, "A");
});

test("parseConfig: an override without primary is ignored and warned, not fatal", () => {
  const { config, warnings } = cfg({ primary: "A", agents: { bad: { contextWindow: 1 } } });
  assert.equal(Object.keys(config.agents).length, 0);
  assert.ok(warnings.some((w) => w.includes("bad")));
  assert.equal(agentPrimary(config, { name: "bad" }).primary, "A");
});

test("parseConfig: a non-object agents map warns and does not throw", () => {
  const { config, warnings } = cfg({ primary: "A", agents: ["nope"] });
  assert.deepEqual(config.agents, {});
  assert.ok(warnings.some((w) => w.includes("agents")));
});

test("agentPrimary: missing identity falls back to the global primary", () => {
  const { config } = cfg({ primary: "A", agents: { pulse: { primary: "C" } } });
  assert.equal(agentPrimary(config, {}).primary, "A");
  assert.equal(agentPrimary(config).primary, "A");
});

// --- agent identity from the memfs path -------------------------------------
// The fleet moved from ~/.letta/agents/<id>/memory to
// ~/.letta/lc-local-backend/memfs/<id>/memory. A regex matching only `agents/`
// returned null for every local agent, which silently disabled EVERY per-agent
// override: rung 0 fell back to the global primary, so an agent running its own
// model was off-ladder and its failures were dropped instead of failing over.
test("agent id resolves from BOTH the docker-era and local memfs layouts", () => {
  const idFrom = (dir) =>
    String(dir ?? "").match(/(?:agents|memfs)\/([^/]+)/)?.[1] ?? null;

  assert.equal(
    idFrom("/Users/x/.letta/agents/agent-2ed14ef4-6289-453a-ae27-290b6ed196b8/memory"),
    "agent-2ed14ef4-6289-453a-ae27-290b6ed196b8");
  assert.equal(
    idFrom("/Users/x/.letta/lc-local-backend/memfs/agent-local-8474bbbd-95fc-42f7-b586-eb0cf94a5a5d/memory"),
    "agent-local-8474bbbd-95fc-42f7-b586-eb0cf94a5a5d");
  assert.equal(idFrom(""), null);
  assert.equal(idFrom(undefined), null);
});
