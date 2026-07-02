import { test } from "node:test";
import assert from "node:assert/strict";
import { modelToRungIndex, canSuspend } from "../lib/suspension.mjs";
import { buildRungs } from "../lib/resolver.mjs";

const rungs = buildRungs("anthropic/primary", [
  { condition: "reachability", target: { model: "openai/backup" }, modeLabel: "backup", reachability: { probeUrl: "https://b/h" } },
  { condition: "reachability", target: { model: "ollama/local", local: true }, modeLabel: "offline", isDegraded: true },
]);

test("modelToRungIndex resolves a model handle to its rung index", () => {
  assert.equal(modelToRungIndex(rungs, "anthropic/primary"), 0);
  assert.equal(modelToRungIndex(rungs, "openai/backup"), 1);
  assert.equal(modelToRungIndex(rungs, "ollama/local"), 2);
});

test("modelToRungIndex → null for an unknown/mismatched model (do-not-suspend signal)", () => {
  assert.equal(modelToRungIndex(rungs, "who/knows"), null);
  assert.equal(modelToRungIndex(rungs, null), null);
  assert.equal(modelToRungIndex([], "x"), null);
});

test("canSuspend: allowed while another rung stays unsuspended", () => {
  assert.equal(canSuspend(3, new Set(), 0), true);        // suspend primary, 2 remain
  assert.equal(canSuspend(3, new Set([0]), 1), true);     // suspend backup, terminus remains
});

test("canSuspend: REFUSED when it would suspend the last unsuspended rung (never strand)", () => {
  assert.equal(canSuspend(3, new Set([0, 1]), 2), false); // only rung 2 left → refuse
});

test("canSuspend: re-suspending an already-suspended rung is harmless (still leaves the same set)", () => {
  // suspending index 0 again when {0} already suspended, 3 rungs → 1,2 remain unsuspended
  assert.equal(canSuspend(3, new Set([0]), 0), true);
});
