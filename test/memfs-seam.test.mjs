import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMemfsSeam } from "../lib/memfs-seam.mjs";

// Fake git: responds to argv. Records calls so we can assert argv (no-shell) safety.
function fakeGit(responses, calls) {
  return async (args, cwd) => {
    calls?.push({ args, cwd });
    const key = args.join(" ");
    for (const [pat, val] of Object.entries(responses)) {
      if (key.startsWith(pat)) return val;
    }
    return "";
  };
}

test("default OFF → onLinkChange does nothing, no callback", async () => {
  let called = 0;
  const seam = makeMemfsSeam({ enabled: false }, () => called++, { exec: fakeGit({}) });
  seam.setMemoryDir("/mem");
  await seam.onLinkChange(true);
  await seam.onLinkChange(false);
  assert.equal(called, 0);
});

test("enabled: offline flip captures baseline; online flip emits paths+SHAs once", async () => {
  const calls = [];
  let payload = null;
  const git = fakeGit({
    "rev-parse HEAD": "BASESHA\n",
    "diff --name-only": "system/human.md\nreference/x.md\n",
    "status --porcelain": " M system/human.md\n?? new.md\n",
    "log --format=%H": "C2\nC1\n",
  }, calls);
  const seam = makeMemfsSeam({ enabled: true }, (e) => { payload = e; }, { exec: git });
  seam.setMemoryDir("/mem");

  await seam.onLinkChange(true);  // offline → baseline captured
  assert.equal(seam._state().offline, true);
  assert.equal(seam._state().baseline, "BASESHA");

  await seam.onLinkChange(false); // reconnect → emit
  assert.ok(payload, "onReconnect should fire");
  assert.deepEqual(payload.commits, ["C2", "C1"]);
  // paths = union of committed (diff) + dirty (status), contents NOT included
  assert.ok(payload.changedPaths.includes("system/human.md"));
  assert.ok(payload.changedPaths.includes("new.md"));
  assert.equal(JSON.stringify(payload).includes("content"), false);

  // argv safety: git invoked with array args + cwd, never a shell string
  assert.ok(calls.every((c) => Array.isArray(c.args) && c.cwd === "/mem"));
});

test("no memoryDir → inert", async () => {
  let called = 0;
  const seam = makeMemfsSeam({ enabled: true }, () => called++, { exec: fakeGit({ "rev-parse HEAD": "X" }) });
  await seam.onLinkChange(true);
  await seam.onLinkChange(false);
  assert.equal(called, 0);
});

test("git errors / callback throw are isolated (never throw out)", async () => {
  const seam = makeMemfsSeam({ enabled: true }, () => { throw new Error("integrator boom"); }, {
    exec: async () => { throw new Error("git boom"); },
  });
  seam.setMemoryDir("/mem");
  await assert.doesNotReject(seam.onLinkChange(true));
  await assert.doesNotReject(seam.onLinkChange(false));
});
