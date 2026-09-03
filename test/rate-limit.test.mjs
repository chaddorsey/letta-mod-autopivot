import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateLimit, parseResetsAt, classifyRateLimit } from "../lib/rate-limit.mjs";

const NOW = 1_000_000;

test("recognises the shapes providers actually use", () => {
  for (const m of [
    "Rate limit reached for gpt-5.6-sol",
    "429 Too Many Requests",
    "You have hit your usage limit for today",
    "quota exceeded",
    "rate_limit_error",
  ]) assert.equal(isRateLimit(m), true, m);
});

test("does not call an ordinary failure a rate limit", () => {
  // Misclassifying here would attach an expiry to a rung that is genuinely
  // broken, quietly restoring it into the same failure.
  for (const m of [
    "connection reset by peer",
    "model not found",
    "invalid api key",
    "",
    undefined,
  ]) assert.equal(isRateLimit(m), false, String(m));
});

test("reads a relative reset out of the message", () => {
  assert.equal(parseResetsAt("Please try again in 20s.", NOW), NOW + 20_000);
  assert.equal(parseResetsAt("try again in 1h30m", NOW), NOW + 5_400_000);
  assert.equal(parseResetsAt("Retry-After: 300", NOW), NOW + 300_000);
});

test("ignores a PAST absolute timestamp", () => {
  // A stale date elsewhere in the message would otherwise expire the suspension
  // immediately, putting the rung straight back into the wall it just hit.
  const past = "quota resets at 2020-01-01T00:00:00Z";
  assert.equal(parseResetsAt(past, Date.now()), null);
});

test("unparseable reset degrades to null, not to a wrong time", () => {
  const r = classifyRateLimit("Rate limit reached. Contact support.", NOW);
  assert.equal(r.rateLimited, true);
  assert.equal(r.resetsAt, null);   // suspend with no expiry = today's behaviour
});

test("reads the rich reason object from classifyLlmEnd", () => {
  const r = classifyRateLimit(
    { message: "Rate limit reached", detail: "try again in 45s", retryable: true }, NOW);
  assert.equal(r.rateLimited, true);
  assert.equal(r.resetsAt, NOW + 45_000);
});
