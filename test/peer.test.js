// peer: vyred reads which process is on the socket and refuses a person-only call from inside a
// Claude session, however it labels itself. A fake `claude` (a node script by that name, as `ps`
// shows a real one) runs the client; the same client run straight from the test is allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { SURFACE_LABELS } from "../core/modules/index.js";
import { ancestry, insideClaude, controllingTty, loginOf, tmuxClients } from "../core/daemon/peer.js";

const tree = {
  // vyred (500) under the test runner (400); a terminal zsh (200) and a claude (300) elsewhere.
  400: { ppid: 1, args: "node --test" }, 500: { ppid: 400, args: "node vyred" },
  200: { ppid: 1, args: "/bin/zsh -l" }, 210: { ppid: 200, args: "vyre threads answer" },
  300: { ppid: 200, args: "node /usr/local/bin/claude" }, 310: { ppid: 300, args: "/bin/bash -c vyre call threads.answer" }, 311: { ppid: 310, args: "vyre call threads.answer" },
  600: { ppid: 500, args: "/opt/claude-code/cli.js --session-id x" }, 610: { ppid: 600, args: "curl --unix-socket" },
  700: { ppid: 400, args: "/Users/alex/.local/bin/claude" },
  // On the box: the person over ssh, in tmux; a claude someone runs in a tmux pane; tmux a model opened.
  800: { ppid: 1, args: "sshd: alex [priv]" }, 801: { ppid: 800, args: "-bash" }, 802: { ppid: 801, args: "vyre vault reveal northwind-mail" },
  900: { ppid: 1, args: "tmux new -s work" }, 901: { ppid: 900, args: "-bash" }, 902: { ppid: 901, args: "vyre gate approve g1" },
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
  const o = { look, self: 500, threads: [600] };
  assert.deepEqual(insideClaude(311, o), { inside: true, by: 300 }, "a model's Bash under a terminal claude");
  assert.deepEqual(insideClaude(610, o), { inside: true, by: 600 }, "a headless thread's child, whatever its command line says");
  assert.deepEqual(insideClaude(210, o), { inside: false }, "the person's own terminal");
  assert.deepEqual(insideClaude(802, o), { inside: false }, "the person over ssh");
  assert.deepEqual(insideClaude(902, o), { inside: false }, "the person's shell in tmux");
  assert.deepEqual(insideClaude(912, o), { inside: true, by: 911 }, "claude in a tmux pane");
  assert.deepEqual(insideClaude(940, o), { inside: true, by: 600 }, "an orphan in a thread's process group");
  assert.deepEqual(insideClaude(951, o), { inside: false, unknown: true }, "an orphan of a shell that is gone: refused as unknown");
  assert.deepEqual(insideClaude(960, o), { inside: false }, "the Capsule, its own group under launchd");
  assert.deepEqual(insideClaude(921, o), { inside: true, by: 300 }, "a tmux a model started");
  assert.deepEqual(insideClaude(500, o), { inside: false }, "vyred itself");
  assert.deepEqual(insideClaude(990, o), { inside: false, unknown: true }, "an unreadable chain is unknown, and vyred refuses it");
  // A claude above vyred (vyred and the caller both started from one session) is not the caller's.
  tree[400].ppid = 700;
  try { assert.deepEqual(insideClaude(210, { ...o, self: 500 }), { inside: false }); }
  finally { tree[400].ppid = 1; }
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

test("peer: a person's or any surface's label from under a claude is the session's own, for every tool; from outside it stays", async t => {
  const root = tempHome(t);
  // A probe that says who vyred took the caller to be, and one open only to the person's surfaces
  // (a callers list, as core/team, settings and mail check a person's label).
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who", "probe.mine"] } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { input: { type: "object" }, run: async (i, meta) => ({ caller: meta.caller, thread: meta.thread || null }) });
    ctx.tool("probe.mine", { input: { type: "object" }, callers: ["cli", "local", "deck", "capsule"], run: async () => ({ ok: true }) });
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
    const mine = await client(dir, socket, "probe.mine", {}, { underClaude: true, headers });
    assert.equal(mine.status, 403, `${label}: ${JSON.stringify(mine)}`);
    assert.match(mine.body.error.message, /not available to mcp callers/);
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
    assert.equal((await client(dir, socket, "probe.who", {}, { headers })).body.data.caller, label, label);
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
