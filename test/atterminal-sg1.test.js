import "../scripts/mac-test-guard.mjs";
// SG-1 (reviewer-2): the terminal check `vyre signin` uses. The caller's named server must be a root login server (sshd, login); a user-owned named server, which is what a model that
// double-forks and keeps the person's tty looks like, gets no key even when `who` lists that tty. A tmux client must read as the person's own: not inside a model and not an unknown chain
// unless it tops out at a login server. The ssh and tmux-over-ssh happy paths keep their key, and the key carries where the login came from (SG-2).
import test from "node:test";
import assert from "node:assert/strict";
import { atTerminal } from "../core/daemon/index.js";

const LOGIN = { exe: "uid0", uid: 0, comm: "sshd", cmd: "sshd: /usr/sbin/sshd -D [listener]", pid: 10, started: "t" };
const ORPHAN = { exe: "/usr/bin/node", uid: 1000, pid: 4242, started: "t" };
const TMUX = { exe: "/usr/bin/tmux", uid: 1000, pid: 700, started: "t" };
const registry = { call: async () => ({ data: { pids: [] } }), deps: {} };
const presence = { who: async () => ["pts/0"] };
const world = ({ above, clients = null, ins = {}, login = { tty: "pts/0", key: "pts/0#9@1" } }) => ({
  above: async () => above, peerPid: async () => 9, loginOf: pid => (pid === 9 ? login : (ins[pid] && ins[pid].login) || null), tmuxClients: () => clients,
  insideClaude: pid => (ins[pid] && ins[pid].walk) || { inside: false }, loginFrom: async () => "203.0.113.9",
});

test("an ssh login (unknown, a root login server on top) gets a key and says where it came from", async () => {
  const r = await atTerminal({}, registry, presence, false, world({ above: { inside: false, unknown: true, server: LOGIN } }));
  assert.deepEqual(r, { key: "pts/0#9@1", tty: "pts/0", from: "203.0.113.9" });
});
test("a process the walk can read to the top (outside) gets a key", async () => {
  assert.ok(await atTerminal({}, registry, presence, false, world({ above: { inside: false } })));
});
test("the orphan shape (parent init, own group, user-owned exe, the person's listed tty) is refused", async () => {
  assert.equal(await atTerminal({}, registry, presence, false, world({ above: { inside: false, unknown: true, server: ORPHAN } })), null);
});
test("inside a model, no pid, and unknown with no server are refused", async () => {
  for (const above of [{ inside: true }, { nopid: true }, { inside: false, unknown: true }]) assert.equal(await atTerminal({}, registry, presence, false, world({ above })), null, JSON.stringify(above));
});
test("tmux over ssh: the pane's chain tops out at the user-owned tmux, and every client is a login server's person", async () => {
  const w = world({ above: { inside: false, unknown: true, server: TMUX }, clients: [50], ins: { 50: { walk: { inside: false, unknown: true, server: LOGIN }, login: { tty: "pts/0", key: "pts/0#50@2" } } } });
  const r = await atTerminal({}, registry, presence, false, w);
  assert.equal(r && r.key, "tmux:pts/0#50@2");
  assert.equal(r && r.from, "203.0.113.9");
});
test("a tmux orphan client (unknown, user-owned server) or a client inside a model is refused", async () => {
  for (const walk of [{ inside: false, unknown: true, server: ORPHAN }, { inside: true }]) {
    const w = world({ above: { inside: false, unknown: true, server: TMUX }, clients: [50], ins: { 50: { walk, login: { tty: "pts/0", key: "k" } } } });
    assert.equal(await atTerminal({}, registry, presence, false, w), null, JSON.stringify(walk));
  }
});
test("the development stand-in keeps its own rules (it is the only thing that replaces the guard)", async () => {
  assert.ok(await atTerminal({}, registry, presence, true, world({ above: { inside: false, unknown: true, server: ORPHAN } })));
});
