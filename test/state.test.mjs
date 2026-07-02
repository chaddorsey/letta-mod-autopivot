import { test } from "node:test";
import assert from "node:assert/strict";
import { validateState, loadState, saveState } from "../lib/state.mjs";

test("validateState accepts known modes, defaults unknown to auto", () => {
  assert.equal(validateState({ manualMode: "offline" }).manualMode, "offline");
  assert.equal(validateState({ manualMode: "online" }).manualMode, "online");
  assert.equal(validateState({ manualMode: "auto" }).manualMode, "auto");
  assert.equal(validateState({ manualMode: "EVIL" }).manualMode, "auto"); // tampered → safe
  assert.equal(validateState({}).manualMode, "auto");
  assert.equal(validateState(null).manualMode, "auto");
});

test("loadState: missing/malformed file → auto, never throws", async () => {
  assert.deepEqual(await loadState("/x", { read: () => { throw new Error("ENOENT"); } }), { manualMode: "auto" });
  assert.deepEqual(await loadState("/x", { read: () => "not json" }), { manualMode: "auto" });
});

test("loadState reads + validates", async () => {
  assert.equal((await loadState("/x", { read: () => '{"manualMode":"offline"}' })).manualMode, "offline");
  assert.equal((await loadState("/x", { read: () => '{"manualMode":"sneaky"}' })).manualMode, "auto");
});

test("saveState writes validated JSON via injected writer", async () => {
  let written = null;
  await saveState("/x", { manualMode: "offline", junk: 1 }, { write: (p, d) => { written = d; } });
  assert.deepEqual(JSON.parse(written), { manualMode: "offline" }); // junk stripped
});
