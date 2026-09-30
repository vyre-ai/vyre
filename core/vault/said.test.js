// @ts-check
// said_intents (P17): what the person asked to go out, and the exact match the Gate runs before
// it holds. What these prove: the matcher is exact (kind, channel, every recipient, payee and
// amount), ambiguous names never match, only earlier and unrevoked intents count, and a standing
// intent crosses threads while a plain one stays in its lineage; the only writer is module:sessions
// or module:assistant and every other caller kind is refused by name; the person's tools list and
// revoke; and a row edited in vyre.db stops matching. Every name and address is a sample.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { open } from "../store/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { matchIntent, ambiguous, RECORDERS } from "./said.js";

const T0 = 1_800_000_000_000;
const intent = (o = {}) => ({ id: "s_1", thread: "t-1", kind: "send", channel: null, to: ["dana@harlowlegal.com"], standing: false, limits: null, at: T0, revoked: null, ...o });
const call1 = (o = {}) => ({ kind: "send", channel: "mail", via: "mail", to: ["dana@harlowlegal.com"], at: T0 + 1000, ...o });

test("matchIntent: kind, channel and every recipient must agree, an address compares without case", () => {
  assert.deepEqual(matchIntent(call1(), [intent()], ["t-1"]), { id: "s_1" });
  assert.deepEqual(matchIntent(call1({ to: ["Dana@HarlowLegal.com"] }), [intent()], ["t-1"]), { id: "s_1" });
  // A different recipient, or one extra recipient the person never named, is no match.
  assert.equal(matchIntent(call1({ to: ["sam@harlowlegal.com"] }), [intent()], ["t-1"]), null);
  assert.equal(matchIntent(call1({ to: ["dana@harlowlegal.com", "sam@harlowlegal.com"] }), [intent()], ["t-1"]), null);
  // The person named two; a call to one of them is covered.
  assert.deepEqual(matchIntent(call1({ to: ["sam@harlowlegal.com"] }), [intent({ to: ["dana@harlowlegal.com", "sam@harlowlegal.com"] })], ["t-1"]), { id: "s_1" });
  // A near-miss address is not the same address.
  assert.equal(matchIntent(call1({ to: ["dana@harlowlegal.co"] }), [intent()], ["t-1"]), null);
  assert.equal(matchIntent(call1({ to: ["dana@harlowlegal.com.evil.test"] }), [intent()], ["t-1"]), null);
  // Kind: a post is not a send, a spend is not a send.
  assert.equal(matchIntent(call1({ kind: "spend" }), [intent()], ["t-1"]), null);
  assert.equal(matchIntent(call1({ kind: "post" }), [intent()], ["t-1"]), null);
  assert.deepEqual(matchIntent(call1({ kind: "send" }), [intent({ kind: "post" })], ["t-1"]), { id: "s_1" }, "the Gate calls both a send");
  assert.equal(matchIntent(call1({ kind: "nonsense" }), [intent()], ["t-1"]), null);
  // No recipients at all covers nothing.
  assert.equal(matchIntent(call1({ to: [] }), [intent()], ["t-1"]), null);
  assert.equal(matchIntent(call1(), [intent({ to: [] })], ["t-1"]), null);
});

test("matchIntent: a channel the person named must be the call's", () => {
  assert.deepEqual(matchIntent(call1(), [intent({ channel: "mail" })], ["t-1"]), { id: "s_1" });
  assert.deepEqual(matchIntent(call1({ channel: undefined, via: "mcp:slack" }), [intent({ channel: "slack" })], ["t-1"]), { id: "s_1" });
  assert.equal(matchIntent(call1({ channel: "slack", via: "slack" }), [intent({ channel: "mail" })], ["t-1"]), null);
});

