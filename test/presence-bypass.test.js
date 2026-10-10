// @ts-check
// Every way a model could approve its own held email (docs/adr/0004-presence.md), against a real
// vyred with the real Gate and a fake mail server. Each route must be refused with nothing sent,
// and the person's own routes (a signed Capsule call, a code typed at a login terminal) must work.

import "../scripts/mac-test-guard.mjs";
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
import { tempHome, kernelCaller } from "./helpers.js";

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

/** raw, with the response headers too. */
function rawWithHeaders(socketPath, url, body, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath, path: url, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), ...headers } }, res => {
      let out = ""; res.on("data", c => (out += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(out) }));
    });
    req.end(data);
  });
}

/** Run a child with pipes and no controlling terminal, as the Bash tool does. */
function child(args, env, input = "") {
  return new Promise(resolve => {
    const p = spawn(process.execPath, args, { env: { ...process.env, ...env, NO_COLOR: "1" }, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", stdout = "";
    p.stdout.on("data", c => { out += c; stdout += c; }); p.stderr.on("data", c => (out += c));
    p.on("close", code => resolve({ code, out, stdout }));
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
    gate: { senders: { mail: { type: "gmail", vault: "mail-token", from: "me@example.com", base: mail.base },
      drive: { type: "http", vault: "mail-token", hosts: [mail.base] } } } }));
  const screen = [];
  const d = await start({ root, log: () => {}, presence: deps => new Presence({ ...deps,
    touchid: { available: async () => false, authenticate: async () => ({ ok: false, reason: "unavailable" }) },
    who: async () => ["ttys007"], statTty: () => ({ uid: process.getuid?.() ?? 0, isCharacterDevice: () => true }),
    writeTty: (file, text) => screen.push({ file, text }) }) });
  t.after(() => d.stop());

  // The person's Capsule key, enrolled the way presence.enroll stores it.
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const key = d.registry.deps.presence.enroll({ kind: "capsule", name: "Capsule", public_key: publicKey.export({ format: "der", type: "spki" }).toString("base64url"), alg: -7 });
  const signed = (tool, input) => {
    const ts = Date.now(), nonce = crypto.randomBytes(12).toString("base64url");
    const sig = crypto.sign("sha256", Buffer.from(`vyre-presence-v1\n${tool}\n${inputHash(input)}\n${ts}\n${nonce}`), { key: privateKey, dsaEncoding: "der" }).toString("base64url");
    return `capsule key=${key.id} ts=${ts} nonce=${nonce} sig=${sig}`;
  };
  const person = (tool, input) => call(tool, input, { root, caller: "cli", headers: { "x-vyre-presence": signed(tool, input) } });

  const put = await person("vault.put", { name: "mail-token", kind: "api-key", fields: { value: "fixture-" + crypto.randomBytes(8).toString("hex") } });
  assert.ok(put.data, JSON.stringify(put));
  assert.ok((await person("vault.grant", { name: "mail-token", module: "gate" })).data, "a grant needs a person too");
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
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", command);
  }
  await b.d.stop();
  for (const command of tries) {
    const r = await hook(command);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", "vyred down: " + command);
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
  const c = await raw(b.socket, "/v1/presence/challenge", { tool: "gate.approve", input, method: "tty", tty: "/dev/ttys007" }, {});
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(b.screen.at(-1).file, "/dev/ttys007");
  const code = /type this code[^:]*: ([A-Z0-9]+)/i.exec(b.screen.at(-1).text)?.[1];
  assert.ok(code, b.screen.at(-1).text);
  const sent = await raw(b.socket, "/v1/tools/gate.approve", input, { "x-vyre-caller": "cli", "x-vyre-presence": `tty id=${c.body.data.challenge} code=${code}` });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(b.mail.got.length, 2);
  const notLogin = await raw(b.socket, "/v1/presence/challenge", { tool: "gate.approve", input, method: "tty", tty: "/dev/ttys099" }, {});
  assert.equal(notLogin.status, 403, "a terminal who does not list, like a script pty, gets no code");
});

