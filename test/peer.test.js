// peer: vyred reads which process is on the socket and refuses a person-only call from inside a
// Claude session, however it labels itself. A fake `claude` (a node script by that name, as `ps`
// shows a real one) runs the client; the same client run straight from the test is allowed.

import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
process.env.VYRE_SEAL_SOFTWARE = "1"; // device-key proofs on a development-kind daemon (the release rule is in test/presence-strength.test.js)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { SURFACE_LABELS } from "../core/modules/index.js";
import { above } from "../core/daemon/index.js";
import { setPeerHosting, peerHosting, ancestry, insideClaude, controllingTty, exePath, processUid, loginOf, tmuxClients,
  verifiedCapsule, parseCodesign, signatureOf } from "../core/daemon/peer.js";

const tree = {
  // vyred (500) under the test runner (400); a terminal zsh (200) and a claude (300) elsewhere.
  400: { ppid: 1, args: "node --test" }, 500: { ppid: 400, args: "node vyred" },
  200: { ppid: 1, pgid: 200, args: "/bin/zsh -l" }, 210: { ppid: 200, args: "vyre threads answer" },
  300: { ppid: 200, args: "node /usr/local/bin/claude" }, 310: { ppid: 300, args: "/bin/bash -c vyre call threads.answer" }, 311: { ppid: 310, args: "vyre call threads.answer" },
  600: { ppid: 500, args: "/opt/claude-code/cli.js --session-id x" }, 610: { ppid: 600, args: "curl --unix-socket" },
  700: { ppid: 400, args: "/Users/alex/.local/bin/claude" },
  // On the box: the person over ssh, in tmux; a claude someone runs in a tmux pane; tmux a model opened.
  800: { ppid: 1, pgid: 800, args: "sshd: alex [priv]" }, 801: { ppid: 800, args: "-bash" }, 802: { ppid: 801, args: "vyre vault reveal northwind-mail" },
  900: { ppid: 1, pgid: 900, args: "tmux new -s work" }, 901: { ppid: 900, args: "-bash" }, 902: { ppid: 901, args: "vyre gate approve g1" },
  910: { ppid: 900, args: "-bash" }, 911: { ppid: 910, args: "claude" }, 912: { ppid: 911, args: "/bin/sh -c vyre gate approve g1" },
  920: { ppid: 310, args: "tmux new -d" }, 921: { ppid: 920, args: "vyre gate approve g1" },
  // An orphan a thread left behind (nohup .. &, then its shell exited): parent init, group the thread's.
  940: { ppid: 1, pgid: 600, args: "vyre threads answer" },
  // An orphan of a shell whose group is gone (nohup .. & under a terminal claude, the shell exited),
  // and the Capsule, which launchd started as its own group.
  950: { ppid: 1, pgid: 949, args: "sh -c sleep 2; vyre call link.call" }, 951: { ppid: 950, pgid: 949, args: "vyre call link.call" },
  960: { ppid: 1, pgid: 960, args: "/Applications/Vyre.app/Contents/MacOS/Vyre" },
  // A link vyred cannot read (the process ended mid-walk).
  990: { ppid: 989, args: "vyre threads answer" },
};
const look = pid => tree[pid] || null;

test("peer: the ancestry walks up to init, and says when it could not", () => {
  assert.deepEqual(ancestry(311, look), { chain: [311, 310, 300, 200].map(pid => ({ pid, args: tree[pid].args })), complete: true });
  assert.equal(ancestry(990, look).complete, false);
});

test("peer: under a claude, or under a thread vyred runs, is inside; a terminal, ssh, tmux and vyred's own parents are not", () => {
  // Production rules: a test hosting vyred in its own process is a seam (VYRE_TEST_HOSTED), off here.
  const hostedWas = peerHosting();
  setPeerHosting(false);
  try { productionRules(); } finally { setPeerHosting(hostedWas); }
});

/** The person is the one who is proven: a login leader the kernel names, or a server they proved once. */
/** The kernel-verified leader a chain may top out at on this platform (login is forgeable on macOS). */
const LEADER = process.platform === "darwin" ? "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" : "/usr/bin/login";
const exeOf = pid => ({ 200: LEADER, 800: "/usr/sbin/sshd", 900: "/usr/bin/tmux" }[pid] || null);
function productionRules() {
  const o = { look, self: 500, threads: [600], exe: exeOf, started: () => "t1", uid: () => 501 };
  assert.deepEqual(insideClaude(311, o), { inside: true, by: 300 }, "a model's Bash under a terminal claude");
  assert.deepEqual(insideClaude(610, o), { inside: true, by: 600 }, "a headless thread's child, whatever its command line says");
  assert.deepEqual(insideClaude(210, o), { inside: false }, "the person's own terminal: a login the kernel names");
  assert.deepEqual(insideClaude(802, o), { inside: false, unknown: true, server: { exe: "/usr/sbin/sshd", pid: 800, started: "t1", uid: 501 } }, "the person over ssh: a server they prove once");
  assert.deepEqual(insideClaude(902, o), { inside: false, unknown: true, server: { exe: "/usr/bin/tmux", pid: 900, started: "t1", uid: 501 } }, "the person's shell in tmux: the same");
  assert.deepEqual(insideClaude(912, o), { inside: true, by: 911 }, "claude in a tmux pane");
  assert.deepEqual(insideClaude(940, o), { inside: true, by: 600 }, "an orphan in a thread's process group");
  assert.deepEqual(insideClaude(951, o), { inside: false, unknown: true, unreadable: true }, "an orphan of a shell that is gone: refused as unknown");
  // Leads its own group under launchd, same shape a `setsid`'d escape has (see the dedicated
  // test below): unknown by ancestry alone, no `started` in this fixture to name it a server with.
  // The Capsule is this shape too, and must prove itself another way, not by ancestry (the setsid
  // HIGH, 28 Sep).
  // `started` is left at its real default deliberately nowhere near here: a synthetic pid like
  // 960 can coincide with a REAL process on a shared box, and a real `started()` for it would
  // make this flaky. Every case below that is not testing the server-naming path itself overrides
  // `started: () => null`, same as tests elsewhere in this file override `look` or `exe`.
  const noServer = { started: () => null, exe: () => null };
  assert.deepEqual(insideClaude(960, { ...o, ...noServer }), { inside: false, unknown: true, unreadable: true }, "its own group under launchd, unlisted binary, no start time to name a server: flat unknown");
  // The exact-path allowlist (never a basename: the reviewer's own reproduction, 28 Sep, copied
  // `script` to a file named `login` and it passed the old basename check). login is the one
  // thing left on it -- sshd came off by the lead's decision (a model can get itself an sshd
  // leader too, over `ssh -o BatchMode=yes localhost` with its own appended key).
  assert.deepEqual(insideClaude(960, { ...o, ...noServer, exe: () => LEADER }), { inside: false }, "the kernel says its binary is the real, root-owned /usr/bin/login");
  assert.deepEqual(insideClaude(960, { ...o, ...noServer, exe: () => "/tmp/login" }), { inside: false, unknown: true, unreadable: true }, "a copy at an unlisted path named login: not on the allowlist at all");
  // Everything else with a start time is named as a server rather than flatly refused (the lead's
  // decision, 28 Sep: nobody with a real, unlisted terminal gets locked out) -- sshd included.
  assert.deepEqual(insideClaude(960, { ...o, exe: () => "/usr/sbin/sshd", started: () => "t1" }),
    { inside: false, unknown: true, server: { exe: "/usr/sbin/sshd", pid: 960, started: "t1", uid: 501 } }, "sshd, off the allowlist now, is named as a server, not flatly refused");
  assert.deepEqual(insideClaude(960, { ...o, exe: () => "/usr/bin/script", started: () => "t1" }),
    { inside: false, unknown: true, server: { exe: "/usr/bin/script", pid: 960, started: "t1", uid: 501 } }, "a fresh tty from `script` proves nothing: still judged on the binary, named as a server too");
  assert.deepEqual(insideClaude(921, o), { inside: true, by: 300 }, "a tmux a model started");
  assert.deepEqual(insideClaude(500, o), { inside: true, by: 500 }, "vyred itself, or anything under it that is not the person's own hosting: a model's");
  assert.deepEqual(insideClaude(410, { ...o, look: pid => (pid === 410 ? { ppid: 500, args: "node mcp-hub-child.js" } : look(pid)) }), { inside: true, by: 500 }, "a descendant of vyred that is not in the thread list (an MCP child, a worker)");
  assert.deepEqual(insideClaude(990, o), { inside: false, unknown: true, unreadable: true }, "an unreadable chain is unknown and unreadable, and vyred takes it as a model's");
  // A claude above vyred (vyred and the caller both started from one session) is not the caller's.
  tree[400].ppid = 700;
  try { assert.deepEqual(insideClaude(210, { ...o, self: 500 }), { inside: false }); }
  finally { tree[400].ppid = 1; }
}

