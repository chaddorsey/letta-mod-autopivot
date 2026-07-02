import { test } from "node:test";
import assert from "node:assert/strict";
import { injectNote, buildHonestyNote, decideTurn } from "../lib/turn.mjs";

// The verified event.input shape: array of messages with content-parts.
function msgArray(userText) {
  return [
    { role: "user", content: [
      { type: "text", text: "<system-reminder>env</system-reminder>" },
      { type: "text", text: userText },
    ], otid: "x" },
  ];
}

test("injectNote appends to the LAST text part of the message array", () => {
  const out = injectNote(msgArray("Name a color."), "\n\nNOTE");
  const parts = out[0].content;
  assert.equal(parts[parts.length - 1].text, "Name a color.\n\nNOTE"); // appended to last part
  assert.equal(parts[0].text, "<system-reminder>env</system-reminder>"); // earlier part untouched
});

test("injectNote handles string content and unexpected shapes safely", () => {
  assert.equal(injectNote([{ role: "user", content: "hi" }], "X")[0].content, "hiX");
  assert.deepEqual(injectNote("not-an-array", "X"), "not-an-array"); // left untouched
  assert.deepEqual(injectNote([], "X"), []); // empty array → no throw
});

test("injectNote does not mutate the original input", () => {
  const orig = msgArray("hi");
  const before = JSON.stringify(orig);
  injectNote(orig, "NOTE");
  assert.equal(JSON.stringify(orig), before); // pure
});

const reachTarget = { model: "ollama/local", perMode: { contextWindow: 32000 }, modeLabel: "offline", isDegraded: true };
const primaryTarget = { model: "anthropic/primary", perMode: {}, modeLabel: "primary", isDegraded: false };

test("switchTo set only when target differs from current", () => {
  assert.equal(decideTurn({ target: reachTarget, currentModelId: "anthropic/primary", episode: {}, memfsEnabled: true }).switchTo, "ollama/local");
  assert.equal(decideTurn({ target: reachTarget, currentModelId: "ollama/local", episode: {}, memfsEnabled: true }).switchTo, null);
});

test("honesty injects ONCE on entering a degraded episode (transition mode)", () => {
  let episode = { degraded: false };
  const d1 = decideTurn({ target: reachTarget, currentModelId: "p", episode, memfsEnabled: true });
  assert.equal(d1.shouldInject, true); // entering
  episode = d1.episode;
  const d2 = decideTurn({ target: reachTarget, currentModelId: "ollama/local", episode, memfsEnabled: true });
  assert.equal(d2.shouldInject, false); // same episode → quiet
});

test("every-turn mode re-injects within the episode", () => {
  let episode = { degraded: true };
  const d = decideTurn({ target: reachTarget, currentModelId: "ollama/local", episode, memfsEnabled: true, honestyMode: "every-turn" });
  assert.equal(d.shouldInject, true);
});

test("leaving then re-entering degraded injects again", () => {
  let episode = { degraded: true };
  const online = decideTurn({ target: primaryTarget, currentModelId: "ollama/local", episode, memfsEnabled: true });
  assert.equal(online.shouldInject, false);
  episode = online.episode; // { degraded: false }
  const back = decideTurn({ target: reachTarget, currentModelId: "anthropic/primary", episode, memfsEnabled: true });
  assert.equal(back.shouldInject, true); // new episode
});

test("boundary: degraded but memfs disabled → no injection, switch still happens", () => {
  const d = decideTurn({ target: reachTarget, currentModelId: "p", episode: { degraded: false }, memfsEnabled: false });
  assert.equal(d.shouldInject, false); // honesty is an offline-PROFILE feature (local only)
  assert.equal(d.switchTo, "ollama/local"); // routing still works on any backend
});

test("not degraded → never injects", () => {
  const d = decideTurn({ target: primaryTarget, currentModelId: "x", episode: { degraded: false }, memfsEnabled: true });
  assert.equal(d.shouldInject, false);
});

test("buildHonestyNote names the mode and warns against faking actions", () => {
  const note = buildHonestyNote("offline");
  assert.match(note, /LOCAL model/);
  assert.match(note, /do NOT claim they succeeded/);
});

// ---- Unit 2: network-signal split → two honesty variants -------------------

test("buildHonestyNote: offline variant (default + explicit) = the queue note", () => {
  const def = buildHonestyNote("offline");
  const explicit = buildHonestyNote("offline", "offline");
  assert.equal(def, explicit); // default variant is offline (preserves v1)
  assert.match(def, /UNAVAILABLE/);
  assert.match(def, /queue/i);
});

test("buildHonestyNote: online variant = degraded-but-online (actions WORK, no queue)", () => {
  const note = buildHonestyNote("offline", "online");
  assert.match(note, /still (work|available)/i); // actions are available
  assert.doesNotMatch(note, /UNAVAILABLE/);
  assert.doesNotMatch(note, /queue/i); // must NOT tell the agent to hold actions
  assert.match(note, /fallback|different|local model/i); // explains the model is degraded
});

test("decideTurn: actionsAvailable=true on a degraded+memfs turn → online variant", () => {
  const d = decideTurn({ target: reachTarget, currentModelId: "p", episode: { degraded: false }, memfsEnabled: true, actionsAvailable: true });
  assert.equal(d.shouldInject, true);
  assert.equal(d.noteVariant, "online");
});

test("decideTurn: actionsAvailable false/null/undefined → offline variant (conservative)", () => {
  for (const av of [false, null, undefined]) {
    const d = decideTurn({ target: reachTarget, currentModelId: "p", episode: { degraded: false }, memfsEnabled: true, actionsAvailable: av });
    assert.equal(d.noteVariant, "offline", `actionsAvailable=${av} should pick the offline note`);
  }
});

test("decideTurn: noteVariant present even when not injecting (caller ignores it)", () => {
  const d = decideTurn({ target: primaryTarget, currentModelId: "x", episode: { degraded: false }, memfsEnabled: true, actionsAvailable: true });
  assert.equal(d.shouldInject, false);
  assert.equal(d.noteVariant, "online"); // derived purely from actionsAvailable
});
