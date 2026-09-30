// @ts-check
// `readers` on an api-credential: the person names, when they make the credential, a module that may
// read named paths through it (the Capsule's next-meeting line reads a calendar). With fakes only.
// What these prove: the shape is checked; a listed reader reads the named paths with no grant, and
// nothing else (another path, a write, a send) is refused to it, never held; a module that is not a
// reader still needs a grant; and only a person's own surface can write the list at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import * as saidTools from "./said.js";
import { register } from "./request.js";
import { normalize, readerMayRead } from "./api-request.js";
import { SCRATCH } from "../../test/scratch.mjs";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
const CONFIG = { auth: { type: "bearer" }, hosts: ["graph.microsoft.com"], readers: [{ module: "connectors", paths: ["/v1.0/me/calendarView*", "/v1.0/me/events*"] }] };

async function mk(t) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-readers-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "harlow-box", vault: { keystore: "file" } }, emit: () => {}, log: () => {} });
  t.after(() => { db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const net = { calls: /** @type {any[]} */ ([]) };
  const tools = new Map();
  const tool = (name, callers, description, input, run) => tools.set(name, { callers, run });
  const internal = (name, description, input, run) => tools.set(name, { callers: null, run });
  const gate = { held: /** @type {any[]} */ ([]) };
  const call = async (name, input) => {
    if (name === "gate.offer") return { data: {} };
    if (name === "gate.request") { gate.held.push(input); return { data: { id: "h1", state: "held", message: "held" } }; }
    return { error: { code: "no_such_tool", message: name } };
  };
  const said = saidTools.register({ vault: v, internal });
  register({ vault: v, tool, internal, call, said, deps: { lookup: async () => [{ address: "203.0.113.10", family: 4 }], transport: async r => { net.calls.push(`${r.method} ${r.url.pathname}`); return json(200, { value: [{ subject: "Harlow Legal check-in" }] }); } } });
  const secret = fake("secret");
  await v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify(CONFIG), secret } }, "cli");
  const ask = (input, caller) => tools.get("vault.request").run({ credential: "microsoft", ...input }, { caller });
  return { v, net, gate, ask, secret };
}

test("readers: the shape is checked", () => {
  assert.deepEqual(normalize(CONFIG).readers, CONFIG.readers);
  assert.equal(normalize({ ...CONFIG, readers: undefined }).readers, undefined);
  for (const bad of ["connectors", [{ module: "Bad Name", paths: ["/a"] }], [{ module: "connectors" }], [{ module: "connectors", paths: [] }], [{ module: "connectors", paths: ["no-slash"] }],
    Array.from({ length: 9 }, (_, i) => ({ module: `m${i}`, paths: ["/a"] }))]) assert.throws(() => normalize({ ...CONFIG, readers: bad }), /reader/, JSON.stringify(bad).slice(0, 60));
  assert.equal(readerMayRead(normalize(CONFIG), "connectors", "/v1.0/me/calendarView?startDateTime=a"), true);
  assert.equal(readerMayRead(normalize(CONFIG), "connectors", "/v1.0/me/messages"), false);
  assert.equal(readerMayRead(normalize(CONFIG), "sessions", "/v1.0/me/calendarView?x=1"), false);
});

test("a listed reader reads the named paths with no grant, and nothing else; others still need a grant", async t => {
  const m = await mk(t);
  const r = await m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView", query: { startDateTime: "2026-10-01T00:00:00Z" } }, "module:connectors");
  assert.equal(r.kind, "read");
  assert.deepEqual(r.body.value, [{ subject: "Harlow Legal check-in" }]);
  assert.deepEqual(m.net.calls, ["GET /v1.0/me/calendarView"]);
  // another path, a write and a send are refused to the reader, not held
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages" }, "module:connectors"), /may only read \/v1\.0\/me\/calendarView/);
  await assert.rejects(m.ask({ method: "POST", url: "https://graph.microsoft.com/v1.0/me/events", body: { subject: "x" } }, "module:connectors"), /may only read/);
  await assert.rejects(m.ask({ method: "POST", url: "https://graph.microsoft.com/v1.0/me/sendMail", body: { message: {} } }, "module:connectors"), /may only read/);
  assert.equal(m.gate.held.length, 0, "nothing was held for it");
  assert.equal(m.net.calls.length, 1, "nothing else reached the network");
  // a module that is not a reader still needs a grant
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView" }, "module:sessions"), /is not granted to sessions/);
  // a person is unaffected, and a reader cannot be claimed in a request
  assert.equal((await m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages" }, "cli")).status, 200);
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages", watcher: "w1" }, "module:connectors"), /not granted/, "a watcher's call is not a reader's");
  // the audit never carries a value
  const trail = JSON.stringify(m.v.auditTrail({ limit: 200 }).entries);
  assert.ok(!trail.includes(m.secret));
});

test("only a person's own surface writes readers; a module cannot add itself", async t => {
  const m = await mk(t);
  for (const who of ["module:connectors", "module:sessions", "mcp"]) {
    await assert.rejects(m.v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify({ ...CONFIG, readers: [{ module: "sessions", paths: ["/v1.0/me/messages*"] }] }), secret: fake("s") } }, who), /only from your own surfaces|your own surfaces/, who);
  }
});
