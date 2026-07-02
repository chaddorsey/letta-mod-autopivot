# AutoPivot v2.0 — manual smoke checklist (Phases 1–2)

Host-integration paths that unit tests can't cover (live `updateLlmConfig`, panel
render, `/pivot` commands) — verify these in a real local-backend TUI turn after
`npm run build` + installing the bundle to `~/.letta/mods/autopivot.mjs` and `/reload`.

Use a config with a primary (cloud), an optional backup cloud rung **with its own
`reachability.probeUrl`**, a local terminus rule, and (to test axis 2) a
`networkProbe`.

## Phase 2 — ladder walk

- [ ] **Healthy:** online, pill shows `● online <primary>`; a turn runs on the primary.
- [ ] **Drop the brain endpoint** (block/stop the primary `probeUrl`): within
      `failureThreshold` probes the pill walks to the next reachable rung
      (`● backup` or `○ offline <local>`); the next turn's model matches the pill.
- [ ] **Drop the backup rung's endpoint too:** ladder shifts down again to the local
      terminus.
- [ ] **Restore the brain endpoint:** after `recoveryThreshold` successes the pill
      walks back up to the primary; the next turn runs on it.
- [ ] **Retry indicator:** during a pending flip the pill shows `◌ checking N/M`
      (dropping) / `◌ reconnecting N/M` (recovering).
- [ ] **Stranding guard:** with a config that has NO local terminus, drop the only
      probed rung → pill shows `⊗ no model`; the agent stays on the current model
      (no switch to a dead endpoint); a toast warns "no model reachable."

## Phase 1 — network/action axis

- [ ] **No `networkProbe` (or empty):** when on the local rung, the injected note is
      the **offline/queue** variant ("actions UNAVAILABLE … queue"). (v1 behavior.)
- [ ] **`networkProbe` set, internet up, brain down:** on the fallback rung the note
      is the **degraded-but-online** variant ("actions still work … just a different
      model") — it must NOT say "queue."
- [ ] **`networkProbe` set, internet down:** note returns to the offline/queue variant.
- [ ] **`/pivot status`** shows both axes — `… · actions online|offline|unknown`.

## Manual override (R5)

- [ ] `/pivot offline` → routes to the first local/degraded rung; pill `⊘ forced offline`.
- [ ] `/pivot online` while the primary probe is **unreachable** → still forces the
      primary (user choice trumps) AND prints a `⚠ … appears unreachable` warning.
- [ ] `/pivot auto` → returns to automatic ladder walking.
- [ ] Override **survives `/reload`** (persisted in `autopivot.state.json`).

## Honesty episode hygiene

- [ ] Entering a degraded episode injects the note **once** (transition mode); staying
      degraded does not re-inject; leaving and re-entering injects again.
- [ ] On a **non-local** backend (or memfs disabled), routing still switches but **no**
      honesty note is injected.

---

# Phase 3a — stall watchdog (completion-failure failover)

Validated 2026-07-01. Force a deterministic completion failure with a rung that is
**reachable but fails the call** — e.g. a litellm model pointed at a bogus API key (401,
which leaves an `llm_start` with no `llm_end`). Set a short global `stall.timeoutMs`
(~10s) so it trips fast, and a large per-rung `stall.timeoutMs` (~300s) on the local
fallback so a slow cold turn can't false-suspend it.

Config shape:
- `primary` = the failing rung (bogus-key model)
- `rules[0]` = a working local fallback with `stall: { timeoutMs: 300000 }`
- `stall: { timeoutMs: 10000 }`

## Detect → suspend → fail over → STAY

- [ ] Send a turn on the failing primary → it errors (401) immediately in the TUI.
- [ ] ~10s later: toast **"<primary> failed → now on <fallback>. Resend your message;
      /pivot online to retry."**; pill flips to `⚑ on fallback`.
- [ ] Next turn runs on the **fallback** and answers.
- [ ] **Key: it STAYS on the fallback** across further turns — no bounce back to the
      still-broken primary (sticky suspension).
- [ ] `/pivot status` lists `suspended: rung 0 (<primary>) — failed ×N; /pivot online to retry`.

## Recovery + guards

- [ ] `/pivot online` clears the suspension and retries the primary (fails again →
      re-suspends). `/pivot auto` also clears.
- [ ] A normal slow-but-successful turn on the fallback (≤ its per-rung timeout) does
      **not** suspend it (`llm_end`/`turn_end` settle the watch).
- [ ] Never-strand: with the fallback as the last rung, a fallback stall does **not**
      suspend it out from under you (announces "all rungs failing — /pivot online").

## Verified event facts (probe mod, `spike/probe-llm-failure.mjs`)

- A **failed** turn fires `llm_start` then **0** `llm_end` / **0** `turn_end` — the stall
  watchdog is the only signal, and a mod **cannot** self-start an auto-resend.
- A **successful** turn fires both `llm_end` (`stop`) and `turn_end` (`end_turn`).
