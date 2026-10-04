// reviewer-2 repro SI-1 against work/kernel-lb1 de955f6cf (drop into test/): with the dev stand-in file, a setsid'd, daemonized model process (parent init, own process group) is named a server by insideClaude
// ("unknown", not inside), asTaken keeps its label (model false), and surfaceAncestry turns "not inside a model" into outside: a person chain from a label.
import test from "node:test";
import assert from "node:assert/strict";
import { insideClaude } from "../core/daemon/peer.js";
import { surfaceAncestry } from "../core/daemon/index.js";

test("SI-1: a daemonized (setsid) model child must never count as outside, stand-in or not", () => {
  const rows = { 100: { ppid: 1, args: "/usr/bin/node vyred", pgid: 100, sid: 100, uid: 1000, start: 1 }, 4242: { ppid: 1, args: "/bin/sh -c vyre call records.define", pgid: 4242, sid: 4242, uid: 1000, start: 2 } };
  const look = pid => rows[pid] || null;
  const r = insideClaude(4242, { look, exe: () => "/bin/sh", started: () => "t0", uid: () => 1000, self: 100, threads: [] });
  console.log("insideClaude for the setsid'd child:", JSON.stringify(r));
  // asTaken: model = inside, so a result of { inside:false, unknown:true, server } is model:false; outside:false (LB-2)
  const shell = { model: Boolean(r.inside), outside: false };
  const without = surfaceAncestry(shell, false), withFile = surfaceAncestry(shell, true);
  console.log("surfaceAncestry without the stand-in file:", JSON.stringify(without), "with it:", JSON.stringify(withFile));
  assert.equal(withFile.outside, false, "a model that daemonized must not become the owner because a dev box holds the stand-in file");
});
