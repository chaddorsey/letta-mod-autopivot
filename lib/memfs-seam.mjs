/**
 * AutoPivot — memory-sync seam (Unit 7). OFF by default.
 *
 * Local memory works offline natively (letta-code auto-commits); single-machine
 * users need NOTHING here. This seam exists only for the minority who run the same
 * agent on more than one machine: when enabled, it emits the set of memory edits
 * made DURING an offline window to a user-supplied `onReconnect` callback so their
 * own sync routine can push them. The mod NEVER performs the sync itself.
 *
 * Boundary (Plan Review #9): this emits OFFLINE-WINDOW edits only — it is NOT a
 * complete "unsynced changes" feed (edits made while online are not included).
 *
 * Security (Review security #3/#4): git runs via argv (execFile, NO shell), with
 * `memoryDir` passed as `cwd` (never string-interpolated). The payload is changed
 * file PATHS + commit SHAs — NOT file contents. The contract documents that
 * onReconnect runs at the integrator's trust level and may reference sensitive
 * memory; the mod does not redact.
 */

function makeGit(deps) {
  // exec(args, cwd) -> Promise<stdout string>. Injectable for tests.
  if (deps.exec) return deps.exec;
  return async (args, cwd) => {
    const { execFile } = await import("node:child_process");
    return await new Promise((res) => {
      execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => res(err ? "" : String(stdout)));
    });
  };
}

export function makeMemfsSeam(cfg, onReconnect, deps = {}) {
  const enabled = cfg?.enabled === true && typeof onReconnect === "function";
  const git = makeGit(deps);
  let memoryDir = null;
  let offline = false;
  let baseline = null;

  async function captureBaseline() {
    baseline = (await git(["rev-parse", "HEAD"], memoryDir)).trim() || null;
  }

  async function computeEdits() {
    if (!baseline) return { baseline: null, head: null, changedPaths: [], commits: [] };
    const head = (await git(["rev-parse", "HEAD"], memoryDir)).trim() || null;
    const committed = (await git(["diff", "--name-only", `${baseline}..HEAD`], memoryDir))
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const dirty = (await git(["status", "--porcelain"], memoryDir))
      .split("\n").map((s) => s.slice(3).trim()).filter(Boolean); // strip XY status prefix
    const commits = (await git(["log", "--format=%H", `${baseline}..HEAD`], memoryDir))
      .split("\n").map((s) => s.trim()).filter(Boolean);
    const changedPaths = Array.from(new Set([...committed, ...dirty]));
    return { baseline, head, changedPaths, commits };
  }

  return {
    setMemoryDir(dir) { if (dir) memoryDir = dir; },
    /** Drive from connectivity flips. isOffline true=offline. Fire-and-forget. */
    async onLinkChange(isOffline) {
      if (!enabled || !memoryDir) return;
      try {
        if (isOffline && !offline) { offline = true; await captureBaseline(); }
        else if (!isOffline && offline) {
          offline = false;
          const edits = await computeEdits();
          baseline = null;
          try { onReconnect(edits); } catch { /* integrator's callback isolated */ }
        }
      } catch { /* seam must never break the mod */ }
    },
    _state: () => ({ enabled, memoryDir, offline, baseline }),
  };
}
