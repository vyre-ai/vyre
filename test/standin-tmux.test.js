import "../scripts/mac-test-guard.mjs";
// reviewer-2 repro SI-1b against work/signin 4c8fc7093 (drop into test/): the stand-in allow-list is by program name and folder. A model under a claude can start its own tmux server
// (`tmux new-session -d 'vyre call ...'`): the server is user-owned, daemonized (parent init, own group), runs from /usr/bin, and has no claude above it, so insideClaude names it a server.
import test from "node:test";
import assert from "node:assert/strict";
import { insideClaude } from "../core/daemon/peer.js";
import { surfaceAncestry } from "../core/daemon/index.js";

test("SI-1b: a user-owned tmux server a model started must not make its panes the owner", () => {
  // the pane's command (vyre call) -> sh -> tmux: server (uid 1000, started a moment ago by the model's own tmux client, parent init, own group)
  const rows = { 100: { ppid: 1, args: "/usr/bin/node vyred", pgid: 100, sid: 100, uid: 1000, start: 1 },
    900: { ppid: 1, args: "tmux new-session -d vyre call records.define", pgid: 900, sid: 900, uid: 1000, start: 5 },
    901: { ppid: 900, args: "sh -c vyre call records.define", pgid: 901, sid: 901, uid: 1000, start: 5 } };
  const r = insideClaude(901, { look: p => rows[p] || null, exe: p => (p === 900 ? "/usr/bin/tmux" : "/bin/sh"), started: () => "t5", uid: p => (rows[p] || {}).uid, self: 100, threads: [] });
  console.log("insideClaude:", JSON.stringify(r));
  const server = { ...(r.server || {}), uid: 1000 };
  const widened = surfaceAncestry({ model: Boolean(r.inside), outside: false, server }, true);
  console.log("surfaceAncestry with the stand-in file:", JSON.stringify(widened));
  assert.equal(widened.outside, false, "a server any user process can start (uid 1000) must not widen to the owner; only a root-owned login server (sshd, login) can");
});
