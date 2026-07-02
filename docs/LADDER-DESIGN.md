# AutoPivot — Ladder failover architecture (v2 design)

Status: **design captured, not yet built.** Extends v1 (single reachability
condition + one offline target) toward a general, monitored priority ladder.
Self-contained so we can resume cold. See `../ROADMAP.md`.

> **Framing (public artifact):** the headline is **cloud-to-cloud failover**
> (reachability → rate-limit → cost across cloud rungs), since most users have no
> local model. Offline-survival-to-local is *one configuration* of the ladder, not
> the pitch. Keep the README and the competition framing cloud-first.
>
> **Release scope:** **v2.0 = Phases 1–2 only** (split the network signal; per-rung
> reachability). Phases 3–5 (rate-limit, cost caps, multi-day scheduling, suspension
> UI) are **gated on the detection spike below** and ship in v2.1+. See "Phased build."
>
> **✅ Detection question — RESOLVED 2026-06-30** (Letta support agent + 0.27.18
> source, against a live ChatGPT team-plan usage-limit error). There is **no clean
> reactive mod event** for a provider/backend LLM failure: `llm_end` doesn't fire when
> the request throws before a final message, `turn_end` fires only on `end_turn`, and
> there is no `error`/`provider_error` event in the released 10-event union. But
> failover is **still feasible** via a defined three-part architecture (stall watchdog
> + `getHistory({includeErrors:true})` poll + pre-emption on `llm_end.usage`). Phases
> 3–5 are therefore **no longer blocked on an unknown** — they're a more elaborate but
> specified design. See **"Detection contract (Phase 3+)"** below. Phases 1–2 are
> unaffected (probing only, already proven in v1).

---

## Core reframe

Not "online vs offline." A **priority ladder of model rungs** — use the highest
*healthy* rung. The bottom rung is whatever's configured last (commonly, but NOT
necessarily, a local model); when no rung is healthy, **stay on the last *reachable*
rung**. A local fallback is optional — for users who have one, it's the offline terminus.

**Stranding guard:** "stay on last" must mean last *reachable*, not last *configured*.
If the user is offline with no local rung, the last configured rung is an unreachable
cloud model — staying there hard-fails every turn. When **no** rung is reachable, do
NOT silently pin to a dead model: surface an honest "no model currently reachable"
state (and, if a queue/offline mode is configured, hold the turn) rather than letting
the backend error. This is the no-local-rung offline terminus.
Two **orthogonal** layers:

1. **Rung selection** (which model) — walk the ladder by per-rung health.
2. **Network / action signal** (separate) — gates honesty/queue behavior,
   independent of which rung is active. *Degraded model ≠ offline network.*

The v1 prioritized `condition → target` rules already ARE a ladder; v2 makes each
rung carry its own monitors and adds dynamic suspension/recovery.

---

## Per-rung health & suspension

Each rung = a model handle + its monitors. A rung is **`available`** or
**`suspended(reason, recovery)`**. **Any single trigger suspends it**; while
suspended it drops out and the remaining rungs **shift up**. More than one trigger
may apply at once.