test("matchIntent: a bare name is ambiguous and never matches, not even itself", () => {
  assert.ok(ambiguous("Dana") && ambiguous("the Harlow team") && ambiguous("") && ambiguous(null));
  assert.ok(!ambiguous("dana@harlowlegal.com") && !ambiguous("#northwind") && !ambiguous("C0123ABC") && !ambiguous("+15550100"));
  assert.equal(matchIntent(call1({ to: ["Dana"] }), [intent({ to: ["Dana"] })], ["t-1"]), null);
  assert.equal(matchIntent(call1({ to: ["dana@harlowlegal.com"] }), [intent({ to: ["Dana"] })], ["t-1"]), null);
  assert.equal(matchIntent(call1({ to: ["Dana"] }), [intent()], ["t-1"]), null);
  // One ambiguous entry does not spoil an exact one beside it.
  assert.deepEqual(matchIntent(call1(), [intent({ to: ["Dana", "dana@harlowlegal.com"] })], ["t-1"]), { id: "s_1" });
});

test("matchIntent: only earlier, unrevoked intents in the lineage, or a standing one anywhere", () => {
  assert.equal(matchIntent(call1({ at: T0 - 1 }), [intent()], ["t-1"]), null, "said after the call");
  assert.deepEqual(matchIntent(call1({ at: T0 }), [intent()], ["t-1"]), { id: "s_1" }, "the same instant counts as before");
  assert.equal(matchIntent(call1(), [intent({ revoked: T0 + 5 })], ["t-1"]), null, "revoked");
  assert.equal(matchIntent(call1(), [intent()], ["t-2"]), null, "another thread");
  assert.equal(matchIntent(call1(), [intent()], []), null, "no lineage");
  assert.deepEqual(matchIntent(call1(), [intent()], ["t-9", "t-1"]), { id: "s_1" }, "an ancestor thread");
  assert.deepEqual(matchIntent(call1(), [intent({ standing: true })], ["t-2"]), { id: "s_1" }, "a standing one crosses threads");
  assert.equal(matchIntent(call1(), [intent({ standing: true, revoked: T0 + 1 })], ["t-2"]), null, "a revoked standing one");
  // The latest of several is the one named.
  assert.deepEqual(matchIntent(call1(), [intent({ id: "old", at: T0 - 50 }), intent({ id: "new", at: T0 - 10 }), intent({ id: "older", at: T0 - 90 })], ["t-1"]), { id: "new" });
});

test("matchIntent: a payment needs the payee exact and the amount inside the limits", () => {
  const pay = (o = {}) => intent({ kind: "pay", to: ["acct_1Northwind"], limits: { max_amount: 50, currency: "usd" }, ...o });
  const spend = (o = {}) => ({ kind: "spend", via: "vault-api", payee: "acct_1Northwind", amount: 42.5, currency: "usd", at: T0 + 1, ...o });
  assert.deepEqual(matchIntent(spend(), [pay()], ["t-1"]), { id: "s_1" });
  assert.deepEqual(matchIntent(spend({ amount: 50 }), [pay()], ["t-1"]), { id: "s_1" }, "the limit itself is inside it");
  assert.equal(matchIntent(spend({ amount: 50.01 }), [pay()], ["t-1"]), null);
  assert.equal(matchIntent(spend({ amount: -1 }), [pay()], ["t-1"]), null);
  assert.equal(matchIntent(spend({ amount: undefined }), [pay()], ["t-1"]), null, "no amount, no match");
  assert.equal(matchIntent(spend({ payee: "acct_1Other" }), [pay()], ["t-1"]), null);
  assert.equal(matchIntent(spend({ payee: undefined }), [pay()], ["t-1"]), null);
  assert.equal(matchIntent(spend({ currency: "eur" }), [pay()], ["t-1"]), null);
  assert.equal(matchIntent(spend(), [pay({ limits: null })], ["t-1"]), null, "no limit, no match");
  assert.equal(matchIntent(spend(), [intent({ to: ["acct_1Northwind"] })], ["t-1"]), null, "a send does not cover a spend");
});

// ---- the module, in a real vyred ----

async function daemon(t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  /** @type {(tool: string, input?: any, caller?: string, meta?: any) => Promise<any>} */
  const reg = (tool, input = {}, caller = "cli", meta = {}) => d.registry.call(tool, input, caller, meta);
  const as = caller => (tool, input = {}) => call(tool, input, { root, caller });
  return { root, d, reg, cli: as("cli"), local: as("local") };
}
const SAID = { thread: "t-1", said: "said-1", kind: "send", to: ["dana@harlowlegal.com"], what: "email Dana the form link" };