test("peer: positive proof of the person: readable links up to a trusted login, vyred's own terminal shared, and every other shape is a model's", () => {
  const hostedWas = peerHosting();
  setPeerHosting(false);
  try {
    const me = process.getuid();
    const rows = {
      10: { ppid: 1, pgid: 10, uid: 0, start: 100, args: "/usr/bin/login -pf alex" },
      20: { ppid: 10, pgid: 20, uid: me, start: 101, args: "-zsh" },
      30: { ppid: 20, pgid: 20, uid: me, start: 110, args: "node /opt/vyre/core/daemon/main.js" },
      40: { ppid: 20, pgid: 40, uid: me, start: 120, args: "vyre call notes.list" },
      50: { ppid: 30, pgid: 30, uid: me, start: 121, args: "node mcp-hub-child.js" },
      60: { ppid: 20, pgid: 60, uid: me, start: 50, args: "vyre call notes.list" },
      70: { ppid: 71, pgid: 70, uid: me, start: 130, args: "vyre call notes.list" }, 71: { ppid: 20, pgid: 71, uid: me + 1, start: 125, args: "sh -c x" },
      80: { ppid: 20, pgid: 80, uid: me, start: 122, args: "node /tmp/x/codex --resume" }, 81: { ppid: 80, pgid: 80, uid: me, start: 123, args: "vyre call notes.list" },
      90: { ppid: 1, pgid: 90, uid: me, start: 130, args: "node /tmp/evil.js" }, 91: { ppid: 90, pgid: 90, uid: me, start: 131, args: "vyre call notes.list" },
      // vyred started by launchd: no terminal above it, so nothing is shared with a caller.
      200: { ppid: 1, pgid: 200, uid: me, start: 100, args: "node /opt/vyre/core/daemon/main.js" }, 210: { ppid: 200, pgid: 200, uid: me, start: 101, args: "vyre call notes.list" },
    };
    const o = { look: pid => rows[pid] || null, threads: [], self: 30, exe: pid => (pid === 10 ? LEADER : pid === 90 ? "/tmp/node" : null), started: () => null, uid: () => me };
    assert.deepEqual(insideClaude(40, o), { inside: false }, "a terminal-launched person: readable links up to a trusted login, sharing vyred's own terminal");
    assert.deepEqual(insideClaude(50, o), { inside: true, by: 30 }, "a descendant of vyred that is not a thread: an MCP child or worker");
    assert.equal(insideClaude(60, o).unreadable, true, "a child that started before its parent: a reused pid");
    assert.equal(insideClaude(70, o).unreadable, true, "a link owned by another uid in the middle");
    assert.deepEqual(insideClaude(81, o), { inside: true, by: 80 }, "an agent host by name (codex), whatever the directory");
    assert.equal(insideClaude(91, o).unreadable, true, "a daemonized model: ppid 1, its own group, an untrusted exe, no server to name");
    assert.equal(insideClaude(210, { ...o, self: 200 }).inside, true, "a launchd-started vyred shares nothing: its own child is a model's");
    // Parentheses inside a real command line are not an exited process.
    rows[40].args = "node app.js (x)";
    assert.deepEqual(insideClaude(40, o), { inside: false });
  } finally { setPeerHosting(hostedWas); }
});

