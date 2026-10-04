// @ts-check
// `readers` on an api-credential: the person names, when they make the credential, a module that may
// read named paths through it (the Capsule's next-meeting line reads a calendar). With fakes only.
// What these prove: the shape is checked; a listed reader reads the named paths with no grant, and
// nothing else (another path, a write, a send) is refused to it, never held; a module that is not a
// reader still needs a grant; and only a person's own surface can write the list at all.

import "../../scripts/mac-test-guard.mjs";
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
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const json = (status, body) => ({ status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) });
const CONFIG = { auth: { type: "bearer" }, hosts: ["graph.microsoft.com"], readers: [{ module: "connectors", paths: ["/v1.0/me/calendarView", "/v1.0/me/events*"] }] };

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
  register({ vault: v, tool, internal, call, said, deps: { lookup: async () => [{ address: "203.0.113.10", family: 4 }], transport: async r => { net.last = r.headers; net.calls.push(`${r.method} ${r.url.pathname}`); return json(200, { value: [{ subject: "Harlow Legal check-in" }] }); } } });
  const secret = fake("secret");
  await v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify(CONFIG), secret } }, "cli");
  const ask = (input, caller) => tools.get("vault.request").run({ credential: "microsoft", ...input }, { caller });
  return { v, net, gate, ask, secret };
}

