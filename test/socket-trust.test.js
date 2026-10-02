// Inverted socket trust: a person's label on the socket (cli, local, deck, capsule, mobile) is only a claim, and
// a child that left the claude ancestry (setsid, nohup, a launchd or cron job an agent wrote) sends the same
// label. It is kept only for a peer that proves it is the person: the pinned Capsule, a terminal login that
// `who` lists with the peer in its foreground process group, or a server the person already proved. Everything
// else is capped at mcp, silently (reviewer-2, 2 Oct 2026). Unit level, with the daemon's own seams: no daemon,
// no terminal needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asTaken, trustedServers } from "../core/daemon/index.js";
import { ptyHosted } from "../core/daemon/peer.js";
import { setSocketTrust, socketTrust } from "../core/daemon/peer.js";
import "./helpers.js";

const registry = pin => ({ call: async () => ({ data: { pids: [] } }), deps: { presence: { capsulePin: () => pin || null, who: async () => ["ttys001"] } } });
const deps = (over = {}) => ({ peerPid: async () => 50, alive: () => true, delayMs: 1, insideClaude: () => ({ inside: false }),
  terminal: async () => null, foreground: () => null, ...over });
const strict = async fn => { const was = socketTrust(); setSocketTrust("strict"); try { await fn(); } finally { setSocketTrust(was); } };
const person = ["cli", "local", "deck", "capsule", "mobile"];

test("a detached child (no terminal) claiming a person label is capped at mcp", () => strict(async () => {
  for (const label of person) {
    const r = await asTaken(label, {}, registry(), undefined, deps());
    assert.deepEqual([r.caller, r.model, r.capped], ["mcp", true, true], label);
  }
  // Inside a session it becomes that session's own label, as before.
  assert.equal((await asTaken("cli", {}, registry(), "t1", deps())).caller, "mcp:thread:t1");
}));

test("the person's own terminal login, in the foreground, keeps cli and local", () => strict(async () => {
  const term = deps({ terminal: async () => ({ key: "ttys001#812@t", tty: "ttys001" }), foreground: () => ({ pgid: 900, tpgid: 900 }) });
  for (const label of ["cli", "local"]) assert.deepEqual(await asTaken(label, {}, registry(), undefined, term), { caller: label, model: false }, label);
}));

test("a nohup or background child on the person's terminal has the tty but not the foreground group: capped", () => strict(async () => {
  const bg = deps({ terminal: async () => ({ key: "ttys001#812@t", tty: "ttys001" }), foreground: () => ({ pgid: 901, tpgid: 900 }) });
  const r = await asTaken("cli", {}, registry(), undefined, bg);
  assert.deepEqual([r.caller, r.capped], ["mcp", true]);
  // A terminal with no readable process group is not proof either.
  assert.equal((await asTaken("cli", {}, registry(), undefined, deps({ terminal: async () => ({ key: "k", tty: "t" }), foreground: () => null }))).caller, "mcp");
}));

test("the pinned Capsule keeps its label; another binary claiming it does not", () => strict(async () => {
  const pin = { cdhash: "a".repeat(40) };
  const seam = h => ({ started: () => "t1", cdhash: () => h });
  const cap = h => deps({ insideClaude: () => ({ inside: false, unknown: true }), capsuleSeam: seam(h) });
  assert.deepEqual(await asTaken("capsule", {}, registry(pin), undefined, cap("a".repeat(40))), { caller: "capsule", model: false });
  assert.equal((await asTaken("capsule", {}, registry(pin), undefined, cap("b".repeat(40)))).caller, "mcp", "a different build");
  assert.equal((await asTaken("cli", {}, registry(pin), undefined, cap("a".repeat(40)))).caller, "mcp", "the Capsule's shape under another label proves nothing");
}));

test("labels that are not a person's are untouched, and the label mode keeps the old behaviour", async () => {
  await strict(async () => {
    for (const label of ["mcp", "harness", "mcp:agent:kit", "anonymous"]) assert.equal((await asTaken(label, {}, registry(), undefined, deps())).caller, label, label);
  });
  const was = socketTrust();
  setSocketTrust("label");
  try { assert.equal((await asTaken("cli", {}, registry(), undefined, deps())).caller, "cli", "tests host vyred without a terminal"); }
  finally { setSocketTrust(was); }
});

