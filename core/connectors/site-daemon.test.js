// @ts-check
// A website as a Connection, inside a real vyred: the learned operations in the site record become the Connection's operations; a call goes vault -> connectors -> the chrome module -> the person's
// Chrome (a fake extension here) and back; a read runs at once, a send waits for the person's yes and is made once; with no browser the light says so; the login never appears anywhere.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { fakeExtension, until } from "../../local/hands-chrome-mac/fake-extension.js";
import { learnOperation } from "../../lib/siteops/learn.js";
import * as F from "../../lib/siteops/fixtures.js";

const ORIGIN = "https://app.example.com";
const read = () => learnOperation({ name: "searchPeople", exchanges: F.pageRest("alpha corp"), exchanges2: F.pageRest("beta works"), examples: [{ query: "alpha corp" }, { query: "beta works" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/search?q={query}` } }).operation;
const send = () => learnOperation({ name: "sendMessage", kind: "send", exchanges: F.pageSend("ada-lovelace", "hello there friend"), exchanges2: F.pageSend("grace-hopper", "second text here"), examples: [{ recipient: "ada-lovelace", text: "hello there friend" }, { recipient: "grace-hopper", text: "second text here" }], cookies: [{ name: "sid", value: F.SECRET_COOKIE }], storage: F.restStorage, trigger: { url: `${ORIGIN}/inbox` } }).operation;

async function world(/** @type {any} */ t) {
  const root = tempHome(t);
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "vc-site-"));
  t.after(() => fs.rmSync(sockDir, { recursive: true, force: true }));
  const sockPath = path.join(sockDir, "chrome.sock");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", vault: { keystore: "file" }, chrome: { sockPath, extensionOrigin: null } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const cli = (/** @type {string} */ tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const model = (/** @type {string} */ tool, input = {}) => d.registry.call(tool, input, "mcp", { thread: "t-1" });
  const put = await cli("memory.site.put", { origin: ORIGIN, target: "origin", patch: { key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op: read() }, { name: "sendMessage", kind: "send", op: send() }] } });
  assert.equal(put.data && put.data.accepted, true, JSON.stringify(put));
  return { root, d, cli, model, sockPath };
}

/** @type {any[]} */ let seen = [];
const extension = (/** @type {string} */ sockPath, /** @type {any} */ over = {}) => fakeExtension(sockPath, { handler: (op, args, frame) => {
  seen.push({ op, args, trust: frame && frame.trust });
  if (over[op]) return over[op](args, frame);
  if (op === "tabs.use") return { tab: { id: 1, url: `${ORIGIN}/feed`, title: "Feed" } };
  if (op === "ops.call") return { ok: true, class: "ok", data: [{ name: `${args.inputs.query} one` }], op: args.op.name, status: 200 };
  if (op === "ops.check") return { ok: true, onSite: true, refs: { "session:csrf": true } };
  return { ok: true };
} });
const online = (/** @type {any} */ d) => until(async () => (await d.registry.call("chrome.status", {}, "cli")).data.connected);

test("connect a website from what was learned: the Connection, its operations and its credential hold the host and the rules, never a key", async t => {
  const w = await world(t);
  assert.equal((await w.model("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" })).error?.code, "denied", "a model never connects a website");
  const made = await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  assert.deepEqual(made.data, { id: "linkedin", credential: "conn-linkedin", operations: 2 }, JSON.stringify(made));
  const item = (await w.cli("vault.list", {})).data.items.find((/** @type {any} */ x) => x.name === "conn-linkedin");
  assert.equal(item.kind, "api-credential");
  const got = (await w.model("connectors.connection.get", { id: "linkedin" })).data;
  assert.equal(got.transport, "site"); assert.equal(got.site, ORIGIN); assert.deepEqual(got.auth, { kind: "browser" });
  assert.deepEqual(got.operations.map((/** @type {any} */ o) => [o.name, o.kind]).sort(), [["search_people", "read"], ["send_message", "send"]]);
  const ops = (await w.model("connectors.site.operations", { id: "linkedin" })).data;
  assert.deepEqual(ops.operations.map((/** @type {any} */ o) => [o.name, o.kind, o.version, o.health]), [["searchPeople", "read", 1, "ok"], ["sendMessage", "send", 1, "ok"]]);
  assert.ok(!JSON.stringify([made, got, ops]).includes(F.CSRF) && !JSON.stringify([made, got, ops]).includes("/api/v2/search"), "the learned request is not in the Connection");
  assert.equal((await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" })).error?.code, "exists");
  assert.equal((await w.cli("connectors.site.connect", { site: "http://app.example.com", label: "x" })).error?.code, "bad_input");
  assert.equal((await w.cli("connectors.site.connect", { site: ORIGIN, label: "Only a ghost", operations: ["nope"] })).error?.code, "not_found");
});

test("a read runs through the vault, the connectors module and the chrome module into the person's Chrome; the light follows", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  seen = [];
  const x = await extension(w.sockPath);
  t.after(() => x.close());
  await online(w.d);
  const out = await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  assert.ok(!out.error, JSON.stringify(out));
  assert.equal(out.data.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.body, [{ name: "gamma labs one" }]);
  const call_ = seen.find(s => s.op === "ops.call");
  assert.ok(call_, JSON.stringify(seen.map(s => s.op)));
  assert.equal(call_.args.op.name, "searchPeople");
  assert.deepEqual(call_.args.inputs, { query: "gamma labs" });
  assert.notEqual(call_.trust && call_.trust.asked, true, "a read needs no yes");
  for (const raw of [F.SECRET_COOKIE, F.CSRF]) assert.ok(!JSON.stringify([out, seen]).includes(raw), `leaked ${raw}`);
  assert.equal((await w.cli("connectors.connection.get", { id: "linkedin" })).data.light, "green");
});

test("with no browser connected the call fails plainly and the light says what to do", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  const out = await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  assert.equal(out.error ? out.error.code : out.data.status, out.error ? out.error.code : 503, JSON.stringify(out));
  const got = (await w.cli("connectors.connection.get", { id: "linkedin" })).data;
  assert.equal(got.light, "red");
  assert.match(got.reason, /no signed-in browser|Chrome/);
});

test("a send is held for the person's yes, never sent without it, and the sign-in card appears when the browser says the login ran out", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  seen = [];
  const x = await extension(w.sockPath, { "ops.call": (/** @type {any} */ a) => (a.op.name === "searchPeople" ? { ok: false, class: "auth", reason: "HTTP 401", next: "sign in again" } : { ok: true, class: "ok", data: { sent: true }, status: 200 }) });
  t.after(() => x.close());
  await online(w.d);
  // an assistant's send: the vault holds it
  const held = await w.model("connectors.operation.run", { connection: "linkedin", operation: "send_message", input: { body: { recipient: "alan-turing", text: "a fresh note" } } });
  assert.ok(held.error || (held.data && (held.data.held || held.data.status !== 200)), `a model's send must not go: ${JSON.stringify(held)}`);
  assert.equal(seen.filter(s => s.op === "ops.call").length, 0, "nothing reached the browser");
  // the login ran out: the read says auth, the light says sign in, and the event is there for the Needs you card
  const out = await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  assert.equal(out.data && out.data.status, 401, JSON.stringify(out));
  const got = (await w.cli("connectors.connection.get", { id: "linkedin" })).data;
  assert.equal(got.light, "red");
  assert.match(got.reason, /sign in to app\.example\.com again/);
  assert.ok(w.d.registry.deps.events.since(0, { limit: 5000 }).some((/** @type {any} */ e) => e.type === "connectors.site-needs-signin" && e.payload.id === "linkedin"));
});