test("readers: the shape is checked", () => {
  assert.deepEqual(normalize(CONFIG).readers, CONFIG.readers);
  assert.equal(normalize({ ...CONFIG, readers: undefined }).readers, undefined);
  for (const badPath of ["/a/*/b", "/a%2fb", "/a b", "/a/../b", "no-slash", "/a**"]) assert.throws(() => normalize({ ...CONFIG, readers: [{ module: "connectors", paths: [badPath] }] }), /reader lists the paths/, badPath);
  for (const bad of ["connectors", [{ module: "Bad Name", paths: ["/a"] }], [{ module: "connectors" }], [{ module: "connectors", paths: [] }], [{ module: "connectors", paths: ["no-slash"] }],
    Array.from({ length: 9 }, (_, i) => ({ module: `m${i}`, paths: ["/a"] }))]) assert.throws(() => normalize({ ...CONFIG, readers: bad }), /reader/, JSON.stringify(bad).slice(0, 60));
  assert.equal(readerMayRead(normalize(CONFIG), "connectors", "/v1.0/me/calendarView?startDateTime=a"), true);
  assert.equal(readerMayRead(normalize(CONFIG), "connectors", "/v1.0/me/messages"), false);
  assert.equal(readerMayRead(normalize(CONFIG), "sessions", "/v1.0/me/calendarView?x=1"), false);
  // a prefix ends at a segment, and an encoded slash or dot is never a way past it
  const c = normalize(CONFIG);
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/calendarView"), true);
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/calendarView?startDateTime=a&$top=5"), true, "the exact path, then its query");
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/calendarView/abc?x=1"), false, "no trailing * means exactly that path");
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/calendarViewOther"), false, "a sibling is not the path");
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/calendarView;jsessionid=x"), false, "a path parameter is refused");
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/events/abc"), true, "a trailing * keeps its own subpaths");
  assert.equal(readerMayRead(c, "connectors", "/v1.0/me/eventsfoo"), false);
  for (const p of ["/v1.0/me/calendarView%2f..%2fmessages", "/v1.0/me/calendarView%2F..%2Fmessages", "/v1.0/me/calendarView/%2e%2e/messages", "/v1.0/me/calendarView/../messages", "/v1.0/me/calendarView%5cmessages", "/v1.0/me/events/%00"])
    assert.equal(readerMayRead(c, "connectors", p), false, p);
  const exact = normalize({ ...CONFIG, readers: [{ module: "connectors", paths: ["/v1.0/me"] }] });
  assert.equal(readerMayRead(exact, "connectors", "/v1.0/me"), true);
  assert.equal(readerMayRead(exact, "connectors", "/v1.0/me/messages"), false, "no trailing * means exactly that path");
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
  // an encoded slash does not smuggle the mailbox past the calendar prefix
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView%2f..%2fmessages" }, "module:connectors"), /encoded slash|may only read/);
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarViewfoo" }, "module:connectors"), /may only read/);
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

test("a module that is both a listed reader and granted is still limited to its reader paths", async t => {
  const m = await mk(t);
  await m.v.grant({ name: "microsoft", module: "connectors" }, "cli");
  assert.equal((await m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView" }, "module:connectors")).status, 200);
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages" }, "module:connectors"), /may only read/, "the grant does not widen it");
  await assert.rejects(m.ask({ method: "POST", url: "https://graph.microsoft.com/v1.0/me/sendMail", body: { message: {} } }, "module:connectors"), /may only read/);
  assert.equal(m.gate.held.length, 0);
});

test("readers can be written and widened only from a person's surface, by put, update and edit alike", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const reg = (tool, input, caller) => d.registry.call(tool, input, caller);
  const secret = fake("s");
  const wide = JSON.stringify({ ...CONFIG, readers: [{ module: "connectors", paths: ["/v1.0/me/*"] }, { module: "sessions", paths: ["/v1.0/me/messages*"] }] });
  assert.ok((await reg("vault.put", { name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify(CONFIG), secret } }, "cli")).data);
  for (const who of ["module:connectors", "module:sessions", "module:mcp", "mcp", "mcp:agent:juno"]) {
    for (const [tool, input] of [
      ["vault.put", { name: "microsoft", kind: "api-credential", fields: { config: wide, secret } }],
      ["vault.update", { name: "microsoft", fields: { config: wide } }],
      ["vault.edit", { name: "microsoft", fields: { config: wide } }],
    ]) {
      const r = await reg(tool, input, who);
      assert.ok(r.error, `${who} ${tool} was refused`);
    }
  }
  // the credential was not written by any of them: still one version
  const versions = async () => ((await reg("vault.history", { name: "microsoft" }, "cli")).data.versions || (await reg("vault.history", { name: "microsoft" }, "cli")).data.history || []).length;
  assert.equal(await versions(), 1, "no refused call wrote a new version");
  // a person changes it by put
  // update and edit read the item back to merge it, which an api-credential never allows, so even a person changes one only by put
  assert.match((await reg("vault.update", { name: "microsoft", fields: { config: wide } }, "cli")).error?.message || "", /never handed out/);
  assert.match((await reg("vault.edit", { name: "microsoft", fields: { config: wide } }, "cli")).error?.message || "", /never handed out|api-credential/);
  assert.ok((await reg("vault.put", { name: "microsoft", kind: "api-credential", fields: { config: wide, secret } }, "cli")).data);
  assert.equal(await versions(), 2);
});

test("replacing a calendar credential's key keeps its readers, so the next-meeting line survives a key rotation", async t => {
  const m = await mk(t);
  const read = () => m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView" }, "module:connectors");
  assert.equal((await read()).status, 200);
  // the person replaces only the key (Replace the key): no config in the put
  const newKey = fake("rotated");
  await m.v.put({ name: "microsoft", kind: "api-credential", fields: { secret: newKey } }, "cli");
  assert.equal((await read()).status, 200, "the reader still reads its calendar with no grant");
  assert.equal(m.net.last.authorization, `Bearer ${newKey}`, "and with the new key");
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages" }, "module:connectors"), /may only read/, "the mailbox stays closed to it");
  await assert.rejects(m.ask({ method: "GET", url: "https://elsewhere.example.test/x" }, "cli"), /host/i, "the hosts came along too");
  // a module cannot replace the key (and so cannot reset the readers)
  await assert.rejects(m.v.put({ name: "microsoft", kind: "api-credential", fields: { secret: fake("x") } }, "module:connectors"), /config|your own surfaces/);
});

test("changing a credential's scope by putting the rebuilt config with no secret keeps the stored key and the readers", async t => {
  const m = await mk(t);
  const read = () => m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/calendarView" }, "module:connectors");
  assert.equal((await read()).status, 200);
  const scoped = { ...CONFIG, scope: { projects: "*", agents: ["kit"] } };
  await m.v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify(scoped) } }, "cli");
  assert.equal((await read()).status, 200, "the reader still reads its calendar, with the old key");
  assert.match(m.net.last.authorization, /^Bearer fixture-secret-/, "the stored key was carried over");
  // back to no scope: the readers and the key are still there
  await m.v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify(CONFIG) } }, "cli");
  assert.equal((await read()).status, 200);
  await assert.rejects(m.ask({ method: "GET", url: "https://graph.microsoft.com/v1.0/me/messages" }, "module:connectors"), /may only read/);
  // widening where the key goes is not a scope change: new hosts need the key again
  await assert.rejects(m.v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify({ ...CONFIG, hosts: ["graph.microsoft.com", "elsewhere.example.test"] }) } }, "cli"), /secret|needs/i);
  // and a module cannot do any of it
  await assert.rejects(m.v.put({ name: "microsoft", kind: "api-credential", fields: { config: JSON.stringify(scoped) } }, "module:connectors"), /your own surfaces|config/);
});
