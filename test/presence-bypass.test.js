// @ts-check
// Every way a model could approve its own held email (docs/adr/0004-presence.md), against a real
// vyred with the real Gate and a fake mail server. Each route must be refused with nothing sent,
// and the person's own routes (a signed Capsule call, a code typed at a login terminal) must work.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { Presence, inputHash } from "../core/presence/index.js";
import { tempHome } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(ROOT, "bin", "vyre");
const HOOK = path.join(ROOT, "harness", "hooks", "hook.js");

/** A mail server that records what reaches it. */
async function outbox(t) {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = ""; req.on("data", d => (body += d));
    req.on("end", () => { got.push(body); res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"m1","threadId":"t1"}'); });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => new Promise(r => server.close(() => r(undefined))));
  return { got, base: `http://127.0.0.1:${/** @type {any} */ (server.address()).port}` };
}

/** A raw request on the socket, as curl --unix-socket would send it. */
function raw(socketPath, url, body, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath, path: url, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, res => {
      let out = ""; res.on("data", c => (out += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(out) }));
    });
    req.end(data);
  });
}

/** Run a child with pipes and no controlling terminal, as the Bash tool does. */
function child(args, env, input = "") {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env, NO_COLOR: "1" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", c => (out += c)); p.stderr.on("data", c => (out += c));
    p.on("close", code => resolve({ code, out }));
    p.stdin.end(input);
  });
}

/**
 * A real vyred with the real Gate and verifier. Touch ID is off, so no test can show the user a
 * dialog, and the terminal method writes into `screen` instead of a device.
 */
async function box(t) {
  const root = tempHome(t);
  const mail = await outbox(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" },
    gate: { senders: { mail: { type: "gmail", vault: "mail-token", from: "me@example.com", base: mail.base } } } }));
  const screen = [];
  const d = await start({ root, log: () => {}, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) },
    who: async () => ["ttys007"], statTty: () => ({ uid: process.getuid?.() ?? 0, isCharacterDevice: () => true }),
    writeTty: (file, text) => screen.push({ file, text }) }) });
  t.after(() => d.stop());

  // The person's Capsule key, enrolled the way presence.enroll stores it.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const key = d.registry.deps.presence.enroll({ kind: "capsule", name: "Capsule", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url") });
  const signed = (tool, input) => {
    const ts = Date.now(), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign(null, Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), privateKey).toString("base64url");
    return `capsule key=${key.id} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  const person = (tool, input) => call(tool, input, { root, caller: "cli", headers: { "x-vyre-presence": signed(tool, input) } });

  const put = await person("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-" + crypto.randomBytes(8).toString("hex") } });
  assert.ok(put.data, JSON.stringify(put));
  assert.ok((await call("vault.grant", { name: "mail-token", module: "gate" }, { root, caller: "cli" })).data);
  const held = await call("gate.request", { kind: "send", via: "mail", to: "someone@example.com", content: { subject: "Hello", body: "Draft by the model" } }, { root, caller: "mcp" });
  assert.equal(held.data.state, "held");
  return { root, d, mail, screen, id: held.data.id, person, signed, socket: d.paths.socket };
}

test("bypass: curl on the socket with a forged caller cannot approve", async t => {
  const b = await box(t);
  for (const caller of ["cli", "local", "capsule", "deck", "tailnet:me@example.com", "module:gate", "hook"]) {
    const r = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": caller });
    assert.equal(r.status, 403, caller);
    // Refused for want of a proof, or earlier, because the Gate does not take this caller at all.
    assert.ok(["presence_required", "denied"].includes(r.body.error.code), caller);
  }
  for (const proof of ["touchid", "tty id=nope code=AAAAAA", "capsule key=nope ts=1 nonce=n sig=s", "passkey id=x cred=y ad=z cd=w sig=v", "code code=ABCDEFGH"]) {
    const r = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": "cli", "x-vyre-presence": proof });
    assert.equal(r.status, 403, proof);
  }
  assert.equal(b.mail.got.length, 0, "nothing was sent");
});

test("bypass: an agent claiming to be the assistant, or a surface, cannot approve", async t => {
  const b = await box(t);
  for (const caller of ["mcp:agent:assistant", "mcp:agent:juno", "mcp"]) {
    const r = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": caller });
    assert.equal(r.status, 403, caller);
  }
  // A proof made for another item, or replayed, is no proof.
  const other = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": "capsule", "x-vyre-presence": b.signed("gate.approve", { id: "someone-else" }) });
  assert.equal(other.status, 403);
  assert.equal(b.mail.got.length, 0);
});

test("bypass: vyre call from a process with no terminal cannot approve", async t => {
  const b = await box(t);
  const r = await child([BIN, "call", "gate.approve", JSON.stringify({ id: b.id })], { VYRE_HOME: b.root });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /needs a person at a terminal/);
  const tty = await child([BIN, "call", "--tty", "gate.approve", JSON.stringify({ id: b.id })], { VYRE_HOME: b.root });
  assert.notEqual(tty.code, 0);
  assert.equal(b.screen.length, 0, "no code was written to any terminal");
  assert.equal(b.mail.got.length, 0);
});

test("bypass: a Bash tool call that tries it is denied by the floor, with vyred up and with it down", async t => {
  const b = await box(t);
  const tries = [`vyre call gate.approve '{"id":"${b.id}"}'`, `vyre gate approve ${b.id}`,
    `curl --unix-socket ${b.socket} -H 'x-vyre-caller: cli' -d '{"id":"${b.id}"}' http://x/v1/tools/gate.approve`,
    `sqlite3 ${path.join(b.root, "vyre.db")} "update gate_items set state='approved'"`];
  const hook = command => child([HOOK, "rules"], { VYRE_HOME: b.root }, JSON.stringify({ session_id: "s1", cwd: "/tmp", tool_name: "Bash", tool_input: { command } }));
  for (const command of tries) {
    const r = await hook(command);
    assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny", command);
  }
  await b.d.stop();
  for (const command of tries) {
    const r = await hook(command);
    assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny", "vyred down: " + command);
  }
  assert.equal(b.mail.got.length, 0);
});

