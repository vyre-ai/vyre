// peer: vyred reads which process is on the socket and refuses a person-only call from inside a
// Claude session, however it labels itself. A fake `claude` (a node script by that name, as `ps`
// shows a real one) runs the client; the same client run straight from the test is allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { ancestry, insideClaude, controllingTty, exePath, loginOf, tmuxClients } from "../core/daemon/peer.js";

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
  // Leads its own group under launchd, same shape a `setsid`'d escape has (see the dedicated
  // test below): unknown by ancestry alone without a controlling terminal. The Capsule is this
  // shape too, and must prove itself another way, not by ancestry (the setsid HIGH, 28 Sep).
  // Its own group under launchd, same shape a setsid'd escape has: unknown unless its own binary
  // (never argv, which this fixture's `args` string cannot stand in for here) is on the trusted
  // allowlist. The Capsule's own binary is not, so it stays unknown until it has its own proof.
  assert.deepEqual(insideClaude(960, o), { inside: false, unknown: true }, "its own group under launchd, unlisted binary: unknown, not trusted by ancestry");
  assert.deepEqual(insideClaude(960, { ...o, exe: () => "/usr/sbin/sshd" }), { inside: false }, "the same shape, but the kernel says its binary is sshd's");
  assert.deepEqual(insideClaude(960, { ...o, exe: () => "/usr/bin/script" }), { inside: false, unknown: true }, "a fresh tty from `script` proves nothing: still judged on the binary, not on having one");
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

test("peer: a person's label from under a claude is the session's own, for every tool; from outside it stays the person's", async t => {
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
  // A model's own label is not traced and not changed; a person-only tool from inside is still
  // refused out loud, never run as the model's.
  assert.equal((await client(dir, socket, "probe.who", {}, { underClaude: true, headers: { "x-vyre-caller": "mcp" } })).body.data.caller, "mcp");
  const made = await client(dir, socket, "agents.create", { name: "juno" }, { underClaude: true });
  assert.equal(made.status, 403);
  assert.match(made.body.error.message, /inside a Claude session/);
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
    for (let n = 0; n < 50 && !fs.existsSync(out); n++) await new Promise(r => setTimeout(r, 100));
    assert.ok(fs.existsSync(out), "the detached call never answered");
    return JSON.parse(fs.readFileSync(out, "utf8"));
  }

  // `setsid -f`: one fork, `setsid()` in the child. No process above to blame, and no tty.
  const bySetsid = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const p = spawn("setsid", ["-f", cmd, ...args], { stdio: "ignore" });
    p.on("exit", code => (code === 0 ? resolve(undefined) : reject(new Error(`setsid exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(bySetsid.error?.code, "denied", JSON.stringify(bySetsid));
  assert.match(bySetsid.error.message, /this comes from inside a Claude session|vyred cannot read/);

  // A python double fork: fork, setsid() in the child, fork again -- the classic daemonize(), which
  // also lands at ppid 1, its own session, no tty.
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
  assert.equal(byNohup.error?.code, "denied", JSON.stringify(byNohup));

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
  assert.equal(byScript.error?.code, "denied", JSON.stringify(byScript));

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
  assert.equal(byPty.error?.code, "denied", JSON.stringify(byPty));

  // `setsid -f tmux new -d ..`: tmux's server also leads its own tty-less session under launchd's
  // reparenting, same shape again -- and tmux is deliberately NOT on the trusted allowlist (a
  // person's own real tmux needs its own proof, not ancestry; see the allowlist's own comment).
  const byTmux = await detachedCall(([cmd, ...args]) => new Promise((resolve, reject) => {
    const inner = [cmd, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    const p = spawn("setsid", ["-f", "tmux", "-f", "/dev/null", "new-session", "-d", inner], { stdio: "ignore" });
    p.on("exit", code => (code === 0 || code === undefined ? resolve(undefined) : reject(new Error(`tmux exit ${code}`))));
    p.on("error", reject);
  }));
  assert.equal(byTmux.error?.code, "denied", JSON.stringify(byTmux));
  // The client that requested `-d` exits immediately once its server forks; the server itself
  // (what actually got refused, above) keeps running detached and needs its own cleanup.
  try { execFileSync("tmux", ["-f", "/dev/null", "kill-server"]); } catch {}

  assert.ok(!(await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "kit"), "none of the escapes made anything");
});

test("peer: exePath reads the kernel's own record of the binary, not the process's own title", { skip: process.platform !== "linux" ? "needs /proc" : false }, async () => {
  // A process that rewrites argv[0] to look like sshd (real sshd does exactly this for its
  // privsep display) must still resolve to its real binary, not the string it chose to show.
  const child = spawn("bash", ["-c", 'exec -a "sshd: fake [priv]" sleep 5'], { stdio: "ignore" });
  await new Promise(r => setTimeout(r, 200));
  try { assert.match(/** @type {string} */ (exePath(/** @type {number} */ (child.pid))), /\/sleep$/); }
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
