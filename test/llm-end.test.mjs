import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyLlmEnd, describeReason } from "../lib/llm-end.mjs";

test("classifyLlmEnd: clean completion (usage present, no error) → not failed", () => {
  const r = classifyLlmEnd({ model: "anthropic/x", stopReason: "stop", usage: { totalTokens: 10 } });
  assert.equal(r.failed, false);
  assert.equal(r.reason, null);
});

test("classifyLlmEnd: 0.27.20 provider error → failed with rich reason", () => {
  const r = classifyLlmEnd({
    model: "anthropic/x",
    stopReason: "error",
    usage: null,
    error: { message: "rate limit exceeded", detail: "429", errorType: "llm_error", retryable: true },
  });
  assert.equal(r.failed, true);
  assert.equal(typeof r.reason, "object");
  assert.equal(r.reason.source, "llm_end");
  assert.equal(r.reason.errorType, "llm_error");
  assert.equal(r.reason.message, "rate limit exceeded");
  assert.equal(r.reason.retryable, true);
});

test("classifyLlmEnd: local_backend_error is preserved; retryable defaults false", () => {
  const r = classifyLlmEnd({ usage: null, error: { message: "backend down", errorType: "local_backend_error" } });
  assert.equal(r.failed, true);
  assert.equal(r.reason.errorType, "local_backend_error");
  assert.equal(r.reason.retryable, false); // absent → false
});

test("classifyLlmEnd: error without message falls back to detail then a default", () => {
  assert.equal(classifyLlmEnd({ error: { detail: "boom", errorType: "llm_error" } }).reason.message, "boom");
  assert.equal(classifyLlmEnd({ error: { errorType: "llm_error" } }).reason.message, "provider error");
});

test("classifyLlmEnd: unknown errorType is normalized to llm_error", () => {
  assert.equal(classifyLlmEnd({ error: { message: "?", errorType: "weird" } }).reason.errorType, "llm_error");
});

test("classifyLlmEnd: legacy stopReason error/aborted → failed with string reason", () => {
  assert.deepEqual(classifyLlmEnd({ stopReason: "error" }), { failed: true, reason: "error" });
  assert.deepEqual(classifyLlmEnd({ stopReason: "aborted" }), { failed: true, reason: "error" });
});

test("classifyLlmEnd: 0.27.18 benign end (no error field) → not failed", () => {
  // On older builds a *failed* request emits no llm_end at all; the ones we DO see are wins.
  assert.equal(classifyLlmEnd({ stopReason: "end_turn", usage: { totalTokens: 5 } }).failed, false);
});

test("classifyLlmEnd: missing/empty event → not failed (defensive)", () => {
  assert.equal(classifyLlmEnd(undefined).failed, false);
  assert.equal(classifyLlmEnd({}).failed, false);
});

test("describeReason: rich provider error → type + message", () => {
  assert.equal(
    describeReason({ source: "llm_end", errorType: "llm_error", message: "rate limit exceeded", retryable: true }),
    "provider error: rate limit exceeded",
  );
  assert.equal(
    describeReason({ source: "llm_end", errorType: "local_backend_error", message: "down", retryable: false }),
    "local backend error: down",
  );
});

test("describeReason: string reasons", () => {
  assert.equal(describeReason("stall"), "no response (timed out)");
  assert.equal(describeReason("manual"), "manual pivot");
  assert.equal(describeReason("error"), "error");
});