test("bypass: the person's own routes still work, once each", async t => {
  const b = await box(t);
  // The Capsule: a signed call.
  const header = b.signed("gate.approve", { id: b.id });
  const ok = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": "capsule", "x-vyre-presence": header });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(b.mail.got.length, 1);
  const replay = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": "capsule", "x-vyre-presence": header });
  assert.equal(replay.status, 403, "a signature is used once");

  // A terminal: vyred writes a code to a login terminal, and the person types it back.
  const second = await call("gate.request", { kind: "send", via: "mail", to: "someone@example.com", content: { subject: "Two", body: "Second draft" } }, { root: b.root, caller: "mcp" });
  const input = { id: second.data.id };
  const c = await raw(b.socket, "/v1/presence/challenge", { tool: "gate.reject", input, method: "tty", tty: "/dev/ttys007" }, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(b.screen.at(-1).file, "/dev/ttys007");
  const code = /type this code[^:]*: ([A-Z0-9]+)/i.exec(b.screen.at(-1).text)?.[1];
  assert.ok(code, b.screen.at(-1).text);
  const rejected = await raw(b.socket, "/v1/tools/gate.reject", input, { "x-vyre-caller": "cli", "x-vyre-presence": `tty id=${c.body.data.challenge} code=${code}` });
  assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
  const notLogin = await raw(b.socket, "/v1/presence/challenge", { tool: "gate.reject", input, method: "tty", tty: "/dev/ttys099" }, {});
  assert.equal(notLogin.status, 403, "a terminal who does not list, like a script pty, gets no code");
});

test("bypass: a presence session never approves, and only a strong proof opens one", async t => {
  const b = await box(t);
  const tty = await raw(b.socket, "/v1/tools/presence.session.open", {}, { "x-vyre-caller": "cli" });
  assert.equal(tty.status, 403, "no proof, no session");
  const opened = await raw(b.socket, "/v1/tools/presence.session.open", {}, { "x-vyre-caller": "capsule", "x-vyre-presence": b.signed("presence.session.open", {}) });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const { session, secret } = opened.body.data;
  const r = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, { "x-vyre-caller": "capsule", "x-vyre-presence": `session id=${session} secret=${secret}` });
  assert.equal(r.status, 403);
  assert.equal(b.mail.got.length, 0);
});
