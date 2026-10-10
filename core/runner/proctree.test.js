// @ts-check
// A session's processes: the tree under the process Vyre started, read from /proc or ps, and a signal that reaches all of it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allProcs, treeOf, signalTree } from "./proctree.js";

/** A /proc stat line: pid (comm) state ppid pgrp ... utime stime ... rss. */
const stat = (pid, comm, ppid, pgrp, utime, stime, rssPages) => {
  const f = Array(52).fill("0"); f[0] = String(pid); f[1] = `(${comm})`; f[2] = "S"; f[3] = String(ppid); f[4] = String(pgrp); f[13] = String(utime); f[14] = String(stime); f[23] = String(rssPages);
  return f.join(" ");
};

test("linux: processes are read from /proc with their parent and group, even when the name holds spaces and brackets", () => {
  const files = { "1": stat(1, "init", 0, 1, 0, 0, 1), "7": stat(7, "a (b) c", 1, 7, 5, 5, 256) };
  const procs = allProcs({ platform: "linux", proc: { pids: () => Object.keys(files).concat("9"), stat: pid => /** @type {any} */ (files)[pid] ?? null } });
  assert.deepEqual(procs.map(p => [p.pid, p.ppid, p.pgid, p.ticks, p.pages]), [[1, 0, 1, 0, 1], [7, 1, 7, 10, 256]], "a process that vanished is skipped");
});

test("macos: processes are read from ps; a line that is not a process is skipped", () => {
  const procs = allProcs({ platform: "darwin", ps: () => "  10     1    10   12.5  204800\n  11    10    11    7.5  102400\n garbage\n" });
  assert.deepEqual(procs.map(p => [p.pid, p.ppid, p.pgid, p.pcpu, p.kb]), [[10, 1, 10, 12.5, 204800], [11, 10, 11, 7.5, 102400]]);
});

test("the tree is everything under the process by parent, wherever its group is, and nothing beside it", () => {
  const P = (/** @type {number} */ pid, /** @type {number} */ ppid, /** @type {number} */ pgid) => ({ pid, ppid, pgid, ticks: 0, pages: 0, pcpu: 0, kb: 0 });
  const procs = [P(10, 1, 10), P(11, 10, 11), P(12, 11, 11), P(13, 12, 13), P(20, 1, 20), P(21, 20, 20)];
  assert.deepEqual(treeOf(10, procs).map(p => p.pid), [10, 11, 12, 13]);
  assert.deepEqual(treeOf(99, procs), [], "a root that is gone has no tree");
});

test("a signal reaches the whole tree, a child forked while the first pass ran is reached by the second, and a process that is gone is ignored", () => {
  const P = (/** @type {number} */ pid, /** @type {number} */ ppid) => ({ pid, ppid, pgid: pid, ticks: 0, pages: 0, pcpu: 0, kb: 0 });
  let calls = 0;
  const procs = () => (++calls === 1 ? [P(10, 1), P(11, 10)] : [P(10, 1), P(11, 10), P(12, 11)]);
  const sent = /** @type {[number, string][]} */ ([]);
  const n = signalTree(10, "SIGSTOP", { procs, kill: (pid, sig) => { if (pid === 11) throw Object.assign(new Error("gone"), { code: "ESRCH" }); sent.push([pid, sig]); } });
  assert.deepEqual(sent, [[10, "SIGSTOP"], [12, "SIGSTOP"]]);
  assert.equal(n, 3);
});

test("a Mac preview reaches a loopback port only when every listener on it is the session's own process (row 27)", async () => {
  const { portIsSessions, listenersOf } = await import("./proctree.js");
  const P = (/** @type {number} */ pid, /** @type {number} */ ppid) => ({ pid, ppid, pgid: pid, ticks: 0, pages: 0, pcpu: 0, kb: 0 });
  const procs = () => [P(10, 1), P(11, 10), P(12, 11), P(50, 1)];
  const lsof = (/** @type {number} */ port) => port === 3000 ? "p12\n" : port === 5432 ? "p50\n" : port === 4000 ? "p12\np50\n" : "";
  assert.deepEqual(listenersOf(3000, { lsof }), [12]);
  assert.equal(portIsSessions(10, 3000, { lsof, procs }), true, "the chat's own dev server");
  assert.equal(portIsSessions(10, 5432, { lsof, procs }), false, "a database outside the session");
  assert.equal(portIsSessions(10, 4000, { lsof, procs }), false, "one foreign listener is enough to refuse");
  assert.equal(portIsSessions(10, 9999, { lsof, procs }), false, "nothing listening");
  assert.equal(portIsSessions(10, 3000, { lsof: () => { throw new Error("lsof gone"); }, procs }), false, "no answer from lsof is no");
});
