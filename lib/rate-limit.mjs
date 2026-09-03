/**
 * AutoPivot — rate-limit recognition.
 *
 * A rate limit is not the same failure as a broken rung, and treating them alike
 * loses real information. A rung that 429s is HEALTHY and TEMPORARILY refusing:
 * the reachability probe even agrees, since it classifies any status < 500
 * (401/429 included) as reachable — which is why a quota wall never moved the
 * ladder on its own. Suspending is still the right response, but the rung should
 * come back by itself when the window closes, instead of waiting for a clean
 * completion that cannot happen while it is suspended, or for `/pivot online`.
 *
 * The provider does not hand us a structured reset time (see lib/llm-end.mjs), so
 * we read it out of the message text. Every pattern here is best-effort: an
 * unrecognised message degrades to `resetsAt: null`, which means "suspend without
 * an expiry" — exactly today's behaviour. Failing to parse must never be worse
 * than not having tried.
 */

const RATE_LIMIT_PATTERNS = [
  /\brate[\s_-]?limit/i,
  /\btoo many requests\b/i,
  /\bquota\b/i,
  /\busage limit\b/i,
  /\b429\b/,
];

/** Is this error the provider saying "not now"? */
export function isRateLimit(message) {
  const text = String(message ?? "");
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/**
 * Best-effort reset time, as epoch ms, or null when the message does not say.
 * `now` is injectable so tests do not depend on the clock.
 */
export function parseResetsAt(message, now = Date.now()) {
  const text = String(message ?? "");

  // "try again in 1h2m3s" / "retry after 30 seconds" / "in 1.5s"
  const rel = text.match(
    /(?:try again|retry(?:[-\s]after)?|available again|resets?)\s*(?:in)?\s*:?\s*((?:\d+(?:\.\d+)?\s*[hms](?:ours?|in(?:ute)?s?|ec(?:ond)?s?)?\s*)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+(?:\.\d+)?)\s*([hms])/gi)) {
      const mult = unit.toLowerCase() === "h" ? 3600e3 : unit.toLowerCase() === "m" ? 60e3 : 1e3;
      ms += parseFloat(n) * mult;
    }
    if (ms > 0) return now + ms;
  }

  // A bare "Retry-After: 60" header value, seconds by convention.
  const hdr = text.match(/retry[-\s]?after\s*[:=]\s*(\d+)\b/i);
  if (hdr) return now + Number(hdr[1]) * 1000;

  // An absolute ISO timestamp: "resets at 2026-09-03T19:00:00Z".
  const iso = text.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) {
    const t = Date.parse(iso[1]);
    // Only trust a FUTURE timestamp: a past one is almost certainly some other
    // date in the message, and restoring the rung immediately would spin.
    if (Number.isFinite(t) && t > now) return t;
  }

  return null;
}

/**
 * Classify a failure reason (string or the rich object from classifyLlmEnd).
 * Returns `{ rateLimited, resetsAt }`.
 */
export function classifyRateLimit(reason, now = Date.now()) {
  const text = reason && typeof reason === "object"
    ? `${reason.message ?? ""} ${reason.detail ?? ""}`
    : String(reason ?? "");
  if (!isRateLimit(text)) return { rateLimited: false, resetsAt: null };
  return { rateLimited: true, resetsAt: parseResetsAt(text, now) };
}
