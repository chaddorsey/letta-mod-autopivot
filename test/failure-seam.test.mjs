import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFailureSeam } from "../lib/failure-seam.mjs";

test("report fans {rungId, reason} to every subscriber", () => {
  const seam = makeFailureSeam();
  const seen = [];
  seam.onFailure((f) => seen.push(["a", f]));
  seam.onFailure((f) => seen.push(["b", f]));
  seam.report("rung:1", "stall");
  assert.deepEqual(seen, [
    ["a", { rungId: "rung:1", reason: "stall" }],
    ["b", { rungId: "rung:1", reason: "stall" }],
  ]);
});

test("reason is opaque — a rich object passes through unchanged (provider_error landing pad)", () => {
  const seam = makeFailureSeam();
  let got = null;
  seam.onFailure((f) => { got = f; });
  const rich = { type: "rate_limit", resetsAt: 123 };
  seam.report("anthropic/claude", rich);
  assert.deepEqual(got, { rungId: "anthropic/claude", reason: rich });
});

test("onFailure returns a working unsubscribe", () => {
  const seam = makeFailureSeam();
  let n = 0;
  const off = seam.onFailure(() => n++);
  seam.report("r", "stall");
  off();
  seam.report("r", "stall");
  assert.equal(n, 1); // second report not delivered after unsubscribe
});

test("a throwing subscriber does not break the report or other subscribers", () => {
  const seam = makeFailureSeam();
  let reached = false;
  seam.onFailure(() => { throw new Error("boom"); });
  seam.onFailure(() => { reached = true; });
  assert.doesNotThrow(() => seam.report("r", "stall")); // report returns normally
  assert.equal(reached, true); // the good subscriber still ran
});

test("report with no subscribers is a no-op", () => {
  const seam = makeFailureSeam();
  assert.doesNotThrow(() => seam.report("r", "stall"));
});