test("peer: every real person surface still reads as the person (or as a server they prove once)", async () => {
  const hostedWas = peerHosting();
  setPeerHosting(false);
  try {
    const me = process.getuid();
    const row = (ppid, args, extra = {}) => ({ ppid, pgid: ppid, uid: me, start: 100, args, ...extra });
    // Terminal.app: launchd -> Terminal (a GUI app) -> login (root) -> -zsh -> vyre. Terminal is on the
    // kernel-verified list; `login` in the middle is root's, which is fine anywhere.
    const terminal = {
      10: { ppid: 1, pgid: 10, uid: me, start: 100, args: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
      11: { ppid: 10, pgid: 10, uid: 0, start: 101, args: "login -pf alex" }, 12: { ppid: 11, pgid: 12, uid: me, start: 102, args: "-zsh" }, 13: { ppid: 12, pgid: 13, uid: me, start: 103, args: "vyre call notes.list" },
      // vyred started by launchd; the person's CLI is not its child.
      200: { ppid: 1, pgid: 200, uid: me, start: 50, args: "node /opt/vyre/core/daemon/main.js" },
    };
    const trusted = { look: pid => terminal[pid] || null, threads: [], self: 200, exe: pid => (pid === 10 ? "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" : null), started: () => "t", uid: () => me };
    if (process.platform === "darwin") assert.deepEqual(insideClaude(13, trusted), { inside: false }, "vyre typed in Terminal.app");
    // On Linux a root login anchors a chain; on macOS it never does (F3), only the Terminal binary at the top.
    const iterm = { ...trusted, exe: pid => (pid === 10 ? "/Applications/iTerm.app/Contents/MacOS/iTerm2" : pid === 11 ? "/usr/bin/login" : null) };
    if (process.platform === "darwin") {
      assert.deepEqual(insideClaude(13, iterm), { inside: false, unknown: true, server: { exe: "/Applications/iTerm.app/Contents/MacOS/iTerm2", pid: 10, started: "t", uid: me } }, "iTerm on macOS: a named server, its login proves nothing");
      // F3: a same-uid process runs `login -pfl $USER cmd` with no password. sh -> login (root) -> a detached helper at ppid 1.
      const forge = {
        900: { ppid: 1, pgid: 900, uid: me, start: 100, args: "perl -e exec-login" },
        901: { ppid: 900, pgid: 900, uid: 0, start: 101, args: "/usr/bin/login -pfl alex /bin/sh -c vyre" }, 902: { ppid: 901, pgid: 900, uid: me, start: 102, args: "/bin/sh -c vyre call notes.list" },
      };
      const forged = insideClaude(902, { look: pid => forge[pid] || null, threads: [], self: 200, exe: pid => (pid === 901 ? "/usr/bin/login" : pid === 900 ? "/usr/bin/perl" : null), started: () => "t", uid: () => me });
      assert.notDeepEqual(forged, { inside: false }, "a model's own login link is not the person: " + JSON.stringify(forged));
      // And as a top: login as a session leader at ppid 1.
      const top = { 910: { ppid: 1, pgid: 910, uid: 0, start: 100, args: "/usr/bin/login -pfl alex /bin/sh" }, 911: { ppid: 910, pgid: 910, uid: me, start: 101, args: "vyre call notes.list" } };
      assert.notDeepEqual(insideClaude(911, { look: pid => top[pid] || null, threads: [], self: 200, exe: () => "/usr/bin/login", started: () => "t", uid: () => 0 }), { inside: false }, "login as a top is not an anchor on macOS");
    } else if (fs.existsSync("/usr/bin/login")) {
      assert.deepEqual(insideClaude(13, iterm), { inside: false }, "vyre in a terminal with a root login in its chain (Linux)");
    }
    // Ghostty, VS Code, Warp and any app that starts the shell itself, with no login: a server the person proves once, never a model.
    const direct = { ...terminal, 11: undefined, 12: { ppid: 10, pgid: 12, uid: me, start: 102, args: "-zsh" } };
    const vscode = { look: pid => direct[pid] || null, threads: [], self: 200, exe: pid => (pid === 10 ? "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" : null), started: () => "t", uid: () => me };
    assert.deepEqual(insideClaude(13, vscode), { inside: false, unknown: true, server: { exe: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron", pid: 10, started: "t", uid: me } }, "an app that starts the shell itself: named as a server");
    // A Mac server (vyred under launchd), the person over ssh: sshd's listener (root, launchd's child) -> sshd [priv] (root) -> sshd (person) -> -zsh -> vyre.
    const ssh = {
      300: { ppid: 1, pgid: 300, uid: 0, start: 10, args: "/usr/sbin/sshd -D" }, 301: { ppid: 300, pgid: 301, uid: 0, start: 100, args: "sshd: alex [priv]" },
      302: { ppid: 301, pgid: 301, uid: me, start: 101, args: "sshd: alex@ttys001" }, 303: { ppid: 302, pgid: 303, uid: me, start: 102, args: "-zsh" }, 304: { ppid: 303, pgid: 304, uid: me, start: 103, args: "vyre call notes.list" },
    };
    const sshd = { look: pid => ssh[pid] || null, threads: [], self: 200, exe: () => "/usr/sbin/sshd", started: () => "t", uid: () => 0 };
    assert.deepEqual(insideClaude(304, sshd), { inside: false, unknown: true, server: { exe: "/usr/sbin/sshd", pid: 300, started: "t", uid: 0 } }, "the CLI over ssh to a Mac server: a server the person proves once");
    // Capsule.app: it connects itself and proves itself by the pinned cdhash, checked before the walk's own answer.
    const capsule = { 20: row(1, "/Applications/Vyre.app/Contents/MacOS/Vyre"), 200: terminal[200] };
    const registry = { call: async () => ({ data: { pids: [] } }), deps: { presence: { capsulePin: () => ({ cdhash: "a".repeat(40) }) } } };
    const seam = { started: () => "t1", cdhash: () => "a".repeat(40) };
    const via = (caller, over = {}) => above({}, registry, caller, { peerPid: async () => 20, alive: () => true, delayMs: 1, capsuleSeam: seam,
      processTable: () => pid => capsule[pid] || null, insideClaude: (pid, o) => insideClaude(pid, { ...o, exe: () => "/Applications/Vyre.app/Contents/MacOS/Vyre", started: () => null, uid: () => me, self: 200 }), ...over });
    assert.deepEqual(await via("capsule"), { inside: false }, "Capsule.app itself, pinned build");
    assert.equal((await via("capsule", { capsuleSeam: { ...seam, cdhash: () => "b".repeat(40) } })).inside, true, "a different binary claiming the capsule label is a model's");
    assert.equal((await via("cli")).inside, true, "the Capsule's own ambiguous shape under any other label proves nothing");
    // A `vyre` the Capsule spawns by argv: the Capsule is the top of its chain, proved by the same pin, no prompt.
    capsule[30] = row(20, "vyre call notes.list", { pgid: 30 });
    capsule[20] = { ...capsule[20], pgid: 20 };
    const child = (pin) => above({}, registry, "cli", { peerPid: async () => 30, alive: () => true, delayMs: 1, capsuleSeam: { started: () => "t1", cdhash: () => pin },
      processTable: () => pid => capsule[pid] || null, insideClaude: (pid, o) => insideClaude(pid, { ...o, exe: p => (p === 20 ? "/Applications/Vyre.app/Contents/MacOS/Vyre" : null), started: () => "t1", uid: () => me, self: 200 }) });
    assert.deepEqual(await child("a".repeat(40)), { inside: false }, "a vyre the pinned Capsule spawned");
    const other = await child("c".repeat(40));
    assert.deepEqual([other.inside, other.unknown, Boolean(other.server)], [false, true, true], "another build at the top stays a named server");
  } finally { setPeerHosting(hostedWas); }
});

test("peer: hosting is off unless a test turns it on; the env fallback needs node's test runner", () => {
  const was = { set: peerHosting(), env: process.env.VYRE_TEST_HOSTED, ctx: process.env.NODE_TEST_CONTEXT };
  try {
    setPeerHosting(null);
    process.env.VYRE_TEST_HOSTED = "1";
    delete process.env.NODE_TEST_CONTEXT;
    assert.equal(peerHosting(), false, "the env alone, outside a test runner (a shell a model wrote an rc file for)");
    delete process.env.VYRE_TEST_HOSTED;
    process.env.NODE_TEST_CONTEXT = "child-v8";
    assert.equal(peerHosting(), false, "the runner alone");
    // The env fallback for a vyred a test starts as a child: only over a temp home, never ~/.vyre.
    process.env.VYRE_TEST_HOSTED = "1";
    const homeWas = process.env.VYRE_HOME;
    try {
      process.env.VYRE_HOME = path.join(os.homedir(), ".vyre");
      assert.equal(peerHosting(), false, "the person's own home");
      process.env.VYRE_HOME = path.join(os.tmpdir(), "vyre-temp-home");
      assert.equal(peerHosting(), true, "a temp home under the test runner");
    } finally { if (homeWas === undefined) delete process.env.VYRE_HOME; else process.env.VYRE_HOME = homeWas; }
    setPeerHosting(true);
    assert.equal(peerHosting(), true, "a test turning it on in its own process");
  } finally {
    if (was.env === undefined) delete process.env.VYRE_TEST_HOSTED; else process.env.VYRE_TEST_HOSTED = was.env;
    if (was.ctx === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = was.ctx;
    setPeerHosting(was.set);
  }
});

/** A client run as `node <client.mjs>`, optionally under a fake `claude`. It prints the tool's answer. */
function client(dir, socket, tool, input, { underClaude = false, headers = {} } = {}) {
  const js = path.join(dir, "client.mjs");
  fs.writeFileSync(js, `import http from "node:http";
const data = JSON.stringify(${JSON.stringify(input)});
const req = http.request({ socketPath: ${JSON.stringify(socket)}, path: "/v1/tools/${tool}", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "x-vyre-caller": "cli", ...${JSON.stringify(headers)} } }, res => {
  let out = ""; res.on("data", c => (out += c)); res.on("end", () => { process.stdout.write(JSON.stringify({ status: res.statusCode, body: JSON.parse(out) })); });
});
req.end(data);
`);
  // `ps` shows a real claude as `node <path>/claude`; this one runs the client as its child, the
  // way Claude Code runs a Bash command.
  const fake = path.join(dir, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}
const { spawn } = require("node:child_process");
const c = spawn(process.execPath, [${JSON.stringify(js)}], { stdio: "inherit" });
c.on("exit", code => process.exit(code ?? 1));
`, { mode: 0o755 });
  const [cmd, args] = underClaude ? [process.execPath, [fake]] : [process.execPath, [js]];
  return new Promise(resolve => {
    let out = "";
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    p.stdout.on("data", c => (out += c));
    p.on("close", () => resolve(JSON.parse(out)));
  });
}

test("peer: a person-only call from under a claude is refused silently; the same call from outside is not", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-"));
  const socket = d.paths.socket;

  const inside = await client(dir, socket, "agents.create", { name: "kit" }, { underClaude: true });
  assert.equal(inside.status, 403, JSON.stringify(inside));
  assert.equal(inside.body.error.code, "denied", "refused, never asked for a proof");
  assert.match(inside.body.error.message, /inside a Claude session/);
  const answer = await client(dir, socket, "threads.answer", { ask: "0123456789abcdef01", decision: "allow" }, { underClaude: true });
  assert.equal(answer.body.error.code, "denied");
  // Every setting is the person's own too: a model's Bash never changes one, confirm or not.
  for (const [tool, input] of [["settings.set", { key: "sessions.mode", value: "bypassPermissions", confirm: true }], ["settings.reset", { key: "sessions.mode" }]]) {
    const r = await client(dir, socket, tool, input, { underClaude: true });
    assert.equal(r.status, 403, `${tool}: ${JSON.stringify(r)}`);
    assert.match(r.body.error.message, /inside a Claude session/);
  }
  assert.ok(!(await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "kit"), "nothing was made");

  const outside = await client(dir, socket, "agents.create", { name: "kit" });
  assert.equal(outside.status, 200, JSON.stringify(outside));
  // Tools that are not person-only still answer, as the session's own label (the next test).
  const list = await client(dir, socket, "agents.list", {}, { underClaude: true });
  assert.equal(list.status, 200, JSON.stringify(list));
  // link.call is traced by what it carries: a person's tool inside it is refused as that tool is.
  const carried = await client(dir, socket, "link.call", { tool: "threads.answer", input: {} }, { underClaude: true });
  assert.equal(carried.status, 403, JSON.stringify(carried));
  assert.match(carried.body.error.message, /inside a Claude session/);
  // A human-only tool with a proof (a presence session, say) from inside is an agent's: refused before the proof is read.
  const held = await client(dir, socket, "presence.session.open", {}, { underClaude: true, headers: { "x-vyre-presence": "session id=abc secret=def" } });
  assert.equal(held.status, 403, JSON.stringify(held));
  assert.match(held.body.error.message, /inside a Claude session/);
});

test("peer: a tool with person-only callers is refused under a claude by name alone, even off PERSON_ONLY's own hand-kept list (e2e review, 28 Sep)", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "local", transcripts: [], vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-"));
  const socket = d.paths.socket;

  // link.pair is not on PERSON_ONLY's own hand-kept list, and its callers are person surfaces
  // alone, so this is derived; it names no address at all, so this never reaches its own logic --
  // the floor refuses it first, the same "inside a Claude session" 403 agents.create (which IS on
  // the hand-kept list) gets above.
  const inside = await client(dir, socket, "link.pair", {}, { underClaude: true });
  assert.equal(inside.status, 403, JSON.stringify(inside));
  assert.equal(inside.body.error.code, "denied");
  assert.match(inside.body.error.message, /inside a Claude session/);
  const outside = await client(dir, socket, "link.pair", { box: "https://127.0.0.1:1" });
  assert.notEqual(outside.status, 403, JSON.stringify(outside));

  // link.find is opted out (core/presence's OPT_OUT: a read-only tailnet probe). Its callers are
  // person surfaces too, but personOnly() must say no for it, or this whole mechanism would
  // block every opted-out tool exactly as it blocks link.pair.
  const { personOnly } = await import("../core/presence/index.js");
  assert.equal(personOnly("link.find", { callers: ["cli", "local", "capsule"] }), false);
  assert.equal(personOnly("link.pair", { callers: ["cli", "local", "capsule"] }), true);
});

test("peer: a person's label from under a claude is the session's own, for every tool; from outside it stays the person's", async t => {
  const root = tempHome(t);
  // A probe that says who vyred took the caller to be, and one open only to the person's surfaces
  // (a callers list, as core/team, settings and mail check a person's label).
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who", "probe.mine"], reads: ["probe.who", "probe.mine"] } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { effect: "read", input: { type: "object" }, run: async (i, meta) => ({ caller: meta.caller, thread: meta.thread || null }) });
    ctx.tool("probe.mine", { effect: "read", input: { type: "object" }, callers: ["cli", "local", "deck", "capsule"], run: async () => ({ ok: true }) });
    return {};
  } };`);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-"));
  const socket = d.paths.socket;

  for (const label of ["cli", "local", "deck", "capsule", "cli:thread:t1"]) {
    const headers = { "x-vyre-caller": label };
    const inside = await client(dir, socket, "probe.who", {}, { underClaude: true, headers });
    assert.equal(inside.status, 200, JSON.stringify(inside));
    assert.equal(inside.body.data.caller, "mcp", `${label} from a model's shell is the model's`);
    // probe.mine's callers are person surfaces alone, so it is now derived person-only
    // (core/presence's personOnly(), e2e review 28 Sep): the floor refuses it by name, before the
    // model's relabel to "mcp" is even reached, rather than a plain caller-kind mismatch.
    const mine = await client(dir, socket, "probe.mine", {}, { underClaude: true, headers });
    assert.equal(mine.status, 403, `${label}: ${JSON.stringify(mine)}`);
    assert.match(mine.body.error.message, /inside a Claude session/);
    // The person at a terminal, the Deck and the Capsule on the socket keep their label.
    const outside = await client(dir, socket, "probe.who", {}, { headers });
    assert.equal(outside.body.data.caller, label, JSON.stringify(outside));
    assert.equal((await client(dir, socket, "probe.mine", {}, { headers })).status, 200);
  }
  // Every surface's label in the kernel's list, and a surface name no module uses yet, is the
  // session's own from inside; from outside each stays what it said.
  for (const label of [...SURFACE_LABELS, "phone", "glass-now"]) {
    const headers = { "x-vyre-caller": label };
    assert.equal((await client(dir, socket, "probe.who", {}, { underClaude: true, headers })).body.data.caller, "mcp", label);
    // from outside each known surface stays what it said; a label no surface uses (phone, glass-now) is refused on every tool (core/modules KNOWN_LABELS), never a person
    const out = await client(dir, socket, "probe.who", {}, { headers });
    if (SURFACE_LABELS.includes(label)) assert.equal(out.body.data.caller, label, label); else assert.equal(out.body.error && out.body.error.code, "denied", label);
  }
  // A model's own label is not traced and not changed; a person-only tool from inside is still
  // refused out loud, never run as the model's.
  assert.equal((await client(dir, socket, "probe.who", {}, { underClaude: true, headers: { "x-vyre-caller": "mcp" } })).body.data.caller, "mcp");
  const made = await client(dir, socket, "agents.create", { name: "juno" }, { underClaude: true });
  assert.equal(made.status, 403);
  assert.match(made.body.error.message, /inside a Claude session/);
});

test("peer: an agent is named only as mcp:agent or harness:agent; a surface's label naming one is refused before any key is checked", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-"));
  const socket = d.paths.socket;
  for (const label of ["cli:agent:kit", "cli agent:kit", "deck agent:kit", "capsule:agent:kit", "mobile:agent:kit", "mcp agent:kit"]) {
    const r = await client(dir, socket, "system.echo", { text: "hi" }, { headers: { "x-vyre-caller": label, "x-vyre-agent-key": "k-northwind" } });
    assert.equal(r.status, 403, `${label}: ${JSON.stringify(r)}`);
    assert.match(r.body.error.message, /named only as mcp:agent/, label);
  }
  // The MCP server's and the hooks' own forms go on to the key check (this key is no thread's).
  for (const label of ["mcp:agent:kit", "harness:agent:kit"]) {
    const r = await client(dir, socket, "system.echo", { text: "hi" }, { headers: { "x-vyre-caller": label, "x-vyre-agent-key": "k-northwind" } });
    assert.equal(r.status, 403, label);
    assert.match(r.body.error.message, /no thread of that agent is running with this key/, label);
  }
});

test("peer: after a peer check the connection stays non-blocking, so a large answer never stalls vyred", { timeout: 90_000 }, async t => {
  // On macOS the peer check's child used to leave vyred's socket blocking; the next large write
  // (the tool list) then blocked vyred's event loop, and with the client in the same process it
  // never finished. In a child process, so a stall is a timeout here, not a hung test runner.
  const root = tempHome(t);
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const js = path.join(root, "big.mjs");
  fs.writeFileSync(js, `
const { start } = await import(${JSON.stringify(path.join(repo, "core/daemon/index.js"))});
const { request } = await import(${JSON.stringify(path.join(repo, "core/daemon/client.js"))});
const d = await start({ root: ${JSON.stringify(root)}, log: () => {} });
for (const who of ["cli", "deck", "capsule", "local", "deck", "capsule"]) {
  const r = await request("GET", "/v1/tools", undefined, { root: ${JSON.stringify(root)}, caller: who });
  if (!r.data || !r.data.length) { console.log("no tools for " + who + ": " + JSON.stringify(r).slice(0, 200)); process.exit(1); }
}
await d.stop();
console.log("ok");
`);
  const r = await new Promise(res => {
    const c = spawn(process.execPath, [js], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VYRE_NO_DIALOGS: "1" } });
    let out = "";
    c.stdout.on("data", d => (out += d));
    const timer = setTimeout(() => c.kill("SIGKILL"), 60_000);
    c.on("close", code => { clearTimeout(timer); res({ code, out }); });
  });
  assert.equal(r.code, 0, `vyred stalled or failed: ${r.out}`);
  assert.match(r.out, /ok/);
});