test("said: only sessions and the assistant record; every other caller kind is refused", async t => {
  const { reg, cli } = await daemon(t);
  assert.deepEqual(RECORDERS, ["module:sessions", "module:assistant", "module:threads"]);

  const refused = [
    ["mcp", "mcp", {}], ["an agent", "mcp:agent:juno", { thread: "t-1", agent: "juno" }], ["a session's thread", "mcp:thread:t-1", { thread: "t-1" }],
    ["a tailnet guest", "tailnet-guest:someone@else.test", {}], ["an agent's node", "tailnet:agent:juno", {}], ["the owner over the tailnet", "tailnet:alex@harlowlegal.com", {}],
    ["cli", "cli", {}], ["local", "local", {}], ["deck", "deck", {}], ["capsule", "capsule", {}], ["a webhook", "hook", {}], ["a stranger", "unknown", {}],
    ["the watcher runtime", "module:watchers", { watcher: "w1" }], ["the mcp hub", "module:mcp", {}], ["the gate", "module:gate", {}], ["the vault", "module:vault", {}],
    ["a lookalike", "module:sessions-evil", {}], ["a lookalike prefix", "module:assistants", {}],
  ];
  for (const [who, caller, meta] of refused) {
    const r = await reg("vault.said.record", SAID, caller, meta);
    assert.ok(r.error, `${who} (${caller}) must be refused`);
  }
  // Nothing got in.
  assert.deepEqual((await cli("gate.said.list", { all: true })).data.intents, []);

  const a = await reg("vault.said.record", SAID, "module:sessions");
  assert.match(a.data.id, /^s_/, JSON.stringify(a));
  const b = await reg("vault.said.record", { ...SAID, said: "said-2", thread: "t-2", kind: "post", channel: "slack", to: ["#northwind"], what: "post the update", standing: true }, "module:assistant");
  assert.match(b.data.id, /^s_/);
  const list = (await cli("gate.said.list")).data.intents;
  assert.deepEqual(list.map(x => [x.thread, x.kind, x.standing]), [["t-1", "send", false], ["t-2", "post", true]]);
  // The refusals are in the audit trail, with names and no words.
  const audit = (await reg("vault.audit", {}, "cli")).data.entries.filter(e => e.action === "said-record");
  assert.ok(audit.some(e => !e.ok && e.who === "module:watchers"));
  assert.ok(audit.some(e => e.ok && e.who === "module:sessions"));
});

test("said: input is checked", async t => {
  const { reg } = await daemon(t);
  const rec = i => reg("vault.said.record", { ...SAID, ...i }, "module:sessions");
  assert.ok((await rec({ kind: "delete" })).error, "a kind that is not an intent kind");
  assert.ok((await rec({ said: "" })).error, "no ingress row");
  assert.ok((await rec({ to: "dana@harlowlegal.com" })).error, "to is a list");
  assert.match((await rec({ kind: "pay", to: ["acct_1"] })).error.message, /max_amount/);
  assert.match((await rec({ kind: "pay", to: ["acct_1"], limits: { max_amount: -5 } })).error.message, /max_amount/);
  assert.ok((await rec({ kind: "pay", to: ["acct_1"], limits: { max_amount: 50, currency: "usd" } })).data.id);
});

