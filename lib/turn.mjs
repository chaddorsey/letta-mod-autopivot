/**
 * AutoPivot — turn_start decision + honesty injection.
 *
 * This is the heart of the switch path, kept PURE so it's fully unit-tested; the
 * thin async wiring (calling updateLlmConfig, returning the new input) lives in
 * index.mjs.
 *
 * VERIFIED by the Unit 0 spike (see plan): `event.input` is an ARRAY of messages
 * `[{role, content, otid}]`; `content` is an ARRAY of parts `[{type:"text", text}]`.
 * Injection only reaches the model when we append to the LAST text part and return
 * the modified array — string concatenation silently no-ops. `updateLlmConfig`
 * takes effect on the NEXT turn (N+1), so the pill/desiredModel update immediately
 * while the very first degraded turn may still run on the prior model.
 */

/** Append `note` to the last text part of the message array (the verified shape). */
export function injectNote(input, note) {
  if (!Array.isArray(input)) return input; // unexpected shape → leave untouched
  const out = input.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (!last) return out;
  const c = last.content;
  if (typeof c === "string") {
    last.content = c + note;
  } else if (Array.isArray(c)) {
    const parts = c.map((p) => ({ ...p }));
    for (let i = parts.length - 1; i >= 0; i--) {
      if (typeof parts[i].text === "string") { parts[i] = { ...parts[i], text: parts[i].text + note }; break; }
    }
    last.content = parts;
  } else if (c && typeof c === "object" && typeof c.text === "string") {
    last.content = { ...c, text: c.text + note };
  }
  return out;
}

/**
 * The honest-fallback system note appended to a degraded turn. Two variants,
 * because "which model is active" and "is the network up" are different axes
 * (Phase 1 — split the network signal from rung health):
 *
 *  - "offline" (network down → actions UNAVAILABLE): tell the agent to queue/hold
 *    networked work and not fake success. This is the v1 note and the CONSERVATIVE
 *    DEFAULT (used whenever we can't confirm the network is up — see decideTurn).
 *  - "online" (degraded model but network up, e.g. a provider-specific brain outage
 *    or — later — a spend cap): actions STILL WORK; the only change is the model.
 *    Must NOT tell the agent to queue, or it would wrongly hold work it can perform.
 */
export function buildHonestyNote(modeLabel = "offline", variant = "offline") {
  if (variant === "online") {
    return (
      `\n\n(System note — AutoPivot ${modeLabel}: you are running on a fallback model ` +
      `(a different/local model than usual), but you ARE still online. Networked actions ` +
      `(email, Slack, calendar, web, and fleet/hub tools) still work normally — go ahead and ` +
      `use them. The only difference is the model answering; proceed as usual.)`
    );
  }
  return (
    `\n\n(System note — AutoPivot ${modeLabel}: you are running on a LOCAL model. ` +
    `Networked actions (email, Slack, calendar, web, and fleet/hub tools) are UNAVAILABLE right now — ` +
    `do NOT claim they succeeded. Draft or queue the work, tell the user you've held it for when the ` +
    `connection returns, then continue. Your memory is the last local snapshot.)`
  );
}

/**
 * Decide what this turn should do. PURE — caller applies the result.
 *
 * @param {object} a
 * @param {{model, perMode, modeLabel, isDegraded}} a.target  resolver output
 * @param {string|null} a.currentModelId   ctx.model.id (read-only)
 * @param {{degraded:boolean}} a.episode    mutable-by-caller episode tracker
 * @param {boolean} a.memfsEnabled          ctx.memfs?.enabled (offline-profile guard)
 * @param {"transition"|"every-turn"} a.honestyMode
 * @param {boolean|null} [a.actionsAvailable] network signal (Phase 1): true = network
 *        up (degraded-but-online note); false/null/undefined = can't confirm → the
 *        conservative offline/queue note. Independent of which rung is active.
 * @returns {{switchTo:string|null, perMode:object, shouldInject:boolean, noteVariant:"offline"|"online", episode:{degraded:boolean}}}
 */
export function decideTurn({ target, currentModelId, episode, memfsEnabled, honestyMode = "transition", actionsAvailable = null }) {
  const switchTo = target.model && target.model !== currentModelId ? target.model : null;

  const wasDegraded = episode?.degraded === true;
  const nowDegraded = target.isDegraded === true;
  let shouldInject = false;
  if (nowDegraded && memfsEnabled) {
    if (!wasDegraded) shouldInject = true;                 // entering a degraded episode
    else if (honestyMode === "every-turn") shouldInject = true; // reinforce each turn (opt-in)
    // else: already injected this episode → stay quiet
  }

  // Note variant keys off the NETWORK signal, not the rung. Only `true` (confirmed
  // online) picks the "actions still work" note; anything else stays conservative.
  const noteVariant = actionsAvailable === true ? "online" : "offline";

  return {
    switchTo,
    perMode: target.perMode ?? {},
    shouldInject,
    noteVariant,
    episode: { degraded: nowDegraded }, // caller persists this for the next turn
  };
}