test("bypass: revising, discarding and deleting sends nothing and asks for no proof; answering needs only a person", async t => {
  const b = await box(t);
  const deck = { "x-vyre-caller": "deck" };
  const send = await raw(b.socket, "/v1/tools/gate.approve", { id: b.id }, deck);
  assert.equal(send.body.error.code, "presence_required", "a send still asks");
  assert.equal((await raw(b.socket, "/v1/tools/gate.revise", { id: b.id, edited: { subject: "Hello again" } }, { "x-vyre-caller": "cli" })).status, 200);
  assert.equal((await raw(b.socket, "/v1/tools/gate.reject", { id: b.id }, deck)).status, 200);
  assert.equal(b.mail.got.length, 0);
  // Deleting the user's data outside cannot be undone, so it asks like a send.
  const del = (await call("gate.request", { kind: "delete", via: "drive", to: "northwind-bakery", content: { method: "DELETE", url: `${b.mail.base}/files/menu.pdf` } }, { root: b.root, caller: "mcp" }));
  assert.ok(del.data, JSON.stringify(del.error));
  assert.deepEqual((await call("gate.get", { id: del.data.id }, { root: b.root, caller: "deck" })).data.presence, { required: true, covered: false, since: null });
  assert.equal((await raw(b.socket, "/v1/tools/gate.approve", { id: del.data.id }, deck)).body.error.code, "presence_required");
  // A model is refused all of them, silently: no proof is asked of it.
  const other = (await call("gate.request", { kind: "send", via: "mail", to: "dana@harlowlegal.com", content: { subject: "x", body: "y" } }, { root: b.root, caller: "mcp" })).data.id;
  for (const tool of ["gate.reject", "gate.revise"]) {
    const r = await raw(b.socket, `/v1/tools/${tool}`, { id: other, edited: { subject: "z" } }, { "x-vyre-caller": "mcp" });
    assert.equal(r.status, 403, tool);
    assert.notEqual(r.body.error.code, "presence_required", tool);
  }
  // threads.answer: no proof from a person's surface (the answer itself fails: no such ask), refused to a model.
  const ans = await raw(b.socket, "/v1/tools/threads.answer", { ask: "nope", decision: "allow" }, deck);
  assert.notEqual(ans.body.error?.code, "presence_required", JSON.stringify(ans.body));
  assert.equal((await raw(b.socket, "/v1/tools/threads.answer", { ask: "nope", decision: "allow" }, { "x-vyre-caller": "mcp" })).body.error.code, "denied");
});

