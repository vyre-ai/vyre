// @ts-check
// A member's own API credential, lent to the chat's agent for one turn: the agent calls it through vault.request and never sees the key; the call goes only to the credential's own hosts (a redirect or another host is
// refused); the lend is held to that chat's thread and ends with the turn; another agent or another chat gets nothing; the owner's credentials are never reachable this way; anything outward still waits at the Gate.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { Vault, MIGRATIONS } from "./vault.js";
import { Access } from "./access.js";
import { register } from "./request.js";
import { PeopleVaults } from "./people.js";
import { MemberCredential } from "./member-credential.js";
import { kernelRig } from "./kernel-rig.js";
import { TEST_KDF } from "./testing.js";
import { SCRATCH } from "../../test/scratch.mjs";

const BOB = "per_bob", PW = "a long master password";
const json = (status, body, headers = {}) => ({ status, headers: { "content-type": "application/json", ...headers }, body: Buffer.from(JSON.stringify(body)) });
const KEY = `fixture-bobkey-${crypto.randomBytes(8).toString("hex")}`;
const CONFIG = { auth: { type: "bearer" }, hosts: ["api.bobs.example.test"] };

async function mk(/** @type {import("node:test").TestContext} */ t, transportFor = () => json(200, { ok: true })) {
  const home = fs.mkdtempSync(path.join(SCRATCH, "vyre-memcred-"));
  const db = open(path.join(home, "vyre.db"));
  migrate(db, "vault", MIGRATIONS);
  /** Who asked the turn now running on a chat (the Switchboard's threads.turn-asker), set by a test. */
  const askers = new Map([["chat-1", BOB], ["chat-2", BOB]]);
  const rig = await kernelRig({ people: [BOB, "per_cy"], agents: { kit: "agt_kit", juno: "agt_juno", assistant: "agt_asst" }, call: (/** @type {string} */ tool, /** @type {any} */ i) => (tool === "threads.turn-asker" ? { data: { asker: askers.get(i.thread) || null } } : undefined) });
  const v = new Vault({ db, dir: path.join(home, "vault"), config: { name: "box", vault: { keystore: "file" } }, emit: () => {}, log: () => {}, clock: rig.clock });
  v.access = new Access(v, rig.ctx);
  const people = new PeopleVaults({ dir: path.join(home, "vault-people"), sealRoot: home, testKdf: TEST_KDF });
  t.after(() => { people.close(); db.close(); fs.rmSync(home, { recursive: true, force: true }); });
  await people.create(BOB, { password: PW });
  await people.put(BOB, { name: "bobs-api", kind: "api-credential", fields: { config: JSON.stringify(CONFIG), secret: KEY } });
  await v.put({ name: "owner-api", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "bearer" }, hosts: ["api.owner.example.test"] }), secret: "OWNER-SECRET-0001" } }, "cli");
  const lentCreds = new MemberCredential(v.access, people);
  const net = { calls: /** @type {any[]} */ ([]) };
  const gate = { items: new Map() };
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool === "gate.offer") return { data: { name: input.name } };
    if (tool === "gate.request") { const id = `h${gate.items.size + 1}`; gate.items.set(id, { id, input }); return { data: { id, state: "held", message: `Held as ${id}` } }; }
    return { error: { code: "no_such_tool", message: tool } };
  };
  const tools = new Map();
  register({ vault: v, tool: (name, _c, _d, _i, run) => tools.set(name, { run }), internal: (n, _d, _i, run) => tools.set(n, { run }), call, said: { match: async () => null },
    deps: { lentCreds, lookup: async () => [{ address: "93.184.216.10", family: 4 }], transport: async (/** @type {any} */ r) => { net.calls.push({ host: r.url.hostname, method: r.method, authorization: r.headers && r.headers.authorization }); return transportFor(r); } } });
  const as = (/** @type {string} */ agent, /** @type {string} */ thread, /** @type {any} */ input) => tools.get("vault.request").run(input, { caller: `mcp:agent:${agent}`, agent, thread });
  const GET = { method: "GET", url: "https://api.bobs.example.test/v1/a" };
  return { v, people, lentCreds, net, gate, as, GET, rig, askers, now: () => rig.clock() };
}

