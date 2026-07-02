import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatusText } from "../lib/status.mjs";

test("headline first: mode · model · auto/forced", () => {
  const out = buildStatusText({
    modeLabel: "offline", model: "ollama/local", manualMode: "auto",
    conditions: [{ id: "reachability", active: true }],
  });
  const lines = out.split("\n");
  assert.match(lines[0], /^AutoPivot — offline · ollama\/local · auto/); // answer on line 1
  assert.match(out, /reachability: active/);
  assert.match(out, /\/pivot offline/); // revert hint
});

test("forced override is surfaced prominently with revert instruction", () => {
  const out = buildStatusText({
    modeLabel: "offline", model: "ollama/local", manualMode: "offline",
    conditions: [{ id: "reachability", active: false }],
  });
  assert.match(out.split("\n")[0], /forced offline/);
  assert.match(out, /\/pivot auto to resume/);
});

test("condition metric is shown when present", () => {
  const out = buildStatusText({
    modeLabel: "budget", model: "openai/cheap", manualMode: "auto",
    conditions: [{ id: "cost", active: true, metric: () => ({ label: "cost", value: 4.6, ceiling: 5 }) }],
  });
  assert.match(out, /cost: active \[cost 4.6\/5\]/);
});

test("no model → readable placeholder", () => {
  const out = buildStatusText({ modeLabel: "primary", model: null, manualMode: "auto", conditions: [] });
  assert.match(out, /\(no model\)/);
});

test("actions axis surfaced on the headline when known (Phase 1 split)", () => {
  const online = buildStatusText({ modeLabel: "primary", model: "p", manualMode: "auto", conditions: [], actions: "online" });
  assert.match(online.split("\n")[0], /actions online/);
  const offline = buildStatusText({ modeLabel: "offline", model: "l", manualMode: "auto", conditions: [], actions: "offline" });
  assert.match(offline.split("\n")[0], /actions offline/);
});

test("actions axis omitted when unconfigured (null) → no clutter", () => {
  const out = buildStatusText({ modeLabel: "primary", model: "p", manualMode: "auto", conditions: [], actions: null });
  assert.doesNotMatch(out.split("\n")[0], /actions/);
});