test("bypass: on the box, Claude's socket cannot enroll a passkey with a code it fetched, and the tailnet owner cannot either (PW-1: the owner's paired device only)", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ role: "box", vault: { keystore: "file" }, modules: { disable: ["names", "onboard", "link"] },
    network: { tailscale: true, owner: "me@example.com", address: "https://me.vyre.run" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const key = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const enroll = rp_id => ({ kind: "passkey", name: "x", public_key: key, alg: -7, rp_id, credential_id: "cred-" + rp_id.replace(/\./g, "-") });
  // What Claude could get: a fresh code, as a module (onboarding) would mint it.
  // A module may NOT mint a passkey code (a code enrols a presence key, the root of every later approval): the registry refuses it, so a fixture mints through the Presence object itself.
  const refusedForModule = await d.registry.call("presence.code", {}, "module:onboard");
  assert.equal(refusedForModule.error && refusedForModule.error.code, "denied", "a module cannot mint a passkey code: " + JSON.stringify(refusedForModule));
  const code = async () => (await d.registry.deps.presence.mintCode()).code;
  for (const caller of ["cli", "local", "capsule"]) {
    const r = await raw(d.paths.socket, "/v1/tools/presence.enroll", enroll("me.vyre.run"), { "x-vyre-caller": caller, "x-vyre-presence": `code code=${await code()}` });
    assert.equal(r.status, 403, caller);
  }
  const wrong = await d.registry.call("presence.enroll", enroll("evil.example.com"), "tailnet:me@example.com", { proof: { method: "code", code: await code() } });
  // refused: before PW-1 for the wrong address, since PW-1 earlier, because a passkey on the box enrols only from the owner's own paired device
  assert.match(wrong.error.message, /must be for me\.vyre\.run|owner's own paired device/);
  // PW-1: even for the box's own address, a passkey on the box enrols only from the owner's own paired device, never over the tailnet (the tailnet goes in 0.3.0)
  const tailnet = await d.registry.call("presence.enroll", enroll("me.vyre.run"), "tailnet:me@example.com", { proof: { method: "code", code: await code() } });
  assert.match(String(tailnet.error && tailnet.error.message), /owner's own paired device/, JSON.stringify(tailnet));
  assert.equal((await d.registry.call("presence.keys", {}, "cli")).data.filter(k => k.kind === "passkey").length, 0);
});

test("bypass: making or changing an agent is a person's, with no passkey; the assistant changes only words and model", async t => {
  const b = await box(t);

  const refused = async (tool, input, caller) => {
    const r = await raw(b.socket, `/v1/tools/${tool}`, input, { "x-vyre-caller": caller });
    assert.equal(r.status, 403, `${tool} ${caller}: ${JSON.stringify(r.body)}`);
    assert.notEqual(r.body.error.code, "presence_required", `${tool} ${caller} is refused, never asked`);
  };
  const allowed = async (tool, input, caller) => {
    const r = await raw(b.socket, `/v1/tools/${tool}`, input, { "x-vyre-caller": caller });
    assert.equal(r.status, 200, `${tool} ${caller}: ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  // A person's surfaces make agents without a proof, "Give it its own computer" and credentials included.
  await allowed("agents.create", { name: "juno", kind: "assistant" }, "cli");
  await allowed("agents.create", { name: "kit", auth: { vault: "claude-setup-token", budget_usd: 5 }, computer: true }, "deck");
  await allowed("agents.create", { name: "scout", projects: [] }, "capsule");
  // No model makes one, the assistant included, and no bare MCP session or guest.
  const make = { name: "ledger", auth: { vault: "claude-setup-token", budget_usd: 5 } };
  for (const caller of ["mcp", "mcp:agent:juno", "mcp:agent:kit", "tailnet-guest:sam@example.com"]) await refused("agents.create", make, caller);
  assert.ok(!(await call("agents.list", {}, { root: b.root, caller: "cli" })).data.some(a => a.name === "ledger"), "nothing was made");
  // A person changes anything, with no proof: credentials and budget, projects, skills, its computer.
  for (const change of [{ auth: { vault: "claude-setup-token", budget_usd: 500 } }, { projects: "*" }, { skills: ["deploy"] }, { computer: false }]) {
    if (change.projects) {
      // giving an agent a project is a kernel grant, a person's own call with their device's facts and no passkey (a bare label is never a person)
      for (const [caller, who] of [["deck", { name: "kit" }], ["cli", { agent: "kit" }]]) { const r = await kernelCaller(b.d, b.root, caller)("agents.update", { ...who, ...change }); assert.equal(r.error, undefined, `agents.update ${caller}: ${JSON.stringify(r.error)}`); }
      continue;
    }
    await allowed("agents.update", { name: "kit", ...change }, "deck");
    await allowed("agents.update", { agent: "kit", ...change }, "cli");
  }
  // The assistant changes an agent's words and model, and nothing it can reach or spend. vyred
  // names an agent caller only from inside its running thread, so this is that call as it arrives.
  const words = { name: "kit", instructions: "Drafts replies for Northwind Bakery.", model: "claude-sonnet-5" };
  const asJuno = input => b.d.registry.call("agents.update", input, "mcp:agent:juno", { agent: "juno" });
  const mine = await asJuno(words);
  assert.equal(mine.data?.instructions, words.instructions, JSON.stringify(mine));
  for (const change of [{ auth: { budget_usd: 500 } }, { projects: "*" }, { skills: ["deploy"] }, { computer: true }]) {
    assert.equal((await asJuno({ ...words, ...change })).error?.code, "denied", Object.keys(change)[0]);
  }
  assert.equal((await b.d.registry.call("agents.update", words, "mcp:agent:kit", { agent: "kit" })).error?.code, "denied", "kit is not the assistant");
  // Any other agent, a bare MCP session and a guest change nothing, not even words.
  for (const caller of ["mcp", "mcp:agent:kit", "mcp:agent:scout", "tailnet-guest:sam@example.com"]) await refused("agents.update", words, caller);
});
