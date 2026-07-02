import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEngine } from "../lib/engine.mjs";

// Minimal fake condition for engine tests.
function fakeCondition(id, activeRef) {
  let cb = null;
  return {
    id,
    start(onChange) { cb = onChange; },
    stop() { cb = null; },
    isActive() { return activeRef.value; },
    flip(v) { activeRef.value = v; if (cb) cb(); },
  };
}

test("activeConditions returns active ones in config order", () => {
  const a = { value: true }, b = { value: false }, c = { value: true };
  const engine = makeEngine([fakeCondition("a", a), fakeCondition("b", b), fakeCondition("c", c)]);
  engine.start();
  assert.deepEqual(engine.activeConditions().map((x) => x.id), ["a", "c"]);
});

test("onChange fires when a condition flips; unsubscribe stops it", () => {
  const ref = { value: false };
  const cond = fakeCondition("x", ref);
  const engine = makeEngine([cond]);
  engine.start();
  let n = 0;
  const off = engine.onChange(() => n++);
  cond.flip(true);
  assert.equal(n, 1);
  off();
  cond.flip(false);
  assert.equal(n, 1); // unsubscribed
});

test("a throwing condition does not break the engine", () => {
  const good = fakeCondition("good", { value: true });
  const bad = { id: "bad", start() { throw new Error("boom"); }, stop() {}, isActive() { throw new Error("boom"); } };
  const engine = makeEngine([bad, good]);
  engine.start(); // must not throw
  assert.deepEqual(engine.activeConditions().map((x) => x.id), ["good"]); // bad filtered out safely
});

test("get(id) looks up a condition", () => {
  const engine = makeEngine([fakeCondition("reachability", { value: false })]);
  assert.equal(engine.get("reachability").id, "reachability");
  assert.equal(engine.get("nope"), null);
});