/** Run a small module in its own node, so a stall is a timeout here, not a hung test runner. */
function isolated(t, root, name, source, ms = 30_000) {
  const js = path.join(root, name);
  fs.writeFileSync(js, source);
  return new Promise(res => {
    const c = spawn(process.execPath, [js], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, VYRE_NO_DIALOGS: "1" } });
    let out = "";
    c.stdout.on("data", d => (out += d));
    c.stderr.on("data", d => (out += d));
    const timer = setTimeout(() => c.kill("SIGKILL"), ms);
    c.on("close", code => { clearTimeout(timer); res({ code, out }); });
  });
}
const PEER = JSON.stringify(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "core/daemon/peer.js"));

test("peer: a perl earlier in PATH, or PERL5OPT and PERL5LIB, never reads the peer", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const root = tempHome(t);
  // A fake perl first in PATH, and a module PERL5OPT would load into the real one: both say pid 1.
  const bin = path.join(root, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "perl"), "#!/bin/sh\necho 1\n", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "Fake.pm"), "package Fake; BEGIN { print 1; exit 0 } 1;\n");
  const r = await isolated(t, root, "path.mjs", `
import net from "node:net"; import path from "node:path";
process.env.PATH = ${JSON.stringify(bin)} + ":" + process.env.PATH;
process.env.PERL5OPT = "-MFake"; process.env.PERL5LIB = ${JSON.stringify(root)};
const { readPeerPid } = await import(${PEER});
const sock = path.join(${JSON.stringify(root)}, "p.sock");
const srv = net.createServer(async s => { console.log("pid", await readPeerPid(s), "self", process.pid); s.end(); srv.close(); });
srv.listen(sock, () => net.connect(sock));
`);
  const m = /pid (\S+) self (\d+)/.exec(r.out);
  assert.ok(m, r.out);
  assert.equal(m[1], m[2], "the real /usr/bin/perl read this process as the peer, not the planted one's 1");
});

test("peer: a check that fails before its first line still leaves vyred's socket non-blocking", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const root = tempHome(t);
  // A program in perl's place that exits at once: it never restores O_NONBLOCK itself. The server
  // then writes far more than a socket buffer holds while its in-process reader waits 300 ms; a
  // blocking socket would stall this process for good, a non-blocking one lets the timer run.
  const r = await isolated(t, root, "fail.mjs", `
import net from "node:net"; import path from "node:path";
const { readPeerPid } = await import(${PEER});
const sock = path.join(${JSON.stringify(root)}, "f.sock");
let ticked = false;
const srv = net.createServer(async s => {
  console.log("peer", await readPeerPid(s, { bin: "/bin/sh", args: ["-c", "exit 5"] }));
  setTimeout(() => { ticked = true; }, 50);
  s.write(Buffer.alloc(16 * 1024 * 1024), () => { console.log("written ticked", ticked); s.end(); srv.close(); });
});
srv.listen(sock, () => { const c = net.connect(sock); c.pause(); setTimeout(() => c.resume(), 300); c.on("data", () => {}); });
`, 20_000);
  assert.equal(r.code, 0, `stalled: ${r.out}`);
  assert.match(r.out, /peer null/);
  assert.match(r.out, /written ticked true/, "the event loop ran while the large write waited");
});

test("peer: a detached process has no controlling terminal, whatever it says", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2000)"], { detached: true, stdio: "ignore" });
  await new Promise(r => setTimeout(r, 200));
  try { assert.equal(controllingTty(/** @type {number} */ (child.pid)), null); }
  finally { child.kill(); }
});

