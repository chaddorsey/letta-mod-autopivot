import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPill, resolveSignifier, metricSegment } from "../lib/statusline.mjs";
import { defaultConfig } from "../lib/config.mjs";

// identity chalk: chalk.red(x)===x AND chalk.hex("#..")(x)===x (matches real chalk's
// .hex() returning a styler function).
const idChalk = new Proxy({}, { get: (_t, prop) => (prop === "hex" ? () => (s) => s : (s) => s) });

function cfg(overrides = {}) {
  const c = defaultConfig();
  Object.assign(c.statusline, overrides);
  return c;
}

test("online pill: glyph + text + model (text on)", () => {
  const s = renderPill({ kind: "online", model: "gpt-5.5" }, cfg(), idChalk);
  assert.equal(s, "● online gpt-5.5");
});

test("offline pill uses the matched rule's signifier + model", () => {
  const s = renderPill(
    { kind: "offline", model: "qwen", ruleSignifier: { glyph: "●", color: "red", text: "offline" } },
    cfg(), idChalk,
  );
  assert.equal(s, "● offline qwen");
});

test("accessibility: online and offline are distinguishable WITHOUT color (text on)", () => {
  const on = renderPill({ kind: "online", model: "m" }, cfg(), idChalk);
  const off = renderPill({ kind: "offline", model: "m", ruleSignifier: { glyph: "●", color: "red", text: "offline" } }, cfg(), idChalk);
  assert.notEqual(on, off); // differ by text, not just color
  assert.match(on, /online/);
  assert.match(off, /offline/);
});

test("showModeText:false → bare glyphs, distinct shapes (● online / ○ offline)", () => {
  const c = cfg({ showModeText: false });
  const on = renderPill({ kind: "online", model: "m" }, c, idChalk);
  const off = renderPill({ kind: "offline", model: "m", ruleSignifier: { glyph: "●", color: "red", text: "offline" } }, c, idChalk);
  assert.equal(on, "● m");
  assert.equal(off, "○ m"); // distinct glyph carries meaning when text is off
  assert.notEqual(on, off);
});

test("forced-offline = slashed dot (⊘), forced-online = filled dot; both labeled", () => {
  const fOff = renderPill({ kind: "forced-offline", model: "qwen" }, cfg(), idChalk);
  assert.equal(fOff, "⊘ forced offline qwen"); // distinct slashed glyph (orange via hex)
  const fOn = renderPill({ kind: "forced-online", model: "gpt-5.5" }, cfg(), idChalk);
  assert.equal(fOn, "● forced online gpt-5.5");
});

test("online ● vs offline ○ are shape-distinct (default signifiers)", () => {
  const on = renderPill({ kind: "online", model: "m" }, cfg(), idChalk);
  const off = renderPill({ kind: "offline", model: "m" }, cfg(), idChalk); // no ruleSignifier → default
  assert.equal(on, "● online m");
  assert.equal(off, "○ offline m"); // hollow dot by default now
});

test("unknown state renders the checking signifier", () => {
  assert.match(renderPill({ kind: "unknown", model: "m" }, cfg(), idChalk), /checking/);
});

test("suspended pill: 'on fallback' — reassuring (working on a lower rung), distinct from none-reachable", () => {
  const s = renderPill({ kind: "suspended", model: "ollama/local" }, cfg(), idChalk);
  assert.match(s, /on fallback/);
  assert.match(s, /ollama\/local/); // shows the working fallback model
  const sig = resolveSignifier("suspended", cfg(), null);
  assert.notEqual(sig.glyph, resolveSignifier("none-reachable", cfg(), null).glyph); // not the alarming ⊗
  assert.notEqual(sig.glyph, resolveSignifier("offline", cfg(), null).glyph);
});

test("unconfigured pill: ⚙ 'not configured' (first-run onboarding state)", () => {
  const s = renderPill({ kind: "unconfigured", model: null }, cfg(), idChalk);
  assert.match(s, /not configured/);
  assert.equal(resolveSignifier("unconfigured", cfg(), null).glyph, "⚙");
});

test("none-reachable pill: distinct glyph + 'no model' (Phase 2 stranding guard)", () => {
  const s = renderPill({ kind: "none-reachable", model: null }, cfg(), idChalk);
  assert.match(s, /no model/);
  const sig = resolveSignifier("none-reachable", cfg(), null);
  assert.equal(sig.glyph, "⊗"); // distinct from forced-offline's ⊘ and offline's ○
  assert.notEqual(sig.glyph, resolveSignifier("offline", cfg(), null).glyph);
});

test("active model always present in the pill", () => {
  for (const kind of ["online", "offline", "forced", "unknown"]) {
    const s = renderPill({ kind, model: "my-model", ruleSignifier: { glyph: "●", color: "red", text: "offline" } }, cfg(), idChalk);
    assert.match(s, /my-model/);
  }
});

test("checking pill shows retry progress (dropping vs reconnecting)", () => {
  const dropping = renderPill(
    { kind: "checking", model: "gpt-5.5", checking: { direction: "offline", attempt: 1, threshold: 2 } },
    cfg(), idChalk,
  );
  assert.equal(dropping, "◌ checking 1/2 gpt-5.5"); // active retry, Google-Docs style

  const reconnecting = renderPill(
    { kind: "checking", model: "ollama/local", checking: { direction: "online", attempt: 1, threshold: 2 } },
    cfg(), idChalk,
  );
  assert.equal(reconnecting, "◌ reconnecting 1/2 ollama/local");
});

test("resolveSignifier honors a custom rule signifier (amber offline)", () => {
  const sig = resolveSignifier("offline", cfg(), { glyph: "▲", color: "yellow", text: "degraded" });
  assert.deepEqual(sig, { glyph: "▲", color: "yellow", text: "degraded" });
});

test("metric: always shows; never hides; near-threshold gated on nearThreshold", () => {
  const cost = { metric: () => ({ label: "cost", value: 4.6, ceiling: 5, nearThreshold: true }) };
  const rate = { metric: () => ({ label: "rate", value: 12, ceiling: 100, nearThreshold: false }) };
  assert.equal(metricSegment([{ ...cost, statusDisplay: "always" }]), "cost 4.60/5");
  assert.equal(metricSegment([{ ...cost, statusDisplay: "never" }]), "");
  assert.equal(metricSegment([{ ...cost, statusDisplay: "near-threshold" }]), "cost 4.60/5"); // near → show
  assert.equal(metricSegment([{ ...rate, statusDisplay: "near-threshold" }]), ""); // not near → hide
});

test("metric: multiple qualifying segments joined", () => {
  const a = { metric: () => ({ label: "cost", value: 5, ceiling: 5, nearThreshold: true }), statusDisplay: "always" };
  const b = { metric: () => ({ label: "rate", value: 90, ceiling: 100, nearThreshold: true }), statusDisplay: "near-threshold" };
  assert.equal(metricSegment([a, b]), "cost 5/5 · rate 90/100");
});

test("metric: infinite/absent ceiling shows just the value", () => {
  const m = { metric: () => ({ label: "cost", value: 3, ceiling: Infinity, nearThreshold: true }), statusDisplay: "always" };
  assert.equal(metricSegment([m]), "cost 3");
});
