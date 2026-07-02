/**
 * AutoPivot — `/pivot status` text (pure).
 *
 * Information architecture (Plan Review design #7): lead with the single fact the
 * user wants — the effective mode + active model + auto/forced — THEN the
 * per-condition detail, THEN a how-to-revert hint. The headline is line 1 so a
 * headless user (no pill) gets the answer immediately.
 *
 * `actions` is the network/action axis (Phase 1), separate from the model/rung
 * axis: "online" | "offline" | "unknown" when a networkProbe is configured, or
 * null/undefined to omit it (don't clutter the headline when unconfigured).
 */
export function buildStatusText({ modeLabel, model, manualMode, conditions, actions }) {
  const lines = [];
  const forced = manualMode && manualMode !== "auto" ? `forced ${manualMode}` : "auto";
  const actionsStr = actions ? ` · actions ${actions}` : "";
  lines.push(`AutoPivot — ${modeLabel ?? "primary"} · ${model ?? "(no model)"} · ${forced}${actionsStr}`);

  for (const c of conditions ?? []) {
    const m = typeof c.metric === "function" ? c.metric() : null;
    const metricStr = m
      ? ` [${m.label} ${m.value}${m.ceiling != null && isFinite(m.ceiling) ? "/" + m.ceiling : ""}]`
      : "";
    lines.push(`  - ${c.id}: ${c.active ? "active" : "inactive"}${metricStr}`);
  }

  lines.push(
    manualMode && manualMode !== "auto"
      ? "  override active — /pivot auto to resume automatic switching"
      : "  /pivot offline | /pivot online to override, /pivot auto for automatic",
  );
  return lines.join("\n");
}
