// peer: vyred reads which process is on the socket and refuses a person-only call from inside a
// Claude session, however it labels itself. A fake `claude` (a node script by that name, as `ps`
// shows a real one) runs the client; the same client run straight from the test is allowed.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome } from "./helpers.js";
import { start } from "../core/daemon/index.js";
import { ancestry, insideClaude } from "../core/daemon/peer.js";

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
  assert.ok(!(await d.registry.call("agents.list", {}, "cli")).data.some(a => a.name === "kit"), "nothing was made");

  const outside = await client(dir, socket, "agents.create", { name: "kit" });
  assert.equal(outside.status, 200, JSON.stringify(outside));
  // Tools that are not person-only are not traced at all.
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