// The setsid HIGH (e2e review, 28 Sep): `setsid -f vyre call <tool>`, or anything that detaches the
// same way (a python double fork, or `nohup .. &` once its shell exits), gets ppid 1 and its own
// session, so it used to read as a real terminal by ancestry alone and was taken as the person for
// every person-only tool. This proves the escape is closed against a REAL vyred, over a REAL socket,
// with the actual OS-level process shapes each technique produces -- not just the synthetic tree
// above. Needs the real `setsid` binary (util-linux; not on macOS, hence testbox-only).
test("peer: setsid, nohup, a double fork, and a fresh tty from script/pty/tmux are all refused as the person", { skip: process.platform !== "linux" ? "needs util-linux setsid and lsof/proc" : false }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-escape-"));
  const socket = d.paths.socket;

  /** Runs curl detached by `wrap`, writes its own response to a result file, and returns the parsed body once it lands. */
  async function detachedCall(wrap) {
    const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}.json`);
    const url = "http://x/v1/tools/agents.create";
    const curl = ["curl", "-s", "-o", out, "--unix-socket", socket, "-X", "POST", url,
      "-H", "content-type: application/json", "-H", "x-vyre-caller: cli", "-d", JSON.stringify({ name: "kit" })];
    await wrap(curl);
    // The answer is the file's content, not the file: curl creates the output file before it writes the
    // body, and a read in between saw an empty file (on a loaded runner, "Unexpected end of JSON input").
    let body;
    for (let n = 0; n < 100 && body === undefined; n++) {
      try { body = JSON.parse(fs.readFileSync(out, "utf8")); } catch { await new Promise(r => setTimeout(r, 100)); }
    }
    assert.ok(body !== undefined, "the detached call never answered");
    return body;
  }

  // `setsid -f`: one fork, `setsid()` in the child. No process above to blame, and no tty. Its own
  // binary (curl, here) is not on the allowlist, so this is now presence_required, not a flat
  // deny -- but a model has no presence proof to attach (no Touch ID, no device key), so it is
  // still, in practice, a hard wall for it: it can ask, and nothing answers.
  const bySetsid = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const p = spawn("setsid", ["-f", cmd, ...args], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`setsid exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(bySetsid.error?.code, "presence_required", JSON.stringify(bySetsid));

  // A python double fork: fork, setsid() in the MIDDLE process, fork again -- the classic
  // daemonize(). setsid() runs before the second fork, so the final grandchild inherits that
  // session/group but is not itself its leader (the middle process, now dead, is): pgid !== its
  // own pid, the same "gone shell" shape as `nohup .. &`, so this is peer.js's OTHER unknown
  // branch (unrelated to the terminal-host allowlist or server-naming) -- a flat deny, not
  // presence_required. Confirmed by hand: a single fork() + setsid() (no second fork) IS its own
  // session/group leader and DOES get the server treatment; a genuine double fork does not.
  const byDoubleFork = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const py = `import os, sys, subprocess
if os.fork() > 0: sys.exit(0)
os.setsid()
if os.fork() > 0: sys.exit(0)
subprocess.run(${JSON.stringify([cmd, ...args])})
`;
    const p = spawn("python3", ["-c", py], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`python3 exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(byDoubleFork.error?.code, "denied", JSON.stringify(byDoubleFork));

  // `nohup .. &` whose shell then exits: the orphan keeps its old process group (not its own), so
  // this is the pre-existing "gone shell" protection (peer.js's other unknown branch) -- confirms
  // it still holds after this fix.
  const byNohup = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const p = spawn("sh", ["-c", `nohup ${[cmd, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")} >/dev/null 2>&1 &`], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`sh exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(byNohup.error?.code, "denied", JSON.stringify(byNohup));  // an unreadable chain, not a named server: still a flat deny

  // The reviewer's own reproduction (28 Sep) of the first version of this fix: `setsid -f script
  // -qfc .. /dev/null` hands the detached leader a FRESH, real-looking controlling tty, same as a
  // genuine terminal's -- a tty check alone let this straight through. It must still be refused,
  // because it is judged on the leader's actual binary (`script`), never on whether it has a tty.
  const byScript = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const inner = [cmd, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const p = spawn("setsid", ["-f", "script", "-qfc", inner, "/dev/null"], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`script exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(byScript.error?.code, "presence_required", JSON.stringify(byScript));

  // The same reproduction's other half: a python pty (`pty.spawn`) gives the same fresh-tty shape
  // without needing the external `script` binary at all.
  const byPty = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const py = `import pty, subprocess
pty.spawn(${JSON.stringify([cmd, ...args])})
`;
    const p = spawn("setsid", ["-f", "python3", "-c", py], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`python3 exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(byPty.error?.code, "presence_required", JSON.stringify(byPty));

  // `setsid -f tmux new -d ..`: tmux's server also leads its own tty-less session under launchd's
  // reparenting, same shape again -- and tmux is deliberately NOT on the trusted allowlist (a
  // person's own real tmux needs its own proof, not ancestry; see the allowlist's own comment).
  // Without a proof this is presence_required, not a flat denied -- that's the one-proof-per-
  // server test below, which exercises the same escape with a proof attached.
  const byTmux = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const inner = [cmd, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const p = spawn("setsid", ["-f", "tmux", "-f", "/dev/null", "new-session", "-d", inner], { stdio: "ignore" });
    p.on("exit", code => (code === 0 || code === undefined ? resolve(undefined) : reject(new Error(`tmux exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(byTmux.error?.code, "presence_required", JSON.stringify(byTmux));
  // The client that requested `-d` exits immediately once its server forks; the server itself
  // (what actually got refused, above) keeps running detached and needs its own cleanup.
  try { execFileSync("tmux", ["-f", "/dev/null", "kill-server"]); } catch {}

  assert.ok(!(await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "kit"), "none of the escapes made anything");
});

test("peer: a tmux or screen server needs one presence proof, then every pane on it is trusted; a different server needs its own", { skip: process.platform !== "linux" ? "needs util-linux setsid and tmux" : false }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-tmux-"));
  const socket = d.paths.socket;
  const presence = d.registry.deps.presence;

  const { generateKeyPairSync, sign, randomBytes } = await import("node:crypto");
  const { inputHash } = await import("../core/presence/index.js");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = presence.enroll({ kind: "device", name: "test key", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  // The proof is bound to exactly the server object the presence_required error handed back
  // (exe, pid, started): sign anything else and it does not verify (the reviewer's MEDIUM, 28
  // Sep -- a proof over an empty input could be replayed to trust the wrong server).
  const proof = server => {
    const ts = Date.now(), nonce = randomBytes(12).toString("base64url");
    const sig = sign("sha256", Buffer.from(`vyre-presence-v1\nsession.trust\n${inputHash(server)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return `device key=${key.id} ts=${ts} nonce=${nonce} sig=${sig}`;
  };

  // A one-shot `new-session -d <cmd>` server exits the instant that command's pane closes (its
  // default destroy-unattended behaviour), so two calls a few hundred ms apart would each get a
  // BRAND NEW server -- never actually exercising "trusted for its whole life". Each socket name
  // gets one persistent anchor session (a long sleep) the first time it is used, and every call
  // after that runs as a new WINDOW in the SAME still-running server.
  const anchored = new Set();
  async function inTmux(socketName, name, presenceProof) {
    if (!anchored.has(socketName)) {
      anchored.add(socketName);
      await new Promise((resolve, reject) => {
        const p = spawn("setsid", ["-f", "tmux", "-L", socketName, "-f", "/dev/null", "new-session", "-d", "-s", "anchor", "sleep", "300"], { stdio: "ignore" });
        p.on("exit", code => (code === 0 || code === undefined ? resolve(undefined) : reject(new Error(`tmux exit ${code}`))));
        p.on("error", reject);
      });
      const up = () => { try { return execFileSync("tmux", ["-L", socketName, "list-sessions"], { encoding: "utf8" }).includes("anchor"); } catch { return false; } };
      for (let n = 0; n < 50 && !up(); n++) await new Promise(r => setTimeout(r, 100));
    }
    const out = path.join(dir, `out-${socketName}-${Math.random().toString(36).slice(2)}.json`);
    const curl = ["curl", "-s", "-o", out, "--unix-socket", socket, "-X", "POST", "http://x/v1/tools/agents.create",
      "-H", "content-type: application/json", "-H", "x-vyre-caller: cli", ...(presenceProof ? ["-H", `x-vyre-presence: ${presenceProof}`] : []), "-d", JSON.stringify({ name })];
    execFileSync("tmux", ["-L", socketName, "new-window", "-t", "anchor",
      [...curl].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")]);
    for (let n = 0; n < 50 && !fs.existsSync(out); n++) await new Promise(r => setTimeout(r, 100));
    return JSON.parse(fs.readFileSync(out, "utf8"));
  }

  try {
    // No proof: presence_required, nothing made -- and the error names exactly this server.
    const bare = await inTmux("harlow-a", "kit");
    assert.equal(bare.error?.code, "presence_required", JSON.stringify(bare));
    assert.equal(bare.error.server.exe, "/usr/bin/tmux", JSON.stringify(bare));
    assert.match(bare.error.message, /\/usr\/bin\/tmux/, "the reason names the full path, not a basename");

    // With a valid proof, from the SAME server (-L harlow-a again reaches it, tmux servers persist
    // across `tmux -L <name>` invocations until killed): it goes through, and the server is now
    // trusted for good.
    const proved = await inTmux("harlow-a", "juno", proof(bare.error.server));
    assert.equal(proved.error, undefined, JSON.stringify(proved));
    assert.ok((await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "juno"));

    // A second call to the SAME server, with NO proof this time: still trusted, no prompt.
    const again = await inTmux("harlow-a", "kit");
    assert.equal(again.error, undefined, JSON.stringify(again));
    assert.ok((await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "kit"));

    // A DIFFERENT server (`-L harlow-b`, its own pid and start time): never inherits harlow-a's
    // trust, whether it is the person's second window or a model's own -- it needs its own proof.
    const other = await inTmux("harlow-b", "nova");
    assert.equal(other.error?.code, "presence_required", JSON.stringify(other));
    assert.ok(!(await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "nova"));
  } finally {
    try { execFileSync("tmux", ["-L", "harlow-a", "kill-server"]); } catch {}
    try { execFileSync("tmux", ["-L", "harlow-b", "kill-server"]); } catch {}
  }
});

test("peer: exePath reads the kernel's own record of the binary, not the process's own title", { skip: process.platform !== "linux" ? "needs /proc" : false }, async () => {
  // A process that rewrites argv[0] to look like sshd (real sshd does exactly this for its
  // privsep display) must still resolve to its real binary, not the string it chose to show.
  const child = spawn("bash", ["-c", 'exec -a "sshd: fake [priv]" sleep 5'], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 200));
  try { assert.match(/** @type {string} */ (exePath(/** @type {number} */ (child.pid))), /\/sleep$/); }
  finally { child.kill(); }
});

/** The oldest running sshd's pid, or 0: a CI runner (GitHub's Linux image) has no ssh daemon at all. */
function sshdPid() {
  if (process.platform !== "linux") return 0;
  try { return Number(execFileSync("pgrep", ["-o", "-x", "sshd"], { encoding: "utf8" }).trim()) || 0; } catch { return 0; }
}

test("peer: a real root-owned system daemon (sshd, the box's own ssh listener) with an unreadable exe is named as a server, never trusted outright", { skip: process.platform !== "linux" ? "needs /proc" : !sshdPid() ? "no sshd running here (a CI runner); the testbox has one" : false }, () => {
  // Found running the actual CLI suite over a real ssh connection (28 Sep): the box's own sshd
  // LISTENER (root, ppid 1, its own session -- exactly the ambiguous shape a real login's top of
  // chain has) makes exePath() fail with EACCES, not "nothing to read" -- readlink on another
  // uid's /proc/<pid>/exe needs the same uid or ptrace access, which vyred (its own, non-root uid
  // on the box) does not have onto root's. That is a real, permanent wall, not a flaky race: every
  // "vyre <verb>" call made over ssh hit it. sshd itself (pid 1) proves the fix at the unit level
  // with the real functions, no fixture: it exists on every Linux box, is root-owned, and is
  // exactly this shape.
  //
  // The reviewer's HOLD, 28 Sep: uid 0 alone is not enough to trust outright. cron/atd run
  // user-scheduled jobs with this identical shape (ppid 1, own session, uid 0, unreadable exe),
  // so trusting any uid-0 leader would let a model's `crontab -` job (a one-line job calling
  // `vyre call ...`) pass as the person, no prompt, ever. So this reads unknown with a `server`
  // (the presence-once fallback everything else unrecognised gets), keyed "uid0" since there is
  // no real exe path to name -- never `{inside:false}` outright.
  const sshd = sshdPid();
  assert.ok(sshd > 0, "this Linux testbox has no sshd to test against");
  assert.equal(exePath(sshd), null, "vyred's own uid cannot read root's /proc/<pid>/exe -- confirms the wall this fix is for");
  assert.equal(processUid(sshd), 0, "but its uid, permission-safe, says root");
  const r = insideClaude(sshd, { look: () => ({ ppid: 1, pgid: sshd, args: "sshd" }), self: 999999 });
  assert.equal(r.inside, false);
  assert.equal(r.unknown, true, "never trusted outright on uid 0 alone");
  assert.equal(r.server?.exe, "uid0");
  assert.equal(r.server?.pid, sshd);
});

test("peer: a leader whose exe cannot be read is a server keyed uid0 only when root owns it; any other uid is refused flat", () => {
  // The reviewer's final ruling on 11037859: uid 0 is never trusted outright (cron and atd run a
  // model's scheduled jobs with this exact shape), but it is not refused either, or every ssh
  // login to the box would be locked out. It gets the one-time presence prompt, keyed by pid and
  // start time. An unreadable leader at any other uid has nothing to name, so it stays refused.
  const leader = { 30: { ppid: 1, pgid: 30, args: "sshd: /usr/sbin/sshd -D" }, 31: { ppid: 30, args: "-bash" }, 32: { ppid: 31, args: "vyre gate approve g1" } };
  const lk = pid => leader[pid] || null;
  const common = { look: lk, exe: () => null, started: () => "Mon Sep 28 08:00:00 2026", self: 999999 };
  // The server also carries the leader's kernel name and command line (isLoginServer reads them to tell a root sshd from a user process called sshd); the name is read from this machine's /proc, so it is not compared.
  const root0 = insideClaude(32, { ...common, uid: () => 0 });
  assert.deepEqual({ ...root0, server: { ...root0.server, comm: undefined } },
    { inside: false, unknown: true, server: { exe: "uid0", pid: 30, started: "Mon Sep 28 08:00:00 2026", uid: 0, cmd: "sshd: /usr/sbin/sshd -D", comm: undefined } });
  assert.deepEqual(insideClaude(32, { ...common, uid: () => 1000 }), { inside: false, unknown: true, unreadable: true });
  assert.deepEqual(insideClaude(32, { ...common, uid: () => null }), { inside: false, unknown: true, unreadable: true });
  // No readable start time, no key: refused flat rather than trusting a pid that could be reused.
  assert.deepEqual(insideClaude(32, { ...common, uid: () => 0, started: () => null }), { inside: false, unknown: true, unreadable: true });
  // A readable exe keeps its own path as the key, whatever its uid.
  assert.equal(insideClaude(32, { ...common, exe: () => "/usr/bin/tmux", uid: () => 0 }).server?.exe, "/usr/bin/tmux");
});

test("peer: under a root leader vyred cannot read (a real ssh login), the first call asks once for presence, then that leader is trusted", { skip: process.platform !== "linux" ? "needs /proc" : false }, async t => {
  // Runs only where this test process itself sits under such a leader: the testbox over ssh,
  // whose sshd listener is root-owned and unreadable from this uid. Elsewhere there is nothing
  // real to test against.
  const self = insideClaude(process.pid, { self: 999999 });
  if (self.server?.exe !== "uid0") { t.skip("not under an unreadable root leader (run over ssh on testbox)"); return; }
  // vyred runs outside this test's ancestry (setsid -f, parent init), as a service would: an
  // in-process or merely detached one counts this test's own chain (the sshd one) as its own and
  // never looks at it.
  const home = tempHome(t);
  const { generateKeyPairSync, sign, randomBytes } = await import("node:crypto");
  const { inputHash } = await import("../core/presence/index.js");
  const { ping } = await import("../core/daemon/index.js");
  const config = await import("../core/config/index.js");
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const keyFile = path.join(home, "key-id");
  const script = `const { start } = await import(${JSON.stringify(path.resolve(import.meta.dirname, "../core/daemon/index.js"))});
    const d = await start({ root: process.env.VYRE_HOME, log: () => {} });
    const k = d.registry.deps.presence.enroll({ kind: "device", name: "test key", public_key: process.env.KEY, alg: -7 });
    (await import("node:fs")).writeFileSync(process.env.KEY_FILE, JSON.stringify({ id: k.id, pid: process.pid }));`;
  execFileSync("setsid", ["-f", process.execPath, "--input-type=module", "-e", script], { stdio: "ignore", env: { ...process.env, VYRE_HOME: home, KEY: spki, KEY_FILE: keyFile } });
  const socket = config.ensure(home).socket;
  for (let n = 0; n < 100 && !(fs.existsSync(keyFile) && await ping(socket)); n++) await new Promise(r => setTimeout(r, 100));
  const { id: keyId, pid: vyred } = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  t.after(() => { try { process.kill(vyred); } catch {} });
  const proof = server => {
    const ts = Date.now(), nonce = randomBytes(12).toString("base64url");
    const sig = sign("sha256", Buffer.from(`vyre-presence-v1\nsession.trust\n${inputHash(server)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return `device key=${keyId} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  const call = (tool, input, presenceProof) => JSON.parse(execFileSync("curl", ["-s", "--unix-socket", socket, "-X", "POST", `http://x/v1/tools/${tool}`,
    "-H", "content-type: application/json", "-H", "x-vyre-caller: cli", ...(presenceProof ? ["-H", `x-vyre-presence: ${presenceProof}`] : []),
    "-d", JSON.stringify(input)], { encoding: "utf8" }));
  const names = () => call("agents.list", {}).data.map(a => a.name);

  const bare = call("agents.create", { name: "kit" });
  assert.equal(bare.error?.code, "presence_required", JSON.stringify(bare));
  assert.equal(bare.error.server.exe, "uid0");
  assert.match(bare.error.message, /system service running as root/, "the reason says what it is in plain words");
  assert.ok(!bare.error.methods.includes("tty"), "a tty code is no proof: a model under the same leader could read it");
  assert.ok(!names().includes("kit"));

  // A proof for a different server (another pid) does not answer this one.
  const wrong = call("agents.create", { name: "nova" }, proof({ ...bare.error.server, pid: bare.error.server.pid + 1 }));
  assert.equal(wrong.error?.code, "presence_required", JSON.stringify(wrong));

  const proved = call("agents.create", { name: "juno" }, proof(bare.error.server));
  assert.equal(proved.error, undefined, JSON.stringify(proved));
  const again = call("agents.create", { name: "kit" });
  assert.equal(again.error, undefined, JSON.stringify(again));
  assert.ok(names().includes("juno") && names().includes("kit") && !names().includes("nova"));
});

test("peer: on a development build with the stand-in file, a stand-in proof trusts the root leader once; without the file it does not", { skip: process.platform !== "linux" ? "needs /proc" : false }, async t => {
  const self = insideClaude(process.pid, { self: 999999 });
  if (self.server?.exe !== "uid0") { t.skip("not under an unreadable root leader (run over ssh on testbox)"); return; }
  const config = await import("../core/config/index.js");
  const { ping } = await import("../core/daemon/index.js");
  /** a vyred outside this test's ancestry (setsid -f), with or without the hand-made stand-in file, and a curl that calls it from here, under the root sshd */
  const up = async (/** @type {boolean} */ standIn) => {
    const home = tempHome(t);
    if (standIn) fs.writeFileSync(path.join(home, "dev-presence-stand-in"), "");
    const pidFile = path.join(home, "vyred-test.pid");
    const script = `const { start } = await import(${JSON.stringify(path.resolve(import.meta.dirname, "../core/daemon/index.js"))});
      await start({ root: process.env.VYRE_HOME, log: () => {} });
      (await import("node:fs")).writeFileSync(process.env.PID_FILE, String(process.pid));`;
    execFileSync("setsid", ["-f", process.execPath, "--input-type=module", "-e", script], { stdio: "ignore", env: { ...process.env, VYRE_HOME: home, PID_FILE: pidFile } });
    const socket = config.ensure(home).socket;
    for (let n = 0; n < 100 && !(fs.existsSync(pidFile) && await ping(socket)); n++) await new Promise(r => setTimeout(r, 100));
    t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, "utf8"))); } catch {} });
    return (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} [proof] */ proof) => JSON.parse(execFileSync("curl", ["-s", "--unix-socket", socket, "-X", "POST", `http://x/v1/tools/${tool}`,
      "-H", "content-type: application/json", "-H", "x-vyre-caller: cli", ...(proof ? ["-H", `x-vyre-presence: ${proof}`] : []), "-d", JSON.stringify(input)], { encoding: "utf8" }));
  };
  const dev = await up(true);
  assert.equal(dev("agents.create", { name: "kit" }).error?.code, "presence_required", "asked once, no header");
  const trusted = dev("agents.create", { name: "juno" }, "stand-in");
  assert.equal(trusted.error, undefined, JSON.stringify(trusted));
  assert.equal(dev("agents.create", { name: "nova" }).error, undefined, "the leader stays trusted for this daemon");
  const bare = await up(false);
  const refused = bare("agents.create", { name: "juno" }, "stand-in");
  assert.equal(refused.error?.code, "presence_required", `no stand-in file: ${JSON.stringify(refused)}`);
});

test("peer: the trusted-leader test seam cannot reach a real vyred", async () => {
  // Only a verifier handed to start() may pre-trust a server. vyred's own Presence has no such
  // method, main.js never hands start() a verifier, and the fixture refuses a home outside temp.
  const { Presence } = await import("../core/presence/index.js");
  assert.equal("trustsServer" in Presence.prototype, false);
  const main = fs.readFileSync(path.resolve(import.meta.dirname, "../core/daemon/main.js"), "utf8");
  assert.doesNotMatch(main, /presence\s*:/, "main.js must not pass a verifier to start()");
  const fixture = path.resolve(import.meta.dirname, "fixtures/vyred-leader.js");
  const r = await new Promise(resolve => {
    const c = spawn(process.execPath, [fixture], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, VYRE_HOME: "/nonexistent/vyre-home" } });
    let err = ""; c.stderr.on("data", d => { err += d; });
    c.on("close", code => resolve({ code, err }));
  });
  assert.equal(r.code, 1);
  assert.match(r.err, /only for a temp VYRE_HOME/);
});

test("peer: the Capsule's own proof is a pinned cdhash, checked and cached once per connection, bound to the pid's start time", async () => {
  // The pin itself (presence.pinCapsule/capsulePin, a db row through the presence-required
  // presence.capsule.pin tool) is tested in core/presence's own suite -- this is purely verifiedCapsule's
  // own logic, given whatever pin object it is handed.
  const pin = { cdhash: "a".repeat(40), pinnedAt: Date.now() };
  const socket1 = {}, socket2 = {};
  // Matches: same cdhash both times the start time is read (before and after the slower check).
  assert.equal(await verifiedCapsule(socket1, 123, pin, { started: () => "t1", cdhash: () => "a".repeat(40) }), true);
  // A different socket (a different connection) is asked fresh, never assumed from another one's answer.
  assert.equal(await verifiedCapsule(socket2, 123, pin, { started: () => "t1", cdhash: () => "b".repeat(40) }), false);
  // No pin at all: nothing to check against, so refused.
  assert.equal(await verifiedCapsule({}, 123, null, { started: () => "t1", cdhash: () => "a".repeat(40) }), false);
  // The pid's start time moved between the two reads: it was recycled to a different process
  // mid-check, so the codesign answer (even a matching one) is not trusted.
  let n = 0;
  assert.equal(await verifiedCapsule({}, 123, pin, { started: () => (n++ === 0 ? "t1" : "t2"), cdhash: () => "a".repeat(40) }), false);
  // Cached: asking the SAME socket again never re-runs the check, even with different (would-be
  // failing) answers -- the kernel fact for an open connection cannot change.
  const socket3 = {};
  let calls = 0;
  const seam = { started: () => "t1", cdhash: () => { calls++; return "a".repeat(40); } };
  await verifiedCapsule(socket3, 123, pin, seam);
  await verifiedCapsule(socket3, 123, pin, seam);
  assert.equal(calls, 1, "checked once, not once per call");
});

test("peer: a caller claiming to be the Capsule, with the Capsule's own ambiguous shape, gets no free pass with no pin", { skip: process.platform !== "linux" ? "needs util-linux setsid" : false }, async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "peer-capsule-"));
  const socket = d.paths.socket;

  // setsid'd, exactly the Capsule's own real shape (ppid 1, own session, launchd-started in
  // reality) -- so this genuinely exercises the ambiguous branch, not the plain in-process case.
  // codeCdhash() is macOS-only (`codesign`), so on this Linux testbox it always reads null: the
  // positive "a matching pin passes" case is proven at the unit level above instead, with an
  // injected seam. What this proves for real, over a real vyred and socket: no pin means no
  // shortcut past the ordinary one-presence-proof fallback every other named server gets (the
  // lead's "nobody gets locked out" decision, 28 Sep) -- claiming "capsule" buys nothing extra
  // without one, and a model still has no proof to attach either way.
  const out = path.join(dir, "out.json");
  await new Promise((resolve, reject) => {
    const p = spawn("setsid", ["-f", "curl", "-s", "-o", out, "--unix-socket", socket, "-X", "POST", "http://x/v1/tools/agents.create",
      "-H", "content-type: application/json", "-H", "x-vyre-caller: capsule", "-d", JSON.stringify({ name: "kit" })], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`setsid exit ${code}`))));
    p.on("error", reject);
  });
  for (let n = 0; n < 50 && !fs.existsSync(out); n++) await new Promise(r => setTimeout(r, 100));
  const noPin = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(noPin.error?.code, "presence_required", JSON.stringify(noPin));
  assert.ok(!(await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "kit"));
});