const LEND = (/** @type {any} */ o = {}) => ({ item: "bobs-api", agent: "kit", thread: "chat-1", ...o });

test("the agent uses her key through Vyre for that chat only: the key is added at the Vault's home, goes to its own host only, and is never in what the agent gets back", async t => {
  const { lentCreds, as, net, GET, now } = await mk(t);
  const lent = await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  assert.match(lent.credential, /^lent-/);
  const r = await as("kit", "chat-1", { credential: lent.credential, ...GET });
  assert.equal(r.kind, "read"); assert.equal(net.calls.length, 1);
  assert.equal(net.calls[0].host, "api.bobs.example.test"); assert.equal(net.calls[0].authorization, `Bearer ${KEY}`, "added at the home");
  assert.ok(!JSON.stringify(r).includes(KEY), "never in the agent's answer");
  await assert.rejects(as("kit", "chat-1", { credential: lent.credential, method: "GET", url: "https://evil.example.test/steal" }), /host|allowed|refused/i, "another host is refused");
  assert.equal(net.calls.length, 1, "and nothing went to it");
});

test("a redirect to another host is refused and the key does not follow it", async t => {
  const { lentCreds, as, net, GET, now } = await mk(t, r => (r.url.hostname === "api.bobs.example.test" ? json(302, {}, { location: "https://evil.example.test/x" }) : json(200, {})));
  const lent = await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  await as("kit", "chat-1", { credential: lent.credential, ...GET }).catch(() => {});
  assert.ok(net.calls.every(c => c.host === "api.bobs.example.test"), "no request left for the other host");
});

test("another agent, another chat, the default assistant and an unlent name get nothing", async t => {
  const { lentCreds, as, net, GET, now } = await mk(t);
  const lent = await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  await assert.rejects(as("juno", "chat-1", { credential: lent.credential, ...GET }), { code: "denied" }, "another agent in the same chat");
  await assert.rejects(as("kit", "chat-2", { credential: lent.credential, ...GET }), { code: "denied" }, "the same agent in another chat");
  await assert.rejects(as("assistant", "chat-1", { credential: lent.credential, ...GET }), { code: "denied" });
  await assert.rejects(as("kit", "chat-1", { credential: "lent-0000000000000000", ...GET }), /not|no /i);
  assert.equal(net.calls.length, 0);
});

test("the owner's credentials are never reachable this way, and the owner is not served a lend", async t => {
  const { lentCreds, as, net, now } = await mk(t);
  await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  await assert.rejects(as("kit", "chat-1", { credential: "owner-api", method: "GET", url: "https://api.owner.example.test/v1" }), { code: "denied" }, "kit holds no grant on the owner's key");
  assert.equal(await lentCreds.credential("owner-api"), null, "the lent store knows only its own names");
  await assert.rejects(lentCreds.lend("per_owner", LEND({ expires: now() + 600_000 })), { code: "denied" });
  assert.equal(net.calls.length, 0);
});

test("the lend ends with the turn: the next call is refused, the copy is gone; another chat's lend is not touched", async t => {
  const { lentCreds, people, as, GET, now } = await mk(t);
  const a = await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  const b = await lentCreds.lend(BOB, LEND({ thread: "chat-2", expires: now() + 600_000 }));
  assert.equal(await lentCreds.endFor(BOB, "chat-1"), 1);
  await assert.rejects(as("kit", "chat-1", { credential: a.credential, ...GET }), { code: "denied" });
  await assert.rejects(people.lent(BOB).get(a.credential), { code: "not_found" }, "the copy is deleted");
  assert.equal((await as("kit", "chat-2", { credential: b.credential, ...GET })).kind, "read", "another chat's lend stands");
  assert.equal(await lentCreds.endFor(BOB, "chat-1"), 0);
});