test("said: match runs through the tool for modules only, and the person's list and revoke are person surfaces only", async t => {
  const { reg, cli, local } = await daemon(t);
  const { id } = (await reg("vault.said.record", SAID, "module:sessions")).data;
  const ask = (o = {}, caller = "module:gate") => reg("vault.said.match", { kind: "send", via: "mail", to: ["dana@harlowlegal.com"], thread: "t-1", ...o }, caller);
  assert.deepEqual((await ask()).data, { matched: true, id });
  assert.deepEqual((await ask({ to: ["sam@harlowlegal.com"] })).data, { matched: false });
  assert.deepEqual((await ask({ thread: "t-2" })).data, { matched: false }, "another thread");
  assert.deepEqual((await ask({ lineage: ["t-0", "t-1"], thread: "t-3" })).data, { matched: true, id }, "a lineage the module names");
  for (const caller of ["mcp", "cli", "tailnet-guest:x@y.test", "mcp:agent:juno"]) assert.ok((await ask({}, caller)).error, `${caller} cannot even ask`);

  // gate.said.*: a person's tools. No model, guest or agent node reaches them.
  for (const caller of ["mcp", "mcp:agent:juno", "tailnet-guest:x@y.test", "tailnet:agent:juno", "hook", "module:sessions", "module:mcp"]) {
    assert.ok((await reg("gate.said.list", {}, caller, caller === "mcp:agent:juno" ? { thread: "t-1", agent: "juno" } : {})).error, `${caller} cannot list`);
    assert.ok((await reg("gate.said.revoke", { id }, caller, caller === "mcp:agent:juno" ? { thread: "t-1", agent: "juno" } : {})).error, `${caller} cannot revoke`);
  }
  assert.equal((await ask()).data.matched, true, "nothing above revoked it");

  assert.equal((await cli("gate.said.list")).data.intents.length, 1);
  const r = await local("gate.said.revoke", { id });
  assert.equal(r.data.id, id, JSON.stringify(r));
  assert.ok(r.data.revoked > 0);
  assert.deepEqual((await ask()).data, { matched: false }, "revoked stops covering at once");
  assert.deepEqual((await cli("gate.said.list")).data.intents, []);
  assert.equal((await cli("gate.said.list", { all: true })).data.intents[0].revoked > 0, true);
  assert.equal((await cli("gate.said.revoke", { id })).data.id, id, "revoking twice is fine");
  assert.equal((await cli("gate.said.revoke", { id: "s_nothing" })).error.code, "not_found");
});

test("said: a row edited in vyre.db is ignored and audited", async t => {
  const { root, reg } = await daemon(t);
  const { id } = (await reg("vault.said.record", SAID, "module:sessions")).data;
  const ask = () => reg("vault.said.match", { kind: "send", via: "mail", to: ["sam@harlowlegal.com"], thread: "t-1" }, "module:gate");
  assert.equal((await ask()).data.matched, false);
  const db = open(path.join(root, "vyre.db"));
  try { db.prepare("UPDATE vault_said_intents SET recipients = ? WHERE id = ?").run(JSON.stringify(["sam@harlowlegal.com"]), id); } finally { db.close(); }
  assert.equal((await ask()).data.matched, false, "the edited row does not match, even the recipient it now names");
  const audit = (await reg("vault.audit", {}, "cli")).data.entries;
  assert.ok(audit.some(e => e.action === "tamper" && /vault_said_intents/.test(e.why)), JSON.stringify(audit));
  // Even the right recipient no longer matches: the whole row is gone until it is recorded again.
  assert.equal((await reg("vault.said.match", { kind: "send", via: "mail", to: ["dana@harlowlegal.com"], thread: "t-1" }, "module:gate")).data.matched, false);
});

test("matchIntent: a setting intent names the setting key in `to` and covers only a setting call", () => {
  const it = intent({ kind: "setting", to: ["morning.note"], standing: false });
  assert.deepEqual(matchIntent({ kind: "setting", to: ["morning.note"], at: T0 + 1000 }, [it], ["t-1"]), { id: "s_1" });
  assert.equal(matchIntent({ kind: "setting", to: ["chat.model"], at: T0 + 1000 }, [it], ["t-1"]), null);
  assert.equal(matchIntent({ kind: "send", to: ["morning.note"], at: T0 + 1000 }, [it], ["t-1"]), null);
});