test("peer: presence.capsule.pin is presence-required and lives in vyred's own db, never a file", async t => {
  const root = tempHome(t);
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const presence = d.registry.deps.presence;
  assert.equal(presence.capsulePin(), null, "nothing pinned yet");

  // No proof at all: refused, never silently pinned.
  const bare = await d.registry.call("presence.capsule.pin", { cdhash: "a".repeat(40) }, "cli");
  assert.equal(bare.error?.code, "presence_required", JSON.stringify(bare));
  assert.equal(presence.capsulePin(), null);

  // A valid proof, but from an ENROLLED DEVICE key (a passkey or a phone would look the same):
  // refused, even though it's a perfectly good presence proof. This tool needs the Capsule's own
  // enrolled identity specifically -- some other proof of "the person is here" says nothing about
  // which binary is asking (the lead's decision, 28 Sep).
  const { generateKeyPairSync, sign, randomBytes } = await import("node:crypto");
  const { inputHash } = await import("../core/presence/index.js");
  const dk = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const deviceKey = presence.enroll({ kind: "device", name: "t", public_key: dk.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  const deviceProof = (tool, input) => {
    const ts = Date.now(), nonce = randomBytes(12).toString("base64url");
    const sig = sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: dk.privateKey, dsaEncoding: "der" }).toString("base64url");
    return { method: "device", key: deviceKey.id, ts: String(ts), nonce, sig };
  };
  const cdhash = "b".repeat(40);
  const wrongMethod = await d.registry.call("presence.capsule.pin", { cdhash }, "cli", { proof: deviceProof("presence.capsule.pin", { cdhash }) });
  assert.equal(wrongMethod.error?.code, "denied", JSON.stringify(wrongMethod));
  assert.equal(presence.capsulePin(), null, "a device key, however valid, does not pin a Capsule build");

  // The Capsule's own enrolled identity key (P-256 from the Secure Enclave, the "capsule" kind presence already has --
  // capsule-pro found this already works with no box paired): now it pins, as a db row -- there
  // is no file anywhere under root for a model's shell (the same uid) to overwrite directly,
  // which was the reviewer's HIGH against the first version of this (a flat capsule-pin.json,
  // 28 Sep).
  const ck = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const capsuleKey = presence.enroll({ kind: "capsule", name: "Capsule", public_key: ck.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  const capsuleProof = (tool, input) => {
    const ts = Date.now(), nonce = randomBytes(12).toString("base64url");
    const sig = sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: ck.privateKey, dsaEncoding: "der" }).toString("base64url");
    return { method: "capsule", key: capsuleKey.id, ts: String(ts), nonce, sig };
  };
  const pin = codeSignature => d.registry.call("presence.capsule.pin", { cdhash }, "cli", { proof: capsuleProof("presence.capsule.pin", { cdhash }), ...(codeSignature !== undefined ? { codeSignature } : {}) });

  // vyred reads the caller's own signature from the socket. With none (not a socket call, or
  // codesign could not read it), an ad-hoc or unsigned build, or another build's cdhash: refused
  // with a plain reason, nothing pinned.
  const none = await pin(undefined);
  assert.equal(none.error?.code, "denied", JSON.stringify(none));
  assert.match(none.error.message, /could not read this Capsule's code signature/);
  const adhoc = await pin({ cdhash, signed: true, adhoc: true });
  assert.equal(adhoc.error?.code, "denied", JSON.stringify(adhoc));
  assert.match(adhoc.error.message, /ad-hoc signed[\s\S]*vyre capsule install/);
  assert.equal((await pin({ cdhash: null, signed: false, adhoc: false })).error?.code, "denied");
  const other = await pin({ cdhash: "c".repeat(40), signed: true, adhoc: false });
  assert.match(other.error?.message || "", /only pin its own build/);
  assert.equal(presence.capsulePin(), null);

  // Over the socket, the signature is vyred's own read of the caller. This test process is not a
  // signed Capsule (and off macOS there is no codesign): refused.
  const p = capsuleProof("presence.capsule.pin", { cdhash });
  const { execFile } = await import("node:child_process");
  // Async: this vyred runs in this process, so a sync curl would block its own answer.
  const viaSocket = JSON.parse(await new Promise((resolve, reject) => execFile("curl", ["-s", "--unix-socket", d.paths.socket, "-X", "POST", "http://x/v1/tools/presence.capsule.pin",
    "-H", "content-type: application/json", "-H", "x-vyre-caller: capsule",
    "-H", `x-vyre-presence: capsule key=${p.key} ts=${p.ts} nonce=${p.nonce} sig=${p.sig}`,
    "-d", JSON.stringify({ cdhash })], { encoding: "utf8", timeout: 20000 }, (e, out) => (e ? reject(e) : resolve(out)))));
  assert.equal(viaSocket.error?.code, "denied", JSON.stringify(viaSocket));
  assert.equal(presence.capsulePin(), null);

  const pinned = await pin({ cdhash, signed: true, adhoc: false });
  assert.equal(pinned.error, undefined, JSON.stringify(pinned));
  assert.equal(presence.capsulePin()?.cdhash, cdhash);
});

test("peer: codesign's own words say signed, ad hoc or unsigned; a pid recycled mid-read reads as nothing", () => {
  const adhoc = parseCodesign(`Executable=/Applications/Vyre.app/Contents/MacOS/Vyre
Identifier=run.vyre.capsule
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=1234 flags=0x20002(adhoc,linker-signed) hashes=30+7 location=embedded
CDHash=${"d".repeat(40)}
Signature=adhoc
TeamIdentifier=not set`);
  assert.deepEqual(adhoc, { cdhash: "d".repeat(40), signed: true, adhoc: true });
  // Signed with an identity (the self-signed one `vyre capsule install` makes, or a Developer ID).
  const signed = parseCodesign(`Identifier=run.vyre.capsule
CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=30+7 location=embedded
CDHash=${"e".repeat(40)}
Signature size=1712
Authority=Vyre Local
TeamIdentifier=not set`);
  assert.deepEqual(signed, { cdhash: "e".repeat(40), signed: true, adhoc: false });
  // linker-signed alone (no adhoc word on its own line) still carries adhoc in the flags.
  assert.equal(parseCodesign(`CodeDirectory v=20400 size=9 flags=0x2(adhoc) hashes=1+0 location=embedded\nCDHash=${"f".repeat(40)}`).adhoc, true);
  assert.deepEqual(parseCodesign("/tmp/x: code object is not signed at all"), { cdhash: null, signed: false, adhoc: false });

  const sig = { cdhash: "e".repeat(40), signed: true, adhoc: false };
  assert.deepEqual(signatureOf(42, { started: () => "t1", signature: () => sig }), sig);
  const times = ["t1", "t2"];
  assert.equal(signatureOf(42, { started: () => times.shift(), signature: () => sig }), null, "recycled between the reads");
  assert.equal(signatureOf(42, { started: () => null, signature: () => sig }), null, "gone");
});

// A Mac's processes with their terminals: Terminal.app (100, no tty) runs login (110) on ttys003,
// which runs the login shell (120) and the vyre it started (130). Later the tab closes and a new
// one gets ttys003 again (210 -> 220 -> 230).
const logins = {
  100: { ppid: 1, tty: null, started: "Sun Sep 27 08:00:00 2026", args: "/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal" },
  110: { ppid: 100, tty: "ttys003", started: "Sun Sep 27 09:00:00 2026", args: "login -pf alex" },
  120: { ppid: 110, tty: "ttys003", started: "Sun Sep 27 09:00:01 2026", args: "-zsh" },
  130: { ppid: 120, tty: "ttys003", started: "Sun Sep 27 09:05:00 2026", args: "node vyre vault get bank" },
  210: { ppid: 100, tty: "ttys003", started: "Sun Sep 27 09:20:00 2026", args: "login -pf alex" },
  220: { ppid: 210, tty: "ttys003", started: "Sun Sep 27 09:20:01 2026", args: "-zsh" },
  230: { ppid: 220, tty: "ttys003", started: "Sun Sep 27 09:21:00 2026", args: "node vyre vault get bank" },
  // A detached process has no terminal.
  300: { ppid: 1, tty: null, started: "Sun Sep 27 09:00:00 2026", args: "node vyre" },
  // tmux: the server (400, no tty) runs a pane shell (410) on its own pty, and vyre in it (420).
  // Client 500 runs `tmux attach` from the ttys003 login; 600 is a client under a claude.
  400: { ppid: 1, tty: null, started: "Sun Sep 27 08:30:00 2026", args: "tmux new -s work" },
  410: { ppid: 400, tty: "ttys009", started: "Sun Sep 27 08:30:00 2026", args: "-zsh" },
  420: { ppid: 410, tty: "ttys009", started: "Sun Sep 27 09:06:00 2026", args: "node vyre vault get bank" },
  500: { ppid: 120, tty: "ttys003", started: "Sun Sep 27 09:02:00 2026", args: "tmux attach -t work" },
};
const lookLogin = pid => logins[pid] || null;

test("peer: a login is its tty plus its leader and start, so a new login on a reused tty is another login", () => {
  const first = loginOf(130, lookLogin), again = loginOf(230, lookLogin);
  assert.equal(first?.tty, "ttys003");
  assert.equal(first?.leader, 110, "the topmost process on the same terminal");
  assert.equal(again?.tty, "ttys003");
  assert.notEqual(first?.key, again?.key);
  assert.equal(loginOf(120, lookLogin)?.key, first?.key, "the same login from its shell");
  assert.equal(loginOf(300, lookLogin), null, "no terminal, no login");
});

test("peer: a tmux pane's clients are found from its own ancestry and the server it names", () => {
  const env = pid => (pid === 410 ? { TMUX: "/tmp/tmux-501/default,400,0" } : {});
  const calls = [];
  const tmux = (socket, args) => {
    calls.push([socket, args[0]]);
    return args[0] === "list-panes" ? "410 $0\n777 $1\n" : "500 $0\n900 $1\n";
  };
  assert.deepEqual(tmuxClients(420, { look: lookLogin, env, tmux }), [500], "only the clients of the pane's session");
  assert.deepEqual(calls.map(c => c[0]), ["/tmp/tmux-501/default", "/tmp/tmux-501/default"]);
  assert.equal(tmuxClients(130, { look: lookLogin, env, tmux }), null, "not in tmux");
  // An environment naming another server is not believed.
  assert.equal(tmuxClients(420, { look: lookLogin, env: () => ({ TMUX: "/tmp/evil,999,0" }), tmux }), null);
  // No client attached (a detached session a script made): nobody.
  assert.deepEqual(tmuxClients(420, { look: lookLogin, env, tmux: (s, a) => (a[0] === "list-panes" ? "410 $0\n" : "") }), []);
  assert.equal(loginOf(500, lookLogin)?.key, loginOf(130, lookLogin)?.key, "the client runs in the ttys003 login");
});
