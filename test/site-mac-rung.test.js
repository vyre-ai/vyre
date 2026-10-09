// @ts-check
// Rung "mac": a box asks the person's own Chrome on a paired Mac to run a learned website operation, through the link. Only an operation the person allowed for the box there; a read runs at once;
// an outward one only with the box's signed assertion for exactly that call; with the Mac off the call says it needs the person's Chrome. Two real vyreds (test/link-harness.js), a fake extension.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { until, pair } from "./link-harness.js";
import { fakeExtension } from "../local/hands-chrome-mac/fake-extension.js";
import { learnOperation } from "../lib/siteops/learn.js";
import * as F from "../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;
const ENTRIES = () => [{ name: "searchPeople", kind: "read", op: read() }, { name: "sendMessage", kind: "send", op: send() }];

async function world(/** @type {any} */ t) {
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-rung-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  const s = await pair(t, { macConfig: { modules: { disable: ["hands"] }, chrome: { sockPath, extensionOrigin: null } } });
  await until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && m[0].online && m; });
  // what was learned is on both machines' records (each keeps its own); the box makes the Connection
  for (const call of [s.macCall, s.boxCall]) {
    const r = await call("memory.site.put", { origin: ORIGIN, target: "origin", patch: { key: ORIGIN, ops: ENTRIES() } });
    assert.equal(r.data && r.data.accepted, true, JSON.stringify(r));
  }
  /** @type {any[]} */ const seen = [];
  const x = await fakeExtension(sockPath, { handler: (op, args, frame) => {
    seen.push({ op, args, trust: frame && frame.trust });
    if (op === "tabs.use") return { tab: { id: 1, url: `${ORIGIN}/feed`, title: "Feed" } };
    if (op === "ops.call") return { ok: true, class: "ok", data: [{ name: `${args.inputs.query || "x"} one` }], op: args.op.name, status: 200 };
    return { ok: true };
  } });
  t.after(() => { x.sock.destroy(); });
  await until(async () => (await s.macCall("chrome.status")).data.connected);
  const made = await s.boxCall("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  assert.ok(made.data, JSON.stringify(made));
  return { ...s, seen, x };
}
const run = (/** @type {any} */ s, input = { query: { query: "gamma labs" } }) => s.boxCall("connectors.operation.run", { connection: "linkedin", operation: "search_people", input });

test("a box's read runs in the Mac's own Chrome once the person allowed that operation for the box there; nothing the person did not allow runs", { timeout: 120_000 }, async t => {
  const s = await world(t);
  // not allowed yet: the Mac refuses, whatever the box asks, and the answer says why
  const before = await run(s);
  assert.equal(s.seen.filter(x => x.op === "ops.call").length, 0);
  assert.ok(before.error || before.data.status >= 400, JSON.stringify(before));
  assert.match(JSON.stringify(before), /has not allowed the box|link\.ops\.allow/);
  // the person allows it on the Mac
  assert.equal((await s.macCall("link.ops.allow", { site: ORIGIN, name: "searchPeople" })).data.allowed, true);
  assert.deepEqual((await s.macCall("link.ops.list")).data.operations, [{ site: ORIGIN, name: "searchPeople" }]);
  const out = await run(s);
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.data.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.body, [{ name: "gamma labs one" }]);
  const call = s.seen.find(x => x.op === "ops.call");
  assert.equal(call.args.op.name, "searchPeople");
  assert.notEqual(call.trust && call.trust.asked, true, "a read needs no yes");
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify([out, s.seen]).includes(raw), `leaked ${raw}`);
  // an operation the person did not allow (the send) is refused on the Mac even though the box asks for it
  const asked = await s.boxCall("link.macs.call", { tool: "chrome.op.call", input: { site: ORIGIN, name: "sendMessage", inputs: { recipient: "alan-turing", text: "a fresh note" } } }, "module:connectors");
  assert.equal(asked.data[0].ok, false); assert.equal(asked.data[0].error.code, "denied");
  // revoking stops it at once
  assert.equal((await s.macCall("link.ops.revoke", { site: ORIGIN, name: "searchPeople" })).data.revoked, true);
  const after = await run(s);
  assert.ok(after.error || after.data.status >= 400, "revoked: the box's read no longer runs");
});

test("an outward operation runs on the Mac only with the box's signed assertion for exactly that call, from the connectors module alone, and once", { timeout: 120_000 }, async t => {
  const s = await world(t);
  await s.macCall("link.ops.allow", { site: ORIGIN, name: "sendMessage" });
  const call = { tool: "chrome.op.call", input: { site: ORIGIN, name: "sendMessage", inputs: { recipient: "alan-turing", text: "a fresh note" }, approved: true } };
  // only the connectors module may ask for an approved call; any other module, a model or the person's label is refused on the box
  for (const caller of ["module:flows", "mcp", "deck"]) assert.ok((await s.boxCall("link.macs.call", call, caller)).error, `${caller} may not ask for an approved outward call`);
  s.seen.length = 0;
  const ok = await s.boxCall("link.macs.call", call, "module:connectors");
  assert.equal(ok.data[0].ok, true, JSON.stringify(ok));
  const sent = s.seen.find(x => x.op === "ops.call");
  assert.ok(sent, JSON.stringify(s.seen.map(x => x.op)));
  assert.equal(sent.trust && sent.trust.asked, true, "the yes was given on the box and signed for this call");
  assert.deepEqual(sent.args.inputs, { recipient: "alan-turing", text: "a fresh note" });
  // without the approval flag the same call is held, as any send is, and never runs here
  s.seen.length = 0;
  await s.boxCall("link.macs.call", { tool: "chrome.op.call", input: { ...call.input, approved: false } }, "module:connectors");
  assert.ok(!s.seen.some(x => x.op === "ops.call" && x.trust && x.trust.asked === true));
});

test("with the Mac off the box says it needs the person's Chrome, plainly, and the Connection's light and an event say so", { timeout: 120_000 }, async t => {
  const s = await world(t);
  await s.macCall("link.ops.allow", { site: ORIGIN, name: "searchPeople" });
  await s.stopTailnet();
  await until(async () => { const m = (await s.boxCall("link.macs")).data; return m.length === 1 && !m[0].online; });
  const out = await run(s);
  assert.ok(out.error || out.data.status >= 400, JSON.stringify(out));
  assert.match(JSON.stringify(out), /needs your Chrome|offline|not answering/);
  const got = (await s.boxCall("connectors.connection.get", { id: "linkedin" })).data;
  assert.equal(got.light, "red");
  assert.match(got.reason, /needs your Chrome/);
  assert.ok(s.box.registry.deps.events.since(0, { limit: 5000 }).some((/** @type {any} */ e) => e.type === "connectors.site-needs-browser" && e.payload.id === "linkedin"));
});