test("matchIntent: a used plain ask is spent, a used standing one is not; agents narrow; pay needs currency on both sides", () => {
  assert.equal(matchIntent(call1(), [intent({ used: T0 + 5 })], ["t-1"]), null, "a plain ask is used up");
  assert.deepEqual(matchIntent(call1(), [intent({ used: T0 + 5, standing: true })], []), { id: "s_1" });
  const kit = intent({ standing: true, agents: ["kit"] });
  assert.deepEqual(matchIntent(call1({ agent: "Kit" }), [kit], []), { id: "s_1" });
  assert.equal(matchIntent(call1({ agent: "juno" }), [kit], []), null);
  assert.equal(matchIntent(call1(), [kit], []), null, "a call with no agent is not kit");
  const pay = intent({ kind: "pay", to: ["acct_1"], limits: { max_amount: 50, currency: "usd" } });
  const p = o => ({ kind: "pay", payee: "acct_1", amount: 10, at: T0 + 1000, ...o });
  assert.deepEqual(matchIntent(p({ currency: "USD" }), [pay], ["t-1"]), { id: "s_1" });
  assert.equal(matchIntent(p({}), [pay], ["t-1"]), null, "no currency on the call");
  assert.equal(matchIntent(p({ currency: "eur" }), [pay], ["t-1"]), null);
  assert.equal(matchIntent(p({ currency: "usd" }), [intent({ kind: "pay", to: ["acct_1"], limits: { max_amount: 50 } })], ["t-1"]), null, "no currency on the intent");
});

test("use: a # tag lets one thread and its descendants use an item by name; the item's hosts must not have grown; nothing is consumed", async t => {
  const { reg, cli } = await daemon(t);
  await cli("vault.put", { name: "GHLapikey", kind: "api-key", fields: { value: "fixture-key-1234567890" }, hosts: ["https://api.example.test"] });
  await cli("vault.put", { name: "kit-ssh", kind: "ssh-key", fields: { private: "-----BEGIN-----" } }).catch(() => {});
  // Pickers see names, kinds and hosts only.
  const names = (await cli("vault.items.names", { q: "ghl" })).data.items;
  assert.deepEqual(names, [{ name: "GHLapikey", kind: "api-key", hosts: ["https://api.example.test"] }]);
  assert.ok(!JSON.stringify(names).includes("fixture-key"), "never a value");
  assert.equal((await cli("vault.mention.search", { q: "ghl" })).data.items[0].id, "GHLapikey");
  assert.ok((await reg("vault.items.names", {}, "mcp")).error, "a model cannot list the picker");
  assert.ok((await reg("vault.mention.search", {}, "mcp:agent:juno", { agent: "juno", thread: "t-1" })).error);
  // Resolve: only sessions and the assistant.
  for (const who of ["mcp", "cli", "module:gate", "module:watchers"]) assert.ok((await reg("vault.mention.resolve", { id: "GHLapikey", thread: "t-1" }, who)).error, who);
  assert.equal((await reg("vault.mention.resolve", { id: "nope", thread: "t-1" }, "module:sessions")).error.code, "not_found");
  const r = (await reg("vault.mention.resolve", { id: "GHLapikey", thread: "t-1", said: "said-1" }, "module:sessions")).data;
  assert.deepEqual(r.grant, { use: true, hosts: ["https://api.example.test"] });
  assert.ok(!JSON.stringify(r).includes("fixture-key"));
  const check = (o, caller = "module:vault") => reg("vault.use.check", { item: "GHLapikey", thread: "t-1", hosts: ["https://api.example.test"], ...o }, caller);
  assert.ok((await reg("vault.use.check", { item: "GHLapikey", thread: "t-1" }, "module:vault")).error, "hosts are required (L-V1)");
  assert.match((await reg("vault.said.record", { thread: "t-1", said: "s", kind: "use", to: ["GHLapikey"], what: "use" }, "module:sessions")).error.message, /limits\.hosts/, "a use intent without hosts is refused (L-V2)");
  assert.equal((await check({})).data.allowed, true);
  assert.equal((await check({})).data.allowed, true, "not used up");
  assert.equal((await check({ thread: "t-2" })).data.allowed, false, "another thread");
  assert.equal((await check({ thread: "t-3", lineage: ["t-1"] })).data.allowed, true, "a thread under it");
  assert.equal((await check({ hosts: ["https://api.example.test", "https://evil.example.test"] })).data.allowed, false, "the item gained a host after the tag");
  assert.ok((await reg("vault.use.check", { item: "GHLapikey", thread: "t-1" }, "mcp")).error, "a model cannot ask");
  // Revocable, and used is a quiet event.
  const id = (await cli("gate.said.list")).data.intents.find(x => x.kind === "use").id;
  assert.equal((await cli("gate.said.revoke", { id })).data.id, id);
  assert.equal((await check({})).data.allowed, false);
});