test("anything outward still waits at the Gate for a person, and an expired lend is not used", async t => {
  const { lentCreds, as, net, gate, now, rig } = await mk(t);
  const lent = await lentCreds.lend(BOB, LEND({ expires: now() + 5_000 }));
  const held = await as("kit", "chat-1", { credential: lent.credential, method: "POST", url: "https://api.bobs.example.test/v1/send", body: { a: 1 } });
  assert.ok(held.held, "a send is held"); assert.equal(net.calls.length, 0); assert.equal(gate.items.size, 1);
  rig.clock(); for (let i = 0; i < 20_000; i++) rig.clock();   // the rig's clock only moves when it is read
  await assert.rejects(as("kit", "chat-1", { credential: lent.credential, method: "GET", url: "https://api.bobs.example.test/v1/a" }), { code: "denied" }, "past its expiry nothing is served");
});

test("only a valid credential with a key that stays put can be lent: a bad config, a browser or oauth sign-in, a missing item", async t => {
  const { lentCreds, people, now } = await mk(t);
  await people.put(BOB, { name: "bad", kind: "api-credential", fields: { config: "{not json", secret: "x" } });
  await people.put(BOB, { name: "oauthy", kind: "api-credential", fields: { config: JSON.stringify({ auth: { type: "browser" }, hosts: ["b.example.test"] }) } });
  await people.put(BOB, { name: "note", kind: "note", fields: { value: "n" } });
  for (const item of ["bad", "oauthy", "note"]) await assert.rejects(lentCreds.lend(BOB, LEND({ item, expires: now() + 1000 })), { code: "bad_input" }, item);
  await assert.rejects(lentCreds.lend(BOB, LEND({ item: "ghost", expires: now() + 1000 })), { code: "not_found" });
  await assert.rejects(lentCreds.lend(BOB, LEND({ agent: "ghost", expires: now() + 1000 })), { code: "not_found" });
});

test("it acts only on HER turns: another member's turn in the same chat, or a turn with no asker, is refused even though the lend has not ended", async t => {
  const { lentCreds, as, net, GET, askers, now } = await mk(t);
  const lent = await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  askers.set("chat-1", "per_cy");
  await assert.rejects(as("kit", "chat-1", { credential: lent.credential, ...GET }), { code: "denied" }, "Cy asks the next turn in Bob's chat");
  askers.delete("chat-1");
  await assert.rejects(as("kit", "chat-1", { credential: lent.credential, ...GET }), { code: "denied" }, "no asker");
  assert.equal(net.calls.length, 0);
  askers.set("chat-1", BOB);
  assert.equal((await as("kit", "chat-1", { credential: lent.credential, ...GET })).kind, "read", "her own turn works again");
});

test("a loan lasts the turn: 30 minutes unless said, never more than an hour", async t => {
  const { lentCreds, now } = await mk(t);
  const a = await lentCreds.lend(BOB, LEND({}));
  assert.ok(a.expires - now() <= 30 * 60_000 + 1000 && a.expires - now() > 29 * 60_000, "about 30 minutes");
  await assert.rejects(lentCreds.lend(BOB, LEND({ thread: "chat-2", expires: now() + 61 * 60_000 })), { code: "bad_input" }, "more than an hour");
  await assert.rejects(lentCreds.lend(BOB, LEND({ thread: "chat-2", expires: now() - 1 })), { code: "bad_input" }, "already over");
  assert.ok((await lentCreds.lend(BOB, LEND({ thread: "chat-2", expires: now() + 59 * 60_000 }))).credential);
});

test("the member leaving, or changing or deleting the item, takes the copy and the grant", async t => {
  const { lentCreds, people, as, GET, now } = await mk(t);
  const a = await lentCreds.lend(BOB, LEND({ expires: now() + 600_000 }));
  assert.equal(await lentCreds.changed(BOB, "bobs-api"), 1, "an edit or a delete of the item");
  await assert.rejects(as("kit", "chat-1", { credential: a.credential, ...GET }), { code: "denied" });
  await assert.rejects(people.lent(BOB).get(a.credential), { code: "not_found" });
  const b = await lentCreds.lend(BOB, LEND({ thread: "chat-2", expires: now() + 600_000 }));
  assert.equal(await lentCreds.gone(BOB), 1, "she left");
  await assert.rejects(as("kit", "chat-2", { credential: b.credential, ...GET }), { code: "denied" });
  await assert.rejects(people.lent(BOB).get(b.credential), { code: "not_found" });
});
