// @ts-check
// Red-team refusals for api-credential `readers` (the modules a person let read named paths through a
// credential, like the Capsule's next-meeting line reading a calendar). One runner test per finding, named
// "redteam <ID>: <attack> is refused"; each attempts the attack through a real registry in a temp home and
// asserts the refusal. Runs on runners and the test box (node --test "test/redteam/*.test.js"), never on the Mac:
// start() refuses a test daemon there. The host is an example name that never resolves, so nothing leaves the
// machine: a call that passes the reader rule fails later on the name, which is how the tests tell "refused by
// the rule" from "let through".
// Lines of the attack table: the credential `ms` lets module `connectors` read exactly /v1.0/me/calendarView.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { start } from "../../core/daemon/index.js";
import { tempHome, present } from "../helpers.js";

const fake = label => `fixture-${label}-${crypto.randomBytes(12).toString("hex")}`;
const HOST = "graph.example.test";
const CONFIG = { auth: { type: "bearer" }, hosts: [HOST], readers: [{ module: "connectors", paths: ["/v1.0/me/calendarView"] }] };

async function world(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const call = (tool, input, caller) => d.registry.call(tool, input, caller);
  const secret = fake("secret");
  assert.ok((await call("vault.put", { name: "ms", kind: "api-credential", fields: { config: JSON.stringify(CONFIG), secret } }, "cli")).data);
  const db = d.registry.deps.db;
  const held = () => db.prepare("SELECT count(*) AS n FROM gate_items").get().n;
  const audit = () => JSON.stringify(db.prepare("SELECT * FROM vault_audit").all());
  const as = caller => (input) => call("vault.request", { credential: "ms", ...input }, caller);
  return { d, call, secret, held, audit, reader: as("module:connectors"), asModule: m => as(`module:${m}`), asModel: as("mcp"), asAgent: as("mcp:agent:kit"), url: p => `https://${HOST}${p}` };
}

const refused = (r, re) => { assert.ok(r.error, "it was refused"); assert.match(r.error.message, re, r.error.message); };
/** A call the reader rule let through dies later on the example host; it must not die on the rule. */
const passedTheRule = r => assert.ok(r.error && !/may only read|not granted|denied/i.test(r.error.message), JSON.stringify(r));

