import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateProbeUrl,
  makeProbeCondition,
  makeReachabilityCondition,
  makeManualCondition,
} from "../lib/conditions.mjs";

const RC = { probeUrl: "https://h/health", intervalMs: 1000, failureThreshold: 2, recoveryThreshold: 2, probeAuthEnv: "" };

// A fake fetch driven by a queue of responses. An entry is either {status} or
// an Error (thrown) to simulate timeout/DNS.
function fakeFetch(queue, seen) {
  return async (url, opts) => {
    if (seen) seen.push({ url, opts });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return { status: next };
  };
}

test("validateProbeUrl: only http(s) allowed", () => {
  assert.equal(validateProbeUrl("https://h/health").ok, true);
  assert.equal(validateProbeUrl("http://h").ok, true);
  assert.equal(validateProbeUrl("file:///etc/passwd").ok, false);
  assert.equal(validateProbeUrl("ftp://h").ok, false);
  assert.equal(validateProbeUrl("").ok, false);
  assert.equal(validateProbeUrl("not a url").ok, false);
});

test("happy path: reachable endpoint → condition inactive (online)", async () => {
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([200, 200]) });
  await c.probeOnce();
  assert.equal(c.isActive(), false);
});

test("hysteresis: flips offline only after failureThreshold, once", async () => {
  let flips = 0; const cb = () => flips++;
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([500, 500, 500]) });
  await c.probeOnce(cb); // fails=1, not yet active
  assert.equal(c.isActive(), false);
  await c.probeOnce(cb); // fails=2 → active, flip #1
  assert.equal(c.isActive(), true);
  await c.probeOnce(cb); // already active, no flip
  assert.equal(flips, 1);
});

test("hysteresis: recovers online only after recoveryThreshold, once", async () => {
  let flips = 0; const cb = () => flips++;
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([500, 500, 200, 200]) });
  await c.probeOnce(cb); // fail 1
  await c.probeOnce(cb); // fail 2 → active (flip)
  assert.equal(c.isActive(), true);
  await c.probeOnce(cb); // ok 1 — one ok not enough
  assert.equal(c.isActive(), true);
  await c.probeOnce(cb); // ok 2 → recover (flip)
  assert.equal(c.isActive(), false);
  assert.equal(flips, 2); // one offline flip + one recovery flip
});

test("flapping under hysteresis → no spurious flips", async () => {
  let flips = 0; const cb = () => flips++;
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([500, 200, 500, 200]) });
  await c.probeOnce(cb); // fail (fails=1)
  await c.probeOnce(cb); // ok → resets fails
  await c.probeOnce(cb); // fail (fails=1)
  await c.probeOnce(cb); // ok
  assert.equal(c.isActive(), false);
  assert.equal(flips, 0);
});

test("error path: probe throws (timeout/DNS) counts as failure", async () => {
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([new Error("ETIMEDOUT"), new Error("ENOTFOUND")]) });
  await c.probeOnce();
  await c.probeOnce(); // 2 failures → offline
  assert.equal(c.isActive(), true);
});

test("401/429 (status < 500) count as reachable", async () => {
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([401, 429]) });
  await c.probeOnce();
  await c.probeOnce();
  assert.equal(c.isActive(), false); // reachable-but-erroring is NOT offline
});

test("invalid probe URL → condition inert (never active), no fetch", async () => {
  const seen = [];
  const c = makeReachabilityCondition({ ...RC, probeUrl: "file:///x" }, { fetch: fakeFetch([500, 500], seen) });
  await c.probeOnce();
  await c.probeOnce();
  assert.equal(c.isActive(), false);
  assert.equal(seen.length, 0); // never attempted a request
});

test("redirects not followed + auth header only when probeAuthEnv set", async () => {
  const seen = [];
  const c = makeReachabilityCondition(
    { ...RC, probeAuthEnv: "MY_TOK" },
    { fetch: fakeFetch([200], seen), env: { MY_TOK: "secret" } },
  );
  await c.probeOnce();
  assert.equal(seen[0].opts.redirect, "manual");
  assert.equal(seen[0].opts.headers.Authorization, "Bearer secret");

  const seen2 = [];
  const c2 = makeReachabilityCondition(RC, { fetch: fakeFetch([200], seen2), env: {} });
  await c2.probeOnce();
  assert.equal(seen2[0].opts.headers.Authorization, undefined); // no env → no auth header
});

test("probe passes an AbortSignal (timeout wiring) and abort counts as failure", async () => {
  const seen = [];
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([200], seen) });
  await c.probeOnce();
  assert.ok(seen[0].opts.signal, "fetch should receive an AbortSignal for the timeout");

  // a fetch that rejects (as an aborted/timed-out probe would) counts as unreachable
  const c2 = makeReachabilityCondition(RC, { fetch: async () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; } });
  await c2.probeOnce();
  await c2.probeOnce(); // 2 failures → offline
  assert.equal(c2.isActive(), true);
});

test("isStale reflects time since last probe", async () => {
  let t = 1000;
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([200]), now: () => t });
  await c.probeOnce(); // lastProbeAt = 1000
  t = 1000 + 5000;
  assert.equal(c.isStale(4000), true);
  assert.equal(c.isStale(6000), false);
});

// ---- Unit 1: generalized probe is id-parameterized -------------------------

test("makeProbeCondition carries the given id; same method surface", async () => {
  const c = makeProbeCondition("network", RC, { fetch: fakeFetch([200, 200]) });
  assert.equal(c.id, "network");
  for (const m of ["start", "stop", "isActive", "isPending", "pendingInfo", "isStale", "probeOnce", "metric"]) {
    assert.equal(typeof c[m], "function", `missing method ${m}`);
  }
  await c.probeOnce();
  assert.equal(c.isActive(), false);
});

test("makeProbeCondition hysteresis works for any id (rung:0)", async () => {
  const c = makeProbeCondition("rung:0", RC, { fetch: fakeFetch([500, 500, 200, 200]) });
  await c.probeOnce(); // fail 1
  await c.probeOnce(); // fail 2 → active
  assert.equal(c.isActive(), true);
  await c.probeOnce(); // ok 1
  await c.probeOnce(); // ok 2 → recover
  assert.equal(c.isActive(), false);
});

test("makeReachabilityCondition is a thin wrapper → id stays 'reachability'", () => {
  const c = makeReachabilityCondition(RC, { fetch: fakeFetch([200]) });
  assert.equal(c.id, "reachability");
});

test("manual condition: forces mode, fires onChange on real change", () => {
  let flips = 0;
  const m = makeManualCondition();
  m.start(() => flips++);
  assert.equal(m.isActive(), false);
  m.set("offline");
  assert.equal(m.isActive(), true);
  assert.equal(m.mode(), "offline");
  m.set("offline"); // no-op
  assert.equal(flips, 1);
  m.set("auto");
  assert.equal(m.isActive(), false);
  assert.equal(flips, 2);
});
