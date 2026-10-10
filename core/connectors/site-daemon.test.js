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
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "local", modules: { disable: ["hands"] }, vault: { keystore: "file" }, chrome: { sockPath, extensionOrigin: null } }));
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
  t.after(() => { x.sock.destroy(); });
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
  t.after(() => { x.sock.destroy(); });
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

test("R031-79: a login that ran out is one Needs-you card that says what to do, re-checks on its answer, and closes by itself when the site answers again", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  let loggedIn = false;
  const x = await extension(w.sockPath, { "ops.call": (/** @type {any} */ a) => (loggedIn ? { ok: true, class: "ok", data: [{ name: "alpha one" }], op: a.op.name, status: 200 } : { ok: false, class: "auth", reason: "HTTP 401", next: "sign in again" }) });
  t.after(() => { x.sock.destroy(); });
  await online(w.d);
  const cards = async () => ((await w.cli("approvals.items")).data || {}).items.filter((/** @type {any} */ c) => c.kind === "signin");
  assert.deepEqual(await cards(), [], "nothing is wrong yet: no card");
  const out = await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  assert.equal(out.data && out.data.status, 401, JSON.stringify(out));
  // the Connection says what is wrong, and the list for Needs you has it
  const att = (await w.cli("connectors.site.attention")).data.sites;
  assert.equal(att.length, 1);
  assert.deepEqual([att[0].id, att[0].host, att[0].class], ["linkedin", "app.example.com", "auth"]);
  const open = await cards();
  assert.equal(open.length, 1, JSON.stringify(open));
  assert.equal(open[0].id, "connectors:linkedin");
  assert.equal(open[0].title, "Sign in to app.example.com again");
  assert.match(open[0].detail, /sign in to app\.example\.com again/);
  assert.deepEqual(open[0].answer, { tool: "connectors.connection.check", input: { id: "linkedin" }, fill: [] });
  assert.deepEqual(open[0].answers.map((/** @type {any} */ a) => a.label), ["Check it now"], "a Mac's own Chrome has no screen of ours to open");
  assert.ok(!JSON.stringify(open).includes(F.SECRET_COOKIE) && !JSON.stringify(open).includes(F.CSRF), "no cookie and no token on a card");
  assert.equal((await w.cli("waiting.count")).data.by_kind.signin, 1, "and the one list counts it");
  // still signed out: checking does not clear it
  assert.equal((await w.cli("connectors.connection.check", { id: "linkedin" })).data.light === "green" ? "green" : "red", "red", "the card's answer re-checks and it is still red");
  assert.equal((await cards()).length, 1);
  // the person signs in, the Connection works again: the card closes with its outcome
  loggedIn = true;
  const again = await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: "gamma labs" } } });
  assert.equal(again.data && again.data.status, 200, JSON.stringify(again));
  assert.deepEqual(await cards(), []);
  const done = ((await w.cli("approvals.items")).data || {}).recent.filter((/** @type {any} */ c) => c.kind === "signin");
  assert.equal(done.length, 1);
  assert.equal(done[0].outcome, "signed in");
  assert.deepEqual((await w.cli("connectors.site.attention")).data.sites, []);
});

test("the Capsule's Websites and Website operations views list the Connections and their operations, with the light and a rollback, through the existing views engine", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  const view = async (/** @type {string} */ command, extra = {}) => { const r = await w.d.registry.call("capsule.view", { module: "connectors", command, ...extra }, "capsule"); return r.data || { kind: "error", code: r.error && r.error.code, message: r.error && r.error.message }; };
  const sites = await view("sites");
  assert.equal(sites.kind, "list", JSON.stringify(sites));
  assert.deepEqual(sites.rows.map((/** @type {any} */ r) => [r.id, r.title, r.accessory]), [["linkedin", "LinkedIn", "unknown"]]);
  assert.match(sites.rows[0].subtitle, /app\.example\.com/);
  const detail = await view("sites", { view: "detail", id: "linkedin" });
  assert.equal(detail.kind, "detail", JSON.stringify(detail));
  assert.ok(detail.fields.some((/** @type {any} */ f) => f.label === "Site" && f.value === ORIGIN));
  const rows = await view("site-operations");
  assert.equal(rows.kind, "list", JSON.stringify(rows));
  assert.deepEqual(rows.rows.map((/** @type {any} */ r) => [r.id, r.title, r.accessory]).sort(), [["linkedin:searchPeople", "searchPeople", "ok"], ["linkedin:sendMessage", "sendMessage", "ok"]]);
  assert.ok(rows.rows.every((/** @type {any} */ r) => r.actions === undefined || Array.isArray(r.actions)));
  // a rollback by row with no earlier version says so plainly, and a model cannot make one
  const none = await w.cli("connectors.site.rollback", { row: "linkedin:searchPeople" });
  assert.equal(none.error?.code, "not_found");
  assert.equal((await w.model("connectors.site.rollback", { row: "linkedin:searchPeople" })).error?.code, "denied");
  // teach a better version; the Connection is brought up to date and the row can go back
  const v2 = read(); v2.response.extract = "items";
  await w.cli("memory.site.put", { origin: ORIGIN, target: "origin", patch: { key: ORIGIN, ops: [{ name: "searchPeople", kind: "read", op: v2, outcome: "ok" }] } });
  assert.deepEqual((await w.cli("connectors.site.sync", { id: "linkedin" })).data, { id: "linkedin", credential: "conn-linkedin", operations: 2 });
  const after = (await w.cli("connectors.site.operations", { id: "linkedin" })).data.operations.find((/** @type {any} */ o) => o.name === "searchPeople");
  assert.deepEqual([after.version, after.history.map((/** @type {any} */ h) => h.version)], [2, [1]]);
  const back = await w.cli("connectors.site.rollback", { row: "linkedin:searchPeople" });
  assert.deepEqual(back.data, { rolledBack: true, name: "searchPeople", version: 3 }, JSON.stringify(back));
});