| Trigger | Detect | Recovery mechanism | Notes |
|---|---|---|---|
| **Unavailable** (still desirable) | inference/probe fails — *no signal* (timeout/DNS/refused/5xx) | **background ping** → reactivate on reliable reachability | adaptive probe we already have |
| **Rate-limited** | HTTP **429** (read `Retry-After` / reset clock if present) | **timer** → auto-return at the reset time (or a default **60s**, per decision #4) | clock-based |
| **Usage cap (per-rung)** | tracked spend ≥ this rung's cap | **scheduled reactivation** at a user time, or default **1 / 7 / 14 days** | long window; rung removed, others shift up |

A suspended rung stays out until its trigger(s) clear (each via its own recovery),
then the ladder re-evaluates.

---

## Global conditions (override → local terminal rung)

Both push to the designated local model; they differ **only** in whether networked
*actions* remain available — which changes the honesty message.

| Global condition | Detect | Fallback (local if configured, else stay on last) | Networked actions (email/Slack/web) | Honesty note |
|---|---|---|---|---|
| **Internet offline** (computer offline) | a **neutral network probe** fails (`1.1.1.1` / `example.com`, configurable) | local if configured, else stay on last reachable (or honest "none reachable") | **UNAVAILABLE** | "offline — hold/queue your actions" (only if a usable model exists) |
| **Global spend cap** | total tracked spend ≥ global cap | local if configured, else stay on last reachable (or honest "none reachable") | **available** | "on fallback model (cost cap) — actions still work, just no cloud spend" |

This is why the network signal is split from rung health: a global spend cap drops
you to local **while still online**, so the agent must NOT claim it's offline.

---

## Recovery mechanisms (summary)

- **Ping-based** (unavailable): the adaptive background probe; reactivate on
  confirmed reachability.
- **Timer-based** (rate-limit): schedule auto-return at `Retry-After`/reset; default
  timeout when the provider gives no clock.
- **Schedule-based** (usage cap): persist a reactivation date; restore at that date;
  user-settable, default 1/7/14 days.

## State & persistence

Suspension state — especially multi-day usage-cap removals and their reactivation
dates — **must persist across restarts** (`autopivot.state.json`). On startup:
expired suspensions clear; active ones restore *with* their recovery timers/dates.

**Hardening (required before any cost/cap feature ships):**
- **Spend must be restart-durable.** Tracked spend lives in-process today; a restart
  resets it to zero, so a global/per-rung spend cap **never trips** for anyone who
  restarts mid-window. Persist accumulated spend (with the window start) to
  `autopivot.state.json` and reload it, or the cap is cosmetic.
- **State is untrusted input.** `autopivot.state.json` is read back on startup;
  v1's `validateState` keeps only `manualMode` and drops everything else, so it can't
  yet hold reactivation dates/spend at all — that schema must be defined *and*
  validated. Validate every restored field: reject malformed/absent dates, clamp
  reactivation dates to a sane max horizon (a corrupt far-future date must not suspend
  a rung indefinitely; a past/!valid date → treat as expired = reactivate), and bound
  restored spend to ≥0. A corrupt or tampered file should degrade to "all rungs
  available," never to a stuck/locked-out ladder.

---

## Resolved decisions

1. **Network probe target → neutral + configurable** (e.g. `1.1.1.1` / `example.com`),
   NOT the provider host (which conflates "internet" with "that provider").
2. **A local model is OPTIONAL, not assumed.** Most users have an all-cloud ladder.
   When no rung is healthy: **stay on the last *reachable* rung** (don't error). If
   *nothing* is reachable (offline, no local rung), surface an honest "none reachable"
   state instead of pinning to a dead model — see the Stranding guard above. The
   offline-survival + honesty/queue features only apply *if* the user configured a
   local rung; for cloud-only users AutoPivot is cloud-to-cloud failover
   (reachability / rate-limit / cost). ("Offline → local" is one config, not a built-in.)
3. **Manual override always trumps** — forcing a suspended rung is **allowed with a
   warning**. User choice wins.
4. **Rate-limit with no `Retry-After` clock** — can't tell "real limit" from "glitch",
   so: **back off and retry once after 60s**, BUT **signal intent to the user**
   ("rate-limited, retrying in 60s…") via the pill/status, and offer a **command to
   walk down the ladder immediately** — `/pivot walkdown` (NOT an interactive picker;
   a mod cannot render one — this mirrors v1's manual override). Plus a **per-rung
   config toggle** `onRateLimit: "retry" | "walkdown"` (auto-walk-down vs retry). If
   `Retry-After` *is* present, honor it (timer to the reset time). **(Gated on the
   detection spike — see top: a mod may not observe the 429 in-band at all.)**

## Remaining notes

- **Honesty correctness**: degraded-model-but-online must NOT inject the offline/queue
  note. Note text is condition-specific (offline vs cost-cap vs none).
- **Per-rung vs global spend**: per-rung cap removes one rung; global cap removes all
  cloud rungs → fallback. Both from `llm_end` usage × `model.cost`.

---

## Maps to current code

**Have:** prioritized rules (ladder), one reachability condition (one trigger),
adaptive polling (ping recovery), manual override, state persistence, honesty
injection, the pill.
**Adds:** per-rung monitors (not one global probe); 3 trigger types with distinct
recovery; dynamic ladder shift; the separate network signal; two-flavor global
conditions; scheduled multi-day suspensions.

## Detection contract (Phase 3+) — what a mod can sense on an LLM failure

Resolved 2026-06-30 (Letta support agent + 0.27.18 source `src/backend/dev/
pi-stream-adapter.ts`, `src/mods/types.ts`), against a real ChatGPT team-plan
usage-limit error:
```json
{"error":{"error":{"message":"You have hit your ChatGPT usage limit (team plan). Try again in ~26 min.",
"error_type":"local_backend_error","retryable":false,"run_id":"local-run-595"}}}
```
The error carries structured fields internally — `plan_type`, `resets_at` (timestamp
→ the "~26 min"), `retryable`, `run_id` — but they are used to render the TUI string,
not handed to a mod.

**What a mod CANNOT do (0.27.18):**
- No `error` / `llm_error` / `provider_error` mod event exists. Released union is
  exactly: `conversation_open, conversation_close, tool_start, tool_end, turn_start,
  turn_end, llm_start, llm_end, compact_start, compact_end`.
- `llm_end` does **not** fire when the request throws before a final assistant message
  (the usage-limit/transport path). It *can* fire with `stopReason: "error"|"aborted"`
  **iff** a final error message exists — an unreliable secondary signal.
- `turn_end` fires **only** on `stopReason === "end_turn"`; payload is `{agentId,
  conversationId, stopReason, assistantMessage?}` — no error field.
- The terminal error text is **not** injected into the next `turn_start.input`.

> **⚠ EMPIRICALLY CORRECTED 2026-07-01** — a live probe mod (`spike/probe-llm-failure.mjs`)
> captured a real forced backend failure (a `401 invalid x-api-key` on a direct-Anthropic
> rung, via a deliberately-bogus key) on a **local-backend** letta-code session. Ground
> truth overrode two earlier assumptions:
>
> - **`getHistory({includeErrors:true})` does NOT surface the error on the local backend.**
>   It returned a plain message **array** (summary/tool/assistant/user entries) with **no
>   error entry**, and the error is **not persisted to the conversation on disk** (0
>   matches, checked minutes later). The support agent's getHistory path appears to be a
>   *server*-backend feature, absent locally. Signal #2 below is therefore **dead** for
>   local backends.
> - **Pre-emption (#3) can't classify or catch usage/credit/auth limits** — those aren't
>   token-countable (see the no-credit vs rate-limit split below), so #3 only ever
>   addressed context-overflow, not the limit classes.
>
> **What the probe DID confirm:** the failing turn produced `llm_start` (model set) with
> **NO `llm_end` and NO `turn_end`**; and `letta.events.on("llm_error"|"error"|
> "provider_error", …)` all throw at registration (events don't exist). So the **only**
> in-band signal is an **unmatched `llm_start`.** See "Corrected contract" below.

**What a mod CAN do — CORRECTED to the single viable signal:**
1. **Stall/gap watchdog (the ONLY reliable signal):** track `llm_start` with no matching
   `llm_end`/`turn_end` within a timeout ⇒ the active rung failed *somehow*. On trip →
   suspend the rung, walk down the ladder. **Class-blind:** 401 / 429 / no-credit /
   usage-limit / context-overflow all look identical (an unmatched `llm_start`) — the mod
   gets **no error text, no error type, no `resets_at`.**
2. ~~`getHistory({includeErrors:true})` poll~~ — **DEAD on local backend** (probe-verified:
   error not returned, not persisted). Keep as a *server-backend-only* possibility.
3. ~~Pre-emption on `llm_end.usage`~~ — only addresses **context-overflow** (a known
   window ceiling), NOT the limit classes. Optional, secondary, and orthogonal.

**Recovery — CORRECTED:** because the mod can't read a reset clock or even tell the
failure *class*, **provider-informed timer recovery is impossible.** The only universal
recovery is v1's mechanism: after suspending, **probe/retry the rung on a backoff**, plus
**manual restore** (`/pivot`). We cannot distinguish "won't self-heal" (401/no-credit)
from "self-heals at reset" (429/usage-limit) in-band, so treat every reactive suspension
the same: walk down, retry-probe, let the user override. (The *config* can still tag a
rung's expected recovery, but the mod can't derive it from the error.)

**The clean future fix:** a first-class `provider_error` mod event carrying error detail +
retry/fallback contract (open PR direction; don't build against it until released). That
event — not getHistory — is the only thing that would restore error text / class / reset
clock to a mod. Until then the stall watchdog is the ceiling.

**Design consequence:** Phase 3 reactive detection = **stall watchdog only, class-blind,
probe/manual recovery.** It's essentially v1's reachability mechanism re-triggered by a
stalled *turn* instead of a failed *probe*. The richer per-class recovery this doc
originally envisioned (timer from `resets_at`, distinct suspension reasons) is **not
achievable in-band** on 0.27.18.

## Spend monitoring (Phase 4) — feasibility + requirements

Captured 2026-07-01. **Cost is the one "limit" layer that is genuinely feasible AND
proactive** — the opposite of the rate/usage-limit case above. It rides the
**successful**-turn `llm_end.usage` (verified to fire with `{input, output,
totalTokens, cacheRead, cacheWrite}`), does arithmetic (`spend = tokens × price`), and
pivots **before** crossing a ceiling. None of Phase 3's class-blindness applies.

| | Rate/usage limit (Phase 3) | **Cost cap (Phase 4)** |
|---|---|---|
| Signal | invisible (unmatched `llm_start`) | **`llm_end.usage` — real, in-band** |
| Computable? | no | **yes (tokens × price)** |
| Timing | reactive only | **proactive (pivot before the cap)** |
| Recovery clock | provider `resets_at` (unreadable) | **our own window → timer recovery works** |

**What it needs:**
1. **Token metering** — accumulate `llm_end.usage` per turn (prompt / completion / and
   the two cache buckets, which are priced very differently). The `makeCostCondition`
   stub already has the hook shape.
2. **A pricing source — the catch:** `model.cost.*` exists but **returns ZERO through a
   proxy** (verified — kinara's usage showed `cost:{input:0,output:0,cacheRead:0,
   cacheWrite:0}` via litellm). So `model.cost` is untrustworthy in local/proxy/relayed
   setups. Need **user-configured per-model pricing** (`pricing: {"<model>":{input,
   output,cacheRead,cacheWrite}}` in $/Mtok), with `model.cost` as a fallback only when
   actually populated.
3. **Accumulation + window** — per-rung counters (per-rung cap) + a global counter
   (global cap), over a defined window (rolling 24h / calendar month / session) with
   explicit reset semantics.
4. **Durable, validated spend state — the one piece Phase 3a deliberately skipped.**
   In-process spend resets on `/reload`/restart → an unpersisted cap is cosmetic (the
   security review flagged this). Phase 4 MUST persist `{spent, windowStart}` to
   `state.json`, reload it, and **validate/clamp** (a tampered/corrupt figure must not
   lock a rung out forever). Real new infrastructure vs. 3a's ephemeral suspensions.
5. **Reaction — reuses existing machinery:** per-rung cap → that rung goes unavailable =
   **the 3a suspension mechanism** (mark down, walk the ladder). Global cap → drop to
   the cheapest/local rung **but stay online** = **the Phase 1 "degraded-but-online"
   honesty note** (actions still work; do NOT claim offline).
6. **Recovery — timer recovery IS feasible here** because *we* own the window: a capped
   rung auto-recovers at window reset (a real clock, unlike provider limits).
7. **UI — mostly done:** the cost condition's `metric()` already returns `{label:"cost",
   value, ceiling, nearThreshold}` and v1's `metricSegment` renders it ("cost 4.60/5").

**Honest caveats (must be stated in a public artifact):**
- It's your **estimate**, not the provider's bill (self-tracked from configured prices;
  prices drift, the user maintains them) — same caveat as the rate-limit stub.
- **Proxied / subscription / relayed models report $0 or unknowable cost.** Example:
  opus-via-server-key — the laptop can't know it's billed to the *server's* Anthropic
  account. So each rung needs an **"untracked / free" flag** (local models,
  subscription-proxied rungs) so they don't pollute the accounting.
- **No prompt caching balloons spend** (kinara showed `cacheRead:0` every turn → full
  context re-billed) — cost monitoring surfaces this starkly, arguably a feature.

**Architecture fit:** cost is a **proactive condition** feeding the ladder's
health/suspension path (like the reachability *condition*, not the stall-watchdog
*failure*) — so it does NOT use the failure seam. Its dependency on 3a is the
**suspension mechanism** — another reason to get 3a's suspension/recovery model right.

## Phased build (proposed)

**v2.0 — ship these two (probe-only, proven in v1, no detection unknown): ✅ BUILT**
(see plan `docs/plans/2026-06-27-001-feat-autopivot-ladder-v2-phase1-2-plan.md`)

1. ✅ **Split network signal from rung health** — neutral `networkProbe`; honesty
   note keyed on *network* (offline/queue vs degraded-but-online), conservative
   default preserves v1. *Smallest, highest-value first step.*
2. ✅ **Per-rung reachability** — each rung probes its own endpoint via
   `makeProbeCondition`; `resolveLadder` walks by health with stay-on-last-reachable +
   `none-reachable` stranding guard; manual override trumps with a warning.

**v2.1+ — detection question RESOLVED (see "Detection contract" above). Design is
pre-emption-first, with a stall-watchdog + history-poll reactive backstop:**

3. ✅ **BUILT as Phase 3a** (`docs/plans/2026-07-01-001-...-stall-watchdog-3a-plan.md`;
   smoke-validated 2026-07-01). **Rate-/usage-limit/credit/auth trigger** — the ONLY
   signal is the **stall watchdog** (`llm_start` with no `llm_end`/`turn_end`), behind a
   swappable **failure seam** (the `provider_error` landing pad). Class-blind (no error
   text/type/`resets_at`). Suspension keyed by rung index (works for probe-less rungs);
   recovery is **STICKY** — a suspended rung stays out until `/pivot online` or a later
   success (an unconfirmed timer bounced back onto the still-broken rung — observed +
   fixed in smoke). Never-strand guard; attribute to the actually-running model; slow-
   local needs a large per-rung `stall.timeoutMs`. **Auto-resend is impossible** (a
   stalled turn fires 0 events → a mod can't self-start a turn); manual resend is the
   ceiling.
4. **Cost caps** — per-rung + global, from `llm_end` accounting; scheduled
   reactivation; global-cap → local-but-online. *(Requires restart-durable spend
   accounting + state-file validation — see "State & persistence"; in-process spend
   resets to zero on restart and would bypass the cap.)*
5. **UI** — pill/status shows suspended rungs + recovery ETA ("rate-limited, back in
   4m"; "cost-capped until Jun 30").

> **Watch for `provider_error`:** if/when Letta ships the first-class provider-error
> event (open PR direction), signal #1's stall watchdog + #2's history poll collapse
> into a single clean event handler — revisit this phase then.

**Deferred past v2.1:** multi-day usage-cap scheduling (1/7/14d). Drags in
durable persistence + clock-correctness risk for a feature few users hit; revisit
only with demand.
