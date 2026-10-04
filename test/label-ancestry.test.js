import "../scripts/mac-test-guard.mjs";
// @ts-check
// LB-2 (reviewer-2, repro rv2-lb2): a person's-surface label becomes a person's chain only when the ancestry was read to the top and found definitely outside. A named server above the
// caller (tmux, ssh), an unreadable process table, a `docker exec` (no parent to read) and a platform that cannot read peers (Windows) are NOT outside: that call is a person only with a
// person session, never by its label. The seams are asTaken's own (peerPid, processTable, insideClaude).
import { test } from "node:test";
import assert from "node:assert/strict";
import { asTaken, callerFacts } from "../core/daemon/index.js";
import { canReadPeers } from "../core/daemon/peer.js";

const reg = { call: async () => ({ data: { pids: [], pgids: [], sids: [] } }), deps: {} };
const k = { id: { owner: "per_" + "a".repeat(26) } };
const LABELS = ["cli", "local"];
const CLAIMS = ["deck", "mobile"];
/** A fresh socket per measurement (asTaken caches per socket). */
const measure = (/** @type {string} */ label, /** @type {any} */ result, /** @type {number | null} */ pid = 4242) => asTaken(label, /** @type {any} */ ({}), reg, undefined, { peerPid: async () => pid, processTable: () => new Map(), insideClaude: () => result, delayMs: 0 });
const factsOf = (/** @type {string} */ label, /** @type {any} */ shell) => callerFacts(shell.caller, {}, null, k, false, null, { inside: shell.model === true, outside: shell.outside === true });

for (const [name, result] of /** @type {[string, any][]} */ ([
  ["an unreadable process table", { inside: false, unknown: true, unreadable: true }],
  ["a named server above the caller (tmux, ssh)", { inside: false, unknown: true, server: { exe: "/usr/bin/tmux", pid: 99, started: "x" } }],
  ["an unknown ancestry", { inside: false, unknown: true }],
])) {
  test(`LB-2: ${name}: no label becomes a person chain`, async () => {
    for (const label of LABELS) {
      const shell = await measure(label, result);
      assert.equal(shell.outside, false, `${label}: not definitely outside`);
      assert.equal(factsOf(label, shell), null, `${label}: no facts`);
    }
  });
}

test("LB-2: a docker exec (no peer pid) is never a person by label", async () => {
  for (const label of LABELS) {
    const shell = await measure(label, { inside: false }, null);
    assert.equal(shell.outside, false);
    // on a platform that reads peers a missing pid is a model's (relabelled mcp); on one that cannot, it is still not outside
    const f = /** @type {any} */ (factsOf(label, shell));
    assert.ok(f === null || f.inside_model_process === true, `${label}: not a person`);
  }
});

test("LB-2: an ancestry read to the top with nothing above is the one outside that gives person facts, and a model's shell is never one", async () => {
  if (!canReadPeers) return; // Windows: no peer read, so no label is ever a person; the test below holds there
  for (const label of LABELS) {
    const out = await measure(label, { inside: false });
    assert.equal(out.outside, true);
    const f = /** @type {any} */ (factsOf(label, out));
    assert.equal(f.kind, "socket"); assert.equal(f.inside_model_process, false);
    const inside = await measure(label, { inside: true, by: 7 });
    assert.equal(inside.model, true); assert.equal(inside.caller, "mcp");
    assert.equal(factsOf(label, inside), null, "under a model the label is relabelled mcp and gets no person facts");
  }
});

test("LB-2: where peers cannot be read (Windows) no label is a person", async () => {
  if (canReadPeers) return;
  for (const label of LABELS) assert.equal(factsOf(label, await measure(label, { inside: false })), null);
});

test("callerFacts needs outside: true as well as inside: false", () => {
  for (const label of LABELS) {
    assert.equal(callerFacts(label, {}, null, k, false, null, { inside: false }), null);
    assert.equal(callerFacts(label, {}, null, k, false, null, { inside: false, outside: false }), null);
  }
});
