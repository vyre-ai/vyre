// @ts-check
// A session's processes: the tree under the process Vyre started, read from /proc or ps, and a signal that reaches all of it.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { allProcs, treeOf, signalTree, killTree } from "./proctree.js";

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

test("a tree is ended without a leak: every process found is stopped before any is killed, a child that shows up in a later look is stopped too, and one whose parent is killed first is not lost (the reader's second process)", () => {
  const P = (/** @type {number} */ pid, /** @type {number} */ ppid) => ({ pid, ppid, pgid: pid, ticks: 0, pages: 0, pcpu: 0, kb: 0 });
  let looks = 0;
  // the first look sees the wrapper and the namespace's init; by the second, init has forked the reader's program
  const procs = () => (++looks === 1 ? [P(10, 1), P(11, 10)] : [P(10, 1), P(11, 10), P(12, 11)]);
  const sent = /** @type {[number, string][]} */ ([]);
  const n = killTree(10, { procs, kill: (pid, sig) => { sent.push([pid, sig]); } });
  assert.equal(n, 3);
  const firstKill = sent.findIndex(x => x[1] === "SIGKILL");
  assert.ok(sent.slice(0, firstKill).every(x => x[1] === "SIGSTOP") && sent.slice(0, firstKill).length === 3, "all three are stopped before the first is killed");
  assert.deepEqual(sent.slice(firstKill).map(x => x[0]).sort(), [10, 11, 12]);
  assert.ok(sent.slice(firstKill).every(x => x[1] === "SIGKILL"));
  // a process that is already gone does not stop the rest
  const gone = killTree(10, { procs: () => [P(10, 1), P(11, 10)], kill: (pid) => { if (pid === 11) throw Object.assign(new Error("gone"), { code: "ESRCH" }); } });
  assert.equal(gone, 2);
});

test("killTree never signals pid 1 or this process: a wrong root ends nothing, and a walk that reaches either skips it (trust)", () => {
  const P = (/** @type {number} */ pid, /** @type {number} */ ppid) => ({ pid, ppid, pgid: pid, ticks: 0, pages: 0, pcpu: 0, kb: 0 });
  const sent = /** @type {[number, string][]} */ ([]);
  const kill = (/** @type {number} */ pid, /** @type {string} */ sig) => { sent.push([pid, sig]); };
  assert.equal(killTree(1, { procs: () => [P(1, 0), P(20, 1)], kill }), 0);
  assert.equal(killTree(0, { procs: () => [P(20, 1)], kill }), 0);
  assert.equal(killTree(process.pid, { procs: () => [P(process.pid, 1), P(20, process.pid)], kill }), 0);
  assert.deepEqual(sent, [], "a refused root sends nothing");
  // a normal root whose walk reaches this process and pid 1 (a reparented tree): they are skipped, the rest ended
  const n = killTree(30, { procs: () => [P(30, 1), P(31, 30), P(process.pid, 31), P(1, 31)], kill });
  assert.equal(n, 2);
  assert.ok(sent.every(x => x[0] !== process.pid && x[0] !== 1), "neither was signalled");
  assert.deepEqual([...new Set(sent.map(x => x[0]))].sort(), [30, 31]);
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

test("killTree waits for a stop to take effect: a process that was forking when it was signalled still makes its child, and the child is ended too (the CI leak)", () => {
  const P = (/** @type {number} */ pid, /** @type {number} */ ppid, /** @type {string} */ state) => ({ pid, ppid, pgid: pid, ticks: 0, pages: 0, pcpu: 0, kb: 0, state });
  let reads = 0, stopAt = Infinity;
  /** @type {[number, string][]} */ const sent = [];
  // read 1: the root alone, running. Its stop lands only after read 4 (a loaded runner); the fork it was in the middle of shows up at read 3.
  const procs = () => {
    reads++;
    const stopped = reads > stopAt;
    const root = P(10, 1, stopped ? "T" : "R");
    return reads < 3 ? [root] : [root, P(11, 10, stopped ? "T" : "R")];
  };
  const n = killTree(10, { procs, kill: (pid, sig) => { sent.push([pid, sig]); if (sig === "SIGSTOP" && stopAt === Infinity) stopAt = 4; }, sleep: () => {} });
  assert.equal(n, 2, "the late child was found");
  assert.ok(sent.some(([pid, sig]) => pid === 11 && sig === "SIGSTOP"), "and stopped");
  assert.ok(sent.some(([pid, sig]) => pid === 11 && sig === "SIGKILL"), "and killed: " + JSON.stringify(sent));
});
