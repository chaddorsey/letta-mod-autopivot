/**
 * AutoPivot — condition engine.
 *
 * Owns the set of conditions: starts/stops their watchers, exposes which are
 * currently active (in config order), and fans a single `onChange` out to
 * subscribers (the statusline + the memory-sync seam) whenever any condition
 * flips. The engine holds no routing logic — that's the resolver's job; it just
 * aggregates condition state so `turn_start` can read it cheaply (Plan R3/R4).
 */
export function makeEngine(conditions) {
  const subs = new Set();
  const emit = () => { for (const fn of subs) { try { fn(); } catch { /* isolate */ } } };

  return {
    /** Begin watching all conditions; each flip triggers our subscribers. */
    start() {
      for (const c of conditions) {
        try { c.start(emit); } catch { /* a broken condition must not break the engine */ }
      }
    },
    stop() {
      for (const c of conditions) { try { c.stop(); } catch { /* ignore */ } }
      subs.clear();
    },
    /** Subscribe to "some condition changed". Returns an unsubscribe fn. */
    onChange(fn) { subs.add(fn); return () => subs.delete(fn); },
    /** Active conditions in the order they were given (== config rule order). */
    activeConditions() {
      return conditions.filter((c) => { try { return c.isActive(); } catch { return false; } });
    },
    /** Look up a condition by id (e.g. to read reachability staleness or manual mode). */
    get(id) { return conditions.find((c) => c.id === id) ?? null; },
    /** All conditions (for metric rendering). */
    all() { return conditions.slice(); },
  };
}