test("act_out: the threads module records and resolves; a key with # @ and : is exact; a plain ask expires after its window", async t => {
  const { reg } = await daemon(t);
  // The switchboard's real caller label is module:threads.
  const rec = (o, caller = "module:threads") => reg("vault.said.record", { thread: "t-1", said: "said-1", kind: "act_out", channel: "github", to: ["github.project.pr.merge:alex/app#7"], what: "merge it", ...o }, caller);
  const a = await rec({});
  assert.match(a.data.id, /^s_/, JSON.stringify(a));
  const ask = (to, o = {}) => reg("vault.said.match", { kind: "act_out", via: "github", to: [to], thread: "t-1", ...o }, "module:vyred");
  assert.equal((await ask("github.project.pr.merge:alex/app#7")).data.matched, true, "# and @ and : are fine in a key");
  assert.equal((await ask("github.project.pr.merge:alex/app#40")).data.matched, false, "another PR is not covered");
  assert.equal((await ask("github.project.pr.merge:ALEX/app#7", { consume: true })).data.matched, true, "compared without case, and used up");
  assert.equal((await ask("github.project.pr.merge:alex/app#7")).data.matched, false, "a plain ask is single use");
  const open = await rec({ said: "said-2", to: ["github.project.pr.open:alex/app@feature-x"] });
  assert.ok(open.data.id);
  assert.equal((await ask("github.project.pr.open:alex/app@feature-x")).data.matched, true);
  // Expiry: 15 minutes by default, or the recorder's own window (1 to 60), never for a standing one.
  const at = Date.now();
  await rec({ said: "said-3", to: ["github.project.pr.review:alex/app#9"], at: at - 16 * 60_000 });
  assert.equal((await ask("github.project.pr.review:alex/app#9")).data.matched, false, "said 16 minutes ago");
  await rec({ said: "said-4", to: ["github.project.pr.review:alex/app#10"], at: at - 16 * 60_000, window_minutes: 30 });
  assert.equal((await ask("github.project.pr.review:alex/app#10")).data.matched, true, "the recorder's own window");
  await rec({ said: "said-5", to: ["github.project.pr.review:alex/app#11"], at: at - 500 * 60_000, window_minutes: 9999 });
  assert.equal((await ask("github.project.pr.review:alex/app#11")).data.matched, false, "the window is clamped to 60 minutes");
  assert.ok((await rec({ window_minutes: -1 })).error);
  await rec({ said: "said-6", to: ["github.project.pr.merge:alex/app#12"], at: at - 5000 * 60_000, standing: true });
  assert.equal((await ask("github.project.pr.merge:alex/app#12", { thread: "t-9" })).data.matched, true, "a standing one does not expire");
  // The threads module resolves # tags too (the real caller), and another module label still does not.
  assert.ok((await reg("vault.mention.resolve", { id: "nope", thread: "t-1" }, "module:threads")).error.code === "not_found");
  assert.match((await reg("vault.mention.resolve", { id: "nope", thread: "t-1" }, "module:watchers")).error.message, /only sessions and the assistant/);
});

test("grants: a named agent withdraws only its own pending request, lists only what is granted to it, and the approval prompt says who asked and for which project (M-V4, L-V3)", async t => {
  const { reg, cli } = await daemon(t);
  await cli("vault.put", { name: "api-a", kind: "api-key", fields: { value: "fixture-key-aaaaaaaaaaaa" }, hosts: ["https://a.example.test"] });
  await cli("vault.put", { name: "api-b", kind: "api-key", fields: { value: "fixture-key-bbbbbbbbbbbb" }, hosts: ["https://b.example.test"] });
  assert.equal((await cli("vault.grant", { name: "api-a", module: "planner" })).data.grant.status, "active");
  assert.equal((await cli("vault.grant", { name: "api-b", module: "kit" })).data.grant.status, "active");
  const kit = (tool, input) => reg(tool, input, "mcp:agent:kit", { agent: "kit", thread: "t-1" });
  // A named agent cannot take away an active grant, however it asks.
  assert.equal((await kit("vault.revoke", { name: "api-a", module: "planner" })).data.revoked, 0);
  assert.equal((await kit("vault.revoke", { name: "api-b", module: "kit" })).data.revoked, 0, "not even its own active grant");
  assert.equal((await reg("vault.revoke", { name: "api-a", module: "planner" }, "module:watchers")).data.revoked, 0, "another module cannot either");
  // It may withdraw a request it made.
  const asked = (await kit("vault.grant", { name: "api-a", module: "kit" })).data.grant;
  assert.equal(asked.status, "pending");
  assert.equal((await kit("vault.revoke", { name: "api-a", module: "kit" })).data.revoked, 1, "its own pending request");
  // The person, and an unnamed session, revoke freely.
  assert.equal((await reg("vault.revoke", { name: "api-a", module: "planner" }, "mcp")).data.revoked, 1);
  // List: a named agent sees names and kinds of what is granted to it, nothing else.
  assert.deepEqual((await kit("vault.list", {})).data.items, [{ name: "api-b", kind: "api-key" }]);
  assert.equal((await cli("vault.list")).data.items.length, 2, "the person sees everything");
});

