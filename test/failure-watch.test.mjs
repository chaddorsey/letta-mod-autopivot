import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStallWatch } from "../lib/failure-watch.mjs";

// Deterministic fake timers: setTimer/clearTimer register due-times; advance(ms) fires
// everything now due. Lets us drive stalls synchronously with no real waiting.
function fakeTimers() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    deps: {
      now: () => now,
      setTimer: (fn, ms) => { const t = ++id; timers.set(t, { fn, at: now + ms }); return t; },
      clearTimer: (t) => timers.delete(t),
    },
    advance(ms) {
      now += ms;
      for (const [t, { fn, at }] of [...timers]) if (at <= now) { timers.delete(t); fn(); }
    },
  };
}

test("happy path: settle before timeout → no onStall", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({ timeoutMs: 90000, onStall: (m) => stalls.push(m), deps: ft.deps });
  w.markStart({ callId: 1, model: "primary" });
  ft.advance(1000);
  w.markSettled(1);
  ft.advance(200000);
  assert.deepEqual(stalls, []);
});

test("core: no settle within timeout → onStall(actualModel) exactly once", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({ timeoutMs: 90000, onStall: (m) => stalls.push(m), deps: ft.deps });
  w.markStart({ callId: 1, model: "anthropic/claude" });
  ft.advance(89000);
  assert.deepEqual(stalls, []); // not yet
  ft.advance(2000); // crosses 90s
  assert.deepEqual(stalls, ["anthropic/claude"]);
  ft.advance(200000); // no repeat
  assert.equal(stalls.length, 1);
});

test("tool loop: two concurrent calls keyed by callId are independent", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({ timeoutMs: 90000, onStall: (m) => stalls.push(m), deps: ft.deps });
  w.markStart({ callId: 1, model: "primary" });
  w.markStart({ callId: 2, model: "primary" });
  w.markSettled(1);          // settling call 1 must NOT cancel call 2's timer
  ft.advance(95000);
  assert.deepEqual(stalls, ["primary"]); // call 2 still stalled, exactly once
});

test("per-model timeout override is honored", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({
    timeoutMs: 90000,
    timeoutForModel: (m) => (m === "ollama/local" ? 180000 : undefined),
    onStall: (m) => stalls.push(m), deps: ft.deps,
  });
  w.markStart({ callId: 1, model: "ollama/local" });
  ft.advance(95000);
  assert.deepEqual(stalls, []); // 90s passed but local's window is 180s
  ft.advance(90000);
  assert.deepEqual(stalls, ["ollama/local"]);
});

test("turn_end path also settles (markSettled from either llm_end or turn_end)", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({ timeoutMs: 90000, onStall: (m) => stalls.push(m), deps: ft.deps });
  w.markStart({ callId: 7, model: "primary" });
  w.markSettled(7); // whichever event calls it first
  w.markSettled(7); // idempotent second settle (e.g. both llm_end and turn_end) → no throw
  ft.advance(200000);
  assert.deepEqual(stalls, []);
});

test("timeoutMs <= 0 → automatic stall DISABLED (never arms; e.g. local rungs use /pivot down)", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({ timeoutMs: 0, onStall: (m) => stalls.push(m), deps: ft.deps });
  w.markStart({ callId: 1, model: "ollama/local" });
  ft.advance(10_000_000);
  assert.deepEqual(stalls, []); // never stalls — the watch didn't arm

  // per-model 0 disables just that model while the global default stays active
  const w2 = makeStallWatch({ timeoutMs: 90000, timeoutForModel: (m) => (m === "ollama/local" ? 0 : undefined), onStall: (m) => stalls.push(m), deps: ft.deps });
  w2.markStart({ callId: 2, model: "ollama/local" });   // disabled
  w2.markStart({ callId: 3, model: "cloud/primary" });  // global 90s
  ft.advance(95000);
  assert.deepEqual(stalls, ["cloud/primary"]); // only the cloud rung stalled
});

test("stop() clears armed timers → no onStall after stop", () => {
  const ft = fakeTimers();
  const stalls = [];
  const w = makeStallWatch({ timeoutMs: 90000, onStall: (m) => stalls.push(m), deps: ft.deps });
  w.markStart({ callId: 1, model: "primary" });
  w.stop();
  ft.advance(200000);
  assert.deepEqual(stalls, []);
});

test("markSettled for an unknown callId is a safe no-op", () => {
  const ft = fakeTimers();
  const w = makeStallWatch({ timeoutMs: 90000, onStall: () => {}, deps: ft.deps });
  assert.doesNotThrow(() => w.markSettled(999));
});