test("an assistant proposes a website Connection; nothing is made until the person reads the card and says yes", async t => {
  const w = await world(t);
  const prop = await w.model("connectors.site.propose", { site: ORIGIN, label: "LinkedIn", why: "to read profiles for the intake Flow" });
  assert.ok(prop.data && prop.data.proposal, JSON.stringify(prop));
  assert.equal(prop.data.card.title, "Connect LinkedIn?");
  assert.ok(prop.data.card.lines.some((/** @type {string} */ l) => /sendMessage\(recipient, text\): sends from app\.example\.com/.test(l)), prop.data.card.lines.join("\n"));
  assert.ok(prop.data.card.lines.some((/** @type {string} */ l) => /login stays in the browser/.test(l)));
  assert.equal((await w.model("connectors.connection.list")).data.connections.length, 0, "proposing made nothing");
  assert.equal((await w.model("connectors.connection.proposals")).error?.code, "denied");
  assert.equal((await w.model("connectors.connection.approve", { proposal: prop.data.proposal })).error?.code, "denied");
  const mine = (await w.cli("connectors.connection.proposals")).data.proposals;
  assert.equal(mine.length, 1); assert.equal(mine[0].form.site, ORIGIN);
  assert.deepEqual((await w.cli("connectors.connection.approve", { proposal: prop.data.proposal })).data, { id: "linkedin", credential: "conn-linkedin", operations: 2 });
  assert.equal((await w.model("connectors.connection.list")).data.connections[0].transport, "site");
  assert.equal((await w.model("connectors.site.propose", { site: "https://nothing-taught.example.com", label: "Empty" })).error?.code, "not_found");
});

test("an account's limits are a person's setting: read by anyone, set and resumed only by the person, and a call counts against the day", async t => {
  const w = await world(t);
  await w.cli("connectors.site.connect", { site: ORIGIN, label: "LinkedIn" });
  assert.deepEqual((await w.model("connectors.site.limits", { id: "linkedin" })).data, { id: "linkedin", settings: null }, "a site nobody watches is not governed by default");
  assert.equal((await w.model("connectors.site.limits.set", { id: "linkedin", settings: { reads_per_day: 5 } })).error?.code, "denied");
  assert.equal((await w.model("connectors.site.resume", { id: "linkedin" })).error?.code, "denied");
  const set = await w.cli("connectors.site.limits.set", { id: "linkedin", settings: { reads_per_day: 5, writes_per_day: 2, gap_read_s: [0, 0], quiet: null, tz: "UTC" } });
  assert.equal(set.data.settings.reads_per_day, 5, JSON.stringify(set));
  seen = [];
  const x = await extension(w.sockPath);
  t.after(() => { x.sock.destroy(); });
  await online(w.d);
  for (let i = 0; i < 2; i++) assert.equal((await w.cli("connectors.operation.run", { connection: "linkedin", operation: "search_people", input: { query: { query: `gamma labs ${i}` } } })).data.status, 200);
  const lim = (await w.model("connectors.site.limits", { id: "linkedin" })).data;
  assert.deepEqual([lim.usage.reads, lim.usage.writes, lim.usage.stopped], [2, 0, false]);
  assert.equal((await w.cli("connectors.site.resume", { id: "linkedin" })).data.resumed, false, "nothing was stopped");
  assert.equal((await w.cli("connectors.site.limits.set", { id: "linkedin", settings: null })).data.settings, null, "back to the default");
});