test("under a server the person proved (VS Code, iTerm2) only a peer with its own pty in the foreground keeps the label", () => strict(async () => {
  const server = { exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron", pid: 700, started: "t7" };
  trustedServers.set(`${server.exe}:${server.pid}:${server.started}`, true);
  try {
    const under = over => deps({ insideClaude: () => ({ inside: false, unknown: true, server }), ...over });
    // The person's own vyre in an integrated terminal: a pty, in its foreground group.
    const term = under({ tty: () => "ttys002", foreground: () => ({ pgid: 812, tpgid: 812 }), ptyHosted: () => true });
    assert.deepEqual(await asTaken("cli", {}, registry(), undefined, term), { caller: "cli", model: false });
    // An extension host child, a task or Copilot, Cline, Continue: no pty at all.
    const ext = under({ tty: () => null, foreground: () => ({ pgid: 900, tpgid: 0 }) });
    const r = await asTaken("cli", {}, registry(), undefined, ext);
    assert.deepEqual([r.caller, r.unproven], ["cli", true], "the proof prompt path stays open for a person's tool; route() caps everything else");
    // A pty the child made itself (script, python pty.spawn, node-pty) under an extension host: a pty and its foreground, but not the host's.
    const own = under({ tty: () => "ttys009", foreground: () => ({ pgid: 950, tpgid: 950 }), ptyHosted: () => false });
    assert.equal((await asTaken("cli", {}, registry(), undefined, own)).unproven, true);
    // A pty but a background group: not the person's foreground command.
    const bg = under({ tty: () => "ttys002", foreground: () => ({ pgid: 901, tpgid: 812 }) });
    assert.equal((await asTaken("local", {}, registry(), undefined, bg)).unproven, true);
  } finally { trustedServers.delete(`${server.exe}:${server.pid}:${server.started}`); }
}));

test("ptyHosted: the integrated terminal's chain passes; a pty an extension host child made for itself does not", () => {
  const table = rows => pid => rows[pid] || null;
  const APP = "/Applications/Visual Studio Code.app/Contents/MacOS/Electron", HELPER = "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper";
  const server = { pid: 700, exe: APP };
  const seam = exes => ({ exe: pid => exes[pid] ?? null, uid: pid => (pid === 13 ? 0 : 1000) });
  // vyre -> zsh (ttys002) -> ptyHost (no tty) -> VS Code
  const real = table({ 10: { ppid: 11, tty: "ttys002", args: "vyre status" }, 11: { ppid: 20, tty: "ttys002", args: "-zsh" },
    20: { ppid: 700, tty: null, args: "Code Helper --type=utility ptyHost" } });
  assert.equal(ptyHosted(10, server, real, seam({ 20: HELPER })), true);
  // The same words in an argument list of a process that is not the server's own helper: refused.
  assert.equal(ptyHosted(10, server, real, seam({ 20: "/usr/local/bin/node" })), false, "a name in argv is not an identity");
  assert.equal(ptyHosted(10, server, real, seam({})), false, "an unreadable exe is not the host's");
  // iTerm2: vyre -> zsh -> login -> iTermServer -> iTerm2
  const iApp = { pid: 700, exe: "/Applications/iTerm.app/Contents/MacOS/iTerm2" };
  const iterm = table({ 10: { ppid: 11, tty: "ttys001", args: "vyre" }, 11: { ppid: 12, tty: "ttys001", args: "-zsh" }, 12: { ppid: 13, tty: "ttys001", args: "login -fp alex" },
    13: { ppid: 700, tty: null, args: "iTermServer-3.5" } });
  assert.equal(ptyHosted(10, iApp, iterm, seam({ 13: "/Applications/iTerm.app/Contents/MacOS/iTermServer-3.5" })), true);
  // A real `ssh -t` login under a proved sshd (the leader's exe is unreadable, a root key): bash -> sshd user process -> its privileged parent.
  const rootLeader = { pid: 700, exe: "uid0" };
  const ssh = table({ 10: { ppid: 11, tty: "pts/0", args: "vyre status" }, 11: { ppid: 12, tty: "pts/0", args: "-bash" }, 12: { ppid: 13, tty: null, args: "sshd: alex@pts/0" },
    13: { ppid: 700, tty: null, args: "sshd: alex [priv]" } });
  assert.equal(ptyHosted(10, rootLeader, ssh, seam({ 12: "/usr/sbin/sshd" })), true, "the privileged one is unreadable but uid 0");
  // A process that sets its argv0 to "sshd: x": its exe is node, so it is no sshd.
  assert.equal(ptyHosted(10, rootLeader, ssh, seam({ 12: "/usr/bin/node" })), false);
  const fakePriv = table({ 10: { ppid: 11, tty: "pts/0", args: "vyre" }, 11: { ppid: 12, tty: "pts/0", args: "-bash" }, 12: { ppid: 14, tty: null, args: "sshd: x" }, 14: { ppid: 700, tty: null, args: "sshd: x [priv]" } });
  assert.equal(ptyHosted(10, rootLeader, fakePriv, seam({})), false, "unreadable and not uid 0");
  // script -q /dev/null vyre status from an extension host child: the pty's maker (script, node) sits above the pty.
  const viaScript = table({ 10: { ppid: 11, tty: "ttys009", args: "vyre status" }, 11: { ppid: 30, tty: "ttys009", args: "script -q /dev/null vyre status" },
    30: { ppid: 31, tty: null, args: "script -q /dev/null vyre status" }, 31: { ppid: 700, tty: null, args: "Code Helper (Plugin) --type=extensionHost" } });
  assert.equal(ptyHosted(10, server, viaScript, seam({ 30: "/usr/bin/script", 31: HELPER })), false);
  // node-pty or python pty.spawn: the same, the maker has no terminal and no host identity.
  const viaPython = table({ 10: { ppid: 40, tty: "ttys010", args: "vyre" }, 40: { ppid: 41, tty: null, args: "python3 -c import pty; pty.spawn" }, 41: { ppid: 700, tty: null, args: "node ext.js" } });
  assert.equal(ptyHosted(10, server, viaPython, seam({})), false);
  // No terminal at all, or a chain that never reaches the server.
  assert.equal(ptyHosted(10, server, table({ 10: { ppid: 700, tty: null, args: "vyre" } }), seam({})), false);
  assert.equal(ptyHosted(10, server, table({ 10: { ppid: 99, tty: "ttys1", args: "vyre" }, 99: { ppid: 1, tty: "ttys1", args: "zsh" } }), seam({})), false);
  // A second helper in the chain is not a terminal host.
  const two = table({ 10: { ppid: 11, tty: "t", args: "vyre" }, 11: { ppid: 12, tty: null, args: "ptyHost" }, 12: { ppid: 700, tty: null, args: "ptyHost" } });
  assert.equal(ptyHosted(10, server, two, seam({ 11: HELPER, 12: HELPER })), false);
});
