// @ts-check
// Red-team refusals for api-credential `readers` (the modules a person let read named paths through a
// credential, like the Capsule's next-meeting line reading a calendar). One test per finding, named
// "redteam <ID>: <attack> is refused". They register the vault's request tool over a real vault in a temp folder with an
// injected resolver, transport and Gate (as core/vault/request.test.js does), because a reader's rule is decided after the
// request is planned and a real daemon cannot resolve a made-up host. Nothing here boots a vyred, so they run anywhere and
// nothing leaves the machine. The credential `ms` lets module `connectors` read exactly /v1.0/me/calendarView.
// (The tool-level refusals of vault.update and vault.edit are in core/vault/api-readers.test.js, which does boot a daemon.)

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../../core/store/index.js";
import { Vault, MIGRATIONS } from "../../core/vault/vault.js";
import * as saidTools from "../../core/vault/said.js";
import { register } from "../../core/vault/request.js";
import { SCRATCH } from "../scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const HOST = "graph.example.test";
const CONFIG = { auth: { type: "bearer" }, hosts: [HOST], readers: [{ module: "connectors", paths: ["/v1.0/me/calendarView"] }] };

async function world(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-readers-rt-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "test-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {string[]} */ ([]) };
  const gate = { held: /** @type {any[]} */ ([]) };
  const tools = new Map();
  const tool = (name, callers, description, input, run) => tools.set(name, { callers, run });
  const internal = (name, description, input, run) => tools.set(name, { callers: null, run });
  const call = async (name, input) => {
    if (name === "gate.offer") return { data: {} };
    if (name === "gate.request") { gate.held.push(input); return { data: { id: `h${gate.held.length}`, state: "held", message: "held" } }; }
    return { error: { code: "no_such_tool", message: name } };
  };
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call, said, deps: { lookup: async () => [{ address: "203.0.113.10", family: 4 }],
    transport: async r => { net.calls.push(`${r.method} ${r.url.pathname}`); return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; } } });
  const secret = fake("secret");
  await v.put({ name: "ms", kind: "api-credential", fields: { config: JSON.stringify(CONFIG), secret } }, "cli");
  const as = (caller, meta = {}) => input => Promise.resolve().then(() => tools.get("vault.request").run({ credential: "ms", ...input }, { caller, ...meta })).then(data => ({ data }), error => ({ error }));
  const put = (input, who) => v.put(input, who).then(data => ({ data }), error => ({ error }));
  return { v, net, gate, secret, put, reader: as("module:connectors"), asModule: m => as(`module:${m}`), asModel: as("mcp"), asAgent: as("mcp:agent:kit", { agent: "kit" }),
    url: p => `https://${HOST}${p}`, audit: () => JSON.stringify(v.auditTrail({ limit: 500 }).entries) };
}

const refused = (r, re) => { assert.ok(r.error, "it was refused"); assert.match(String(r.error.message), re, r.error.message); };
const passedTheRule = r => assert.ok(r.data && r.data.status === 200, JSON.stringify(r.error && r.error.message));