test("redteam RT-A1a: a reader module reading a path it was not named for is refused", async t => {
  const w = await world(t);
  for (const p of ["/v1.0/me/messages", "/v1.0/me/calendarViewOther", "/v1.0/me/calendarView/extra", "/v1.0/me", "/v1.0/me/mailFolders/inbox/messages", "/beta/me/calendarView", "/"]) {
    refused(await w.reader({ method: "GET", url: w.url(p) }), /may only read/);
  }
  passedTheRule(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView"), query: { startDateTime: "2026-10-01T00:00:00Z" } }));
  assert.ok(!w.audit().includes(w.secret), "no value in the audit");
});

test("redteam RT-A1b: a write, send or delete through a read-only reader is refused, not held", async t => {
  const w = await world(t);
  const before = w.held();
  for (const [method, p, body] of [["POST", "/v1.0/me/calendarView", { x: 1 }], ["POST", "/v1.0/me/events", { subject: "x" }], ["POST", "/v1.0/me/sendMail", { message: { subject: "x", toRecipients: [{ emailAddress: { address: "a@b.test" } }] } }],
    ["PATCH", "/v1.0/me/calendarView", { x: 1 }], ["PUT", "/v1.0/me/calendarView", { x: 1 }], ["DELETE", "/v1.0/me/calendarView", undefined]]) {
    refused(await w.reader({ method, url: w.url(p), ...(body ? { body } : {}) }), /may only read/);
  }
  assert.equal(w.held(), before, "nothing was left waiting at the Gate for it");
});

test("redteam RT-A1c: smuggling another path past the reader's (encoded slash or dot, backslash, dot segments, a path parameter) is refused", async t => {
  const w = await world(t);
  for (const p of ["/v1.0/me/calendarView%2f..%2fmessages", "/v1.0/me/calendarView%2F..%2Fmessages", "/v1.0/me/calendarView%5cmessages", "/v1.0/me/calendarView/%2e%2e/messages",
    "/v1.0/me/calendarView/../messages", "/v1.0/me/calendarView;x=../messages", "/v1.0/me/calendarView%00/messages", "/v1.0/me/calendarView%252f..%252fmessages", "/v1.0/me/./calendarView/../messages"]) {
    const r = await w.reader({ method: "GET", url: w.url(p) });
    assert.ok(r.error, `${p} was refused`);
    assert.doesNotMatch(r.error.message, /ENOTFOUND|getaddrinfo|resolve/i, `${p} stopped before any network`);
  }
});

test("redteam RT-A1d: a module that is not the named reader, a watcher, and the reader's watcher are refused", async t => {
  const w = await world(t);
  for (const m of ["sessions", "assistant", "watchers", "mcp", "google", "evilmodule"]) refused(await w.asModule(m)({ method: "GET", url: w.url("/v1.0/me/calendarView") }), /not granted/);
  // the reader acting for a watcher is not the reader: a watcher's grant is its own
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView"), watcher: "w1" }), /not granted/);
  // a reader named in the input, or a claim of identity, changes nothing
  for (const extra of [{ module: "connectors" }, { reader: "connectors" }, { caller: "module:connectors" }, { as: "module:connectors" }]) {
    const r = await w.asModule("sessions")({ method: "GET", url: w.url("/v1.0/me/calendarView"), ...extra });
    assert.ok(r.error, JSON.stringify(extra));
  }
});

test("redteam RT-A1e: a model or an agent cannot make itself a reader, widen the list, or replace the key", async t => {
  const w = await world(t);
  const wide = JSON.stringify({ ...CONFIG, readers: [{ module: "connectors", paths: ["/v1.0/me/*"] }, { module: "sessions", paths: ["/v1.0/me/messages*"] }] });
  const versions = async () => ((await w.call("vault.history", { name: "ms" }, "cli")).data.versions || (await w.call("vault.history", { name: "ms" }, "cli")).data.history || []).length;
  const n = await versions();
  for (const who of ["mcp", "mcp:agent:kit", "module:connectors", "module:sessions", "module:watchers", "hook"]) {
    for (const [tool, input] of [
      ["vault.put", { name: "ms", kind: "api-credential", fields: { config: wide, secret: fake("s") } }],
      ["vault.put", { name: "ms", kind: "api-credential", fields: { secret: fake("s") } }],
      ["vault.update", { name: "ms", fields: { config: wide } }],
      ["vault.edit", { name: "ms", fields: { config: wide } }],
    ]) assert.ok((await w.call(tool, input, who)).error, `${who} ${tool}`);
  }
  assert.equal(await versions(), n, "no refused call wrote a version");
});

test("redteam RT-A1f: a model's or agent's own write through the credential is held, never run, and is never a reader's", async t => {
  const w = await world(t);
  for (const asCaller of [w.asModel, w.asAgent]) {
    const r = await asCaller({ method: "POST", url: w.url("/v1.0/me/sendMail"), body: { message: { subject: "hi", toRecipients: [{ emailAddress: { address: "dana@harlowlegal.com" } }] } } });
    assert.ok(r.data && r.data.held, JSON.stringify(r));
    assert.ok(!/ENOTFOUND|getaddrinfo/.test(JSON.stringify(r)), "it did not reach the network");
  }
  assert.ok(w.held() >= 2);
});

test("redteam RT-A1g: a reader does not outlive its credential: delete it and make another of the name, and connectors is refused", async t => {
  const w = await world(t);
  passedTheRule(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }));
  assert.ok((await w.call("vault.delete", { name: "ms" }, "cli")).data);
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }), /no item|not there|not granted|no such/i);
  // the same name, made again with no readers: nothing carried over
  assert.ok((await w.call("vault.put", { name: "ms", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: [HOST] }), secret: fake("s2") } }, "cli")).data);
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }), /not granted/);
});

test("redteam RT-A1h: replacing the key by a person keeps the readers; a module replacing it is refused", async t => {
  const w = await world(t);
  assert.ok((await w.call("vault.put", { name: "ms", kind: "api-credential", fields: { secret: fake("rotated") } }, "cli")).data);
  passedTheRule(await w.reader({ method: "GET", url: w.url("/v1.0/me/calendarView") }));
  refused(await w.reader({ method: "GET", url: w.url("/v1.0/me/messages") }), /may only read/);
  assert.ok((await w.call("vault.put", { name: "ms", kind: "api-credential", fields: { secret: fake("x") } }, "module:connectors")).error);
});

test("redteam RT-A1i: a reader cannot be pointed at another host or widened by the credential it reads", async t => {
  const w = await world(t);
  for (const u of ["https://elsewhere.example.test/v1.0/me/calendarView", `https://${HOST}.evil.example.test/v1.0/me/calendarView`, `https://user@${HOST}/v1.0/me/calendarView`, `http://${HOST}/v1.0/me/calendarView`]) {
    const r = await w.reader({ method: "GET", url: u });
    assert.ok(r.error, u);
  }
  assert.ok(!w.audit().includes(w.secret));
});