test("said: a plain send, post or pay ask lives an hour by default, the recorder may shorten it, and the threads module records only use and act_out", async t => {
  const { reg } = await daemon(t);
  const at = Date.now();
  const rec = (o, caller = "module:sessions") => reg("vault.said.record", { thread: "t-1", said: "s", kind: "send", to: ["dana@harlowlegal.com"], what: "email Dana", ...o }, caller);
  const ask = (o = {}) => reg("vault.said.match", { kind: "send", via: "mail", to: ["dana@harlowlegal.com"], thread: "t-1", ...o }, "module:gate");
  await rec({ at: at - 61 * 60_000 });
  assert.equal((await ask()).data.matched, false, "said 61 minutes ago");
  await rec({ said: "s2", at: at - 30 * 60_000 });
  assert.equal((await ask()).data.matched, true, "said 30 minutes ago");
  await rec({ said: "s3", to: ["sam@harlowlegal.com"], at: at - 20 * 60_000, window_minutes: 10 });
  assert.equal((await ask({ to: ["sam@harlowlegal.com"] })).data.matched, false, "the recorder's shorter window");
  await rec({ said: "s4", to: ["kit@harlowlegal.com"], at: at - 5000 * 60_000, standing: true }, "module:assistant");
  assert.equal((await ask({ to: ["kit@harlowlegal.com"], thread: "t-9" })).data.matched, true, "a standing one never lapses");
  // module:threads: use and act_out only.
  assert.match((await rec({ kind: "send" }, "module:threads")).error.message, /only use and act_out/);
  assert.match((await rec({ kind: "pay", to: ["acct_1"], limits: { max_amount: 5, currency: "usd" } }, "module:threads")).error.message, /only use and act_out/);
  assert.ok((await rec({ kind: "act_out", to: ["github.project.pr.merge:alex/app#7"], channel: "github" }, "module:threads")).data.id);
  for (const lookalike of ["module:threads-evil", "module:threadsx"]) assert.ok((await rec({}, lookalike)).error, lookalike);
});

test("grants: vault.list decides 'granted to that agent' by the agent's project scope or a grant to a module of its own name", async t => {
  const { reg, cli } = await daemon(t);
  for (const n of ["api-p", "api-m", "api-x"]) await cli("vault.put", { name: n, kind: "api-key", fields: { value: `fixture-key-${n}-0000000000` } });
  await cli("vault.grant", { name: "api-p", module: "planner", project: "harlow" });
  await cli("vault.grant", { name: "api-m", module: "kit" });
  await cli("vault.grant", { name: "api-x", module: "planner", project: "northwind" });
  const list = (agent, meta = {}) => reg("vault.list", {}, `mcp:agent:${agent}`, { agent, ...meta }).then(r => r.data.items.map(i => i.name).sort());
  assert.deepEqual(await list("kit", { project: "harlow" }), ["api-m", "api-p"], "its project's grant and the one to a module named kit, not another project's");
  assert.deepEqual(await list("kit"), ["api-m"], "with no project scope only the grant to its own name counts");
  assert.deepEqual(await list("juno", { project: "northwind" }), ["api-x"]);
  assert.deepEqual(await list("juno"), [], "nothing is visible to an agent with no grant and no project");
});
