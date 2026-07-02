/**
 * AutoPivot — runtime state (manual override), persisted to
 * ~/.letta/mods/autopivot.state.json so it survives /reload.
 *
 * Security (Plan Review security #5): the state file is a trust boundary — we
 * validate its values against the known set of modes on load (not just "is it
 * valid JSON"). A tampered/garbage value falls back to "auto", so a bad state
 * file can't pin the agent into a forced mode.
 */
const VALID_MODES = ["auto", "online", "offline"];

/** Coerce any parsed value into a safe state object. Never throws. */
export function validateState(raw) {
  const mode = VALID_MODES.includes(raw?.manualMode) ? raw.manualMode : "auto";
  return { manualMode: mode };
}

export async function loadState(path, deps = {}) {
  let read = deps.read;
  if (!read) {
    const { readFileSync } = await import("node:fs");
    read = (p) => readFileSync(p, "utf8");
  }
  try {
    return validateState(JSON.parse(read(path)));
  } catch {
    return { manualMode: "auto" }; // missing or malformed → safe default
  }
}

export async function saveState(path, state, deps = {}) {
  let write = deps.write;
  if (!write) {
    const { writeFileSync } = await import("node:fs");
    write = (p, data) => writeFileSync(p, data);
  }
  // Write the whole validated object at once (atomic-ish) per architecture.md.
  write(path, JSON.stringify(validateState(state), null, 2));
}