test("redteam RT-A1a: a reader module reading a path it was not named for is refused", async t => {
  const w = await world(t);
  for (const p of ["/v1.0/me/messages", "/v1.0/me/calendarViewOther", "/v1.0/me/calendarView/extra", "/v1.0/me", "/v1.0/me/mailFolders/inbox/messages", "/beta/me/calendarView", "/"]) {
    refused(await w.reader({ method: "GET", url: w.url(p) }), /may only read/);
  }
  passedTheRule(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView"), query: { startDateTime: "2026-10-01T00:00:00Z" } }));
  assert.equal(w.net.calls.length, 1, "only the named path reached the network");
  assert.ok(!w.audit().includes(w.secret), "no value in the audit");
});

test("redteam RT-A1b: a write, send or delete through a read-only reader is refused, not held", async t => {
  const w = await world(t);
  for (const [method, p, body] of [["POST", "/v1.0/me/calendarView", { x: 1 }], ["POST", "/v1.0/me/events", { subject: "x" }], ["POST", "/v1.0/me/sendMail", { message: { subject: "x", toRecipients: [{ emailAddress: { address: "a@b.test" } }] } }],
    ["PATCH", "/v1.0/me/calendarView", { x: 1 }], ["PUT", "/v1.0/me/calendarView", { x: 1 }], ["DELETE", "/v1.0/me/calendarView", undefined]]) {
    refused(await w.reader({ method, url: w.url(p), ...(body ? { body } : {}) }), /may only read/);
  }
  assert.equal(w.gate.held.length, 0, "nothing was left waiting at the Gate for it");
  assert.equal(w.net.calls.length, 0);
});

test("redteam RT-A1c: smuggling another path past the reader's (encoded slash or dot, backslash, dot segments, a path parameter) is refused", async t => {
  const w = await world(t);
  for (const p of ["/v1.0/me/calendarView%2f..%2fmessages", "/v1.0/me/calendarView%2F..%2Fmessages", "/v1.0/me/calendarView%5cmessages", "/v1.0/me/calendarView/%2e%2e/messages",
    "/v1.0/me/calendarView/../messages", "/v1.0/me/calendarView;x=../messages", "/v1.0/me/calendarView%00/messages", "/v1.0/me/calendarView%252f..%252fmessages", "/v1.0/me/./calendarView/../messages"]) {
    const r = await w.reader({ method: "GET", url: w.url(p) });
    assert.ok(r.error, `${p} was refused`);
  }
  assert.equal(w.net.calls.filter(c => /messages/.test(c)).length, 0, "the mailbox was never reached");
});

test("redteam RT-A1d: a module that is not the named reader, a watcher, and the reader's watcher are refused", async t => {
  const w = await world(t);
  for (const m of ["sessions", "assistant", "watchers", "mcp", "google", "evilmodule"]) refused(await w.asModule(m)({ method: "GET", url: w.url("/v1.0/me/calendarView") }), /not granted/);
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView"), watcher: "w1" }), /not granted/);
  for (const extra of [{ module: "connectors" }, { reader: "connectors" }, { caller: "module:connectors" }, { as: "module:connectors" }]) {
    const r = await w.asModule("sessions")({ method: "GET", url: w.url("/v1.0/me/calendarView"), ...extra });
    assert.ok(r.error, JSON.stringify(extra));
  }
  assert.equal(w.net.calls.length, 0);
});

test("redteam RT-A1e: a model, agent, module or hook making itself a reader, widening the list or replacing the key is refused", async t => {
  const w = await world(t);
  const wide = JSON.stringify({ ...CONFIG, readers: [{ module: "connectors", paths: ["/v1.0/me/*"] }, { module: "sessions", paths: ["/v1.0/me/messages*"] }] });
  for (const who of ["mcp", "mcp:agent:kit", "module:connectors", "module:sessions", "module:watchers", "hook"]) {
    assert.ok((await w.put({ name: "ms", kind: "api-credential", fields: { config: wide, secret: fake("s") } }, who)).error, `${who} put with config`);
    assert.ok((await w.put({ name: "ms", kind: "api-credential", fields: { secret: fake("s") } }, who)).error, `${who} put of the key alone`);
  }
  // still exactly one reader and one path
  refused(await w.asModule("sessions")({ method: "GET", url: w.url("/v1.0/me/messages") }), /not granted/);
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/events") }), /may only read/);
});

test("redteam RT-A1f: a model's or agent's own write through the credential is held, never run, and is never a reader's", async t => {
  const w = await world(t);
  for (const asCaller of [w.asModel, w.asAgent]) {
    const r = await asCaller({ method: "POST", url: w.url("/v1.0/me/sendMail"), body: { message: { subject: "hi", toRecipients: [{ emailAddress: { address: "dana@harlowlegal.com" } }] } } });
    assert.ok(r.data && r.data.held, JSON.stringify(r));
  }
  assert.equal(w.gate.held.length, 2);
  assert.equal(w.net.calls.length, 0, "nothing reached the network");
});

test("redteam RT-A1g: a reader does not outlive its credential: delete it and make another of the name, and connectors is refused", async t => {
  const w = await world(t);
  passedTheRule(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }));
  w.v.remove({ name: "ms" }, "cli");
  assert.ok((await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") })).error, "gone");
  await w.v.put({ name: "ms", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: [HOST] }), secret: fake("s2") } }, "cli");
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }), /not granted/);
});

test("redteam RT-A1h: replacing the key by a person keeps the readers; a module replacing it is refused", async t => {
  const w = await world(t);
  assert.ok((await w.put({ name: "ms", kind: "api-credential", fields: { secret: fake("rotated") } }, "cli")).data);
  passedTheRule(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }));
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/messages") }), /may only read/);
  assert.ok((await w.put({ name: "ms", kind: "api-credential", fields: { secret: fake("x") } }, "module:connectors")).error);
});

test("redteam RT-A1i: a reader cannot be pointed at another host or widened by the credential it reads", async t => {
  const w = await world(t);
  for (const u of ["https://elsewhere.example.test/v1.0/me/calendarView", `https://${HOST}.evil.example.test/v1.0/me/calendarView`, `https://user@${HOST}/v1.0/me/calendarView`, `http://${HOST}/v1.0/me/calendarView`]) {
    assert.ok((await w.reader({ method: "GET", url: u })).error, u);
  }
  assert.equal(w.net.calls.length, 0);
  assert.ok(!w.audit().includes(w.secret));
});
