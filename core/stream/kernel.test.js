// @ts-check
// The stream on a real kernel (chat 0.3 task M): stream.open decides through the kernel's chats.read, the chat's people are the kernel's
// (one store), roles come from the kernel's members, and an assistant's cited field is drawn per viewer over a real socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Registry, discover } from "../modules/index.js";
import { open } from "../store/index.js";
import { Events } from "../events/index.js";
import * as config from "../config/index.js";
import { tempHome } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { createKernel } from "../../kernel/index.js";
import { canonical, sha256 } from "../../kernel/core/canonical.js";
import { fakeThreads } from "./fake-threads.js";
import { connect, wsDuplex } from "./client.js";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol", ADA = "per_ada";
const used = new Set();
const proof = (/** @type {string} */ action, /** @type {any} */ input, /** @type {string} */ resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const presence = { check: async (/** @type {any} */ { chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };

async function world(t) {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const g = k.gateway.grants;
  for (const [p, role] of [[BOB, "manager"], [CAROL, "member"], [ADA, "member"]]) { const r = { person: p, role }; await g.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  const kit = { kind: "agent", id: "kit", space: SPACE };
  await g.addActor(owner, kit, { presence: proof("grants.role", { actor: kit }, `vyre://${SPACE}/member/kit`) });
  const dev = (/** @type {string} */ person, /** @type {string} */ id) => k.chains.fromFacts({ kind: "device", device_key_id: id, person, path: "direct" });
  const chains = { owner, bob: dev(BOB, "d-b"), carol: dev(CAROL, "d-c"), ada: dev(ADA, "d-a") };
  /** @type {Record<string, string>} */ const tokens = {};
  for (const [n, c] of Object.entries(chains)) tokens[n] = (await k.surfaces.open(c, {})).token;
  tokens.adaKit = (await k.surfaces.open(chains.ada, { agent: "kit" })).token;

  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "box" }, paths: p, log: () => {}, kernelFor: k.kernelFor });
  const fake = fs.mkdtempSync(path.join(SCRATCH, "vyre-stream-kernel-"));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  fakeThreads(fake);
  await reg.start([...discover([CORE]).filter(f => f.manifest && f.manifest.name === "stream"), ...discover([fake], { firstPartyRoots: [fake] })], { role: "box" });
  assert.equal(reg.modules.get("stream")?.state, "running", reg.modules.get("stream")?.error);
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    reg.upgrades.get("stream/session").handler(req, socket, head, { caller: "deck", url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(async () => { s.closeAllConnections(); s.close(); await reg.stop(); db.close(); });
  const as = (/** @type {string} */ who) => (/** @type {string} */ tool, /** @type {any} */ input) => reg.call(tool, input, "deck", { token: tokens[who] });
  return { k, chains, as, reg, port, stream: () => reg.modules.get("stream")?.handle };
}
const codeOf = (/** @type {any} */ r) => (r.error ? r.error.code : "ok");
const ok = (/** @type {any} */ r) => { assert.ok(!r.error, r.error && `${r.error.code} ${r.error.message}`); return r.data; };

test("stream.open through chats.read: a participant opens; a member outside, the owner outside, and another member's assistant are refused", async t => {
  const w = await world(t);
  const C = w.k.gateway.grants.chats;
  const chat = await C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  assert.equal(codeOf(await w.as("bob")("stream.open", { session: chat.id })), "ok", "bob is in it");
  assert.equal(codeOf(await w.as("carol")("stream.open", { session: chat.id })), "ok", "carol is in it");
  assert.equal(codeOf(await w.as("ada")("stream.open", { session: chat.id })), "not_found", "a member who is not in it");
  assert.equal(codeOf(await w.as("owner")("stream.open", { session: chat.id })), "not_found", "the owner who is not in it");
  assert.equal(codeOf(await w.as("adaKit")("stream.open", { session: chat.id })), "not_found", "ada's assistant on a chat between bob and carol");
  assert.equal(codeOf(await w.as("ada")("stream.open", { session: "chat_nonesuch0" })), "not_found");
  // a refused id makes no log
  assert.equal(w.stream().logs.has("chat_nonesuch0"), false);
  // a person added by the kernel's change reads at once; one removed stops at once
  await C.change(w.chains.bob, chat.id, { add_people: [ADA] });
  assert.equal(codeOf(await w.as("ada")("stream.open", { session: chat.id })), "ok");
  await C.change(w.chains.bob, chat.id, { remove_people: [CAROL] });
  assert.equal(codeOf(await w.as("carol")("stream.open", { session: chat.id })), "not_found");
});

test("one store: the group's people are the kernel's; a speaker outside the chat is refused and nobody joins by naming people", async t => {
  const w = await world(t);
  const C = w.k.gateway.grants.chats;
  const chat = await C.create(w.chains.bob, { people: [CAROL] });
  ok(await w.as("bob")("stream.send", { session: chat.id, text: "hello carol", to: [] }));
  const grp = w.stream().groups;
  assert.deepEqual([...grp.people(chat.id)].sort(), [`person:${BOB}`, `person:${CAROL}`]);
  assert.equal(codeOf(await w.as("ada")("stream.send", { session: chat.id, text: "hi", to: [] })), "not_found");
  assert.equal(codeOf(await w.as("owner")("stream.react", { session: chat.id, message: "m1", emoji: "x" })), "not_found");
  assert.equal(codeOf(await w.as("bob")("stream.send", { session: chat.id, text: "add ada", people: [`person:${ADA}`], to: [] })), "bad_input", "people are added with the kernel's chat change");
  await C.change(w.chains.bob, chat.id, { add_people: [ADA], remove_people: [CAROL] });
  ok(await w.as("ada")("stream.send", { session: chat.id, text: "now me", to: [] }));
  assert.deepEqual([...grp.people(chat.id)].sort(), [`person:${ADA}`, `person:${BOB}`]);
  assert.equal(codeOf(await w.as("carol")("stream.send", { session: chat.id, text: "still here?", to: [] })), "not_found");
  assert.ok(w.stream().logs.get(chat.id).read(0).some((/** @type {any} */ f) => f.type === "session.participant-left" && f.data.who === `person:${CAROL}`));
  // a session the kernel does not hold as a chat cannot be founded by a send
  assert.equal(codeOf(await w.as("bob")("stream.send", { session: "chat_founded_here", text: "x", to: [] })), "not_found");
});

test("per-role filtering through the real stream: a manager and a member in one chat, the assistant cites a manager-only field", async t => {
  const w = await world(t);
  const C = w.k.gateway.grants.chats;
  const chat = await C.create(w.chains.bob, { people: [CAROL], assistants: ["kit"] });
  ok(await w.as("bob")("stream.send", { session: chat.id, text: "what is the fee?", to: [] }));
  const seen = /** @type {any[]} */ ([]);
  w.stream().setFieldSource(async (/** @type {any} */ o) => { seen.push(o); return { label: "Fee", kind: "money", value: { amount: 4200, currency: "USD" }, read_roles: ["manager"] }; });
  const log = w.stream().logs.get(chat.id);
  log.append("text-delta", { message: "m9", index: 0, text: "The fee is" }, { author: "assistant:kit", acts_for: `person:${BOB}`, message: "m9" });
  log.append("text-done", { message: "m9", blocks: [{ block: "field-ref", record: `vyre://${SPACE}/matter/1`, field: "fee", label: "Fee" }] }, { author: "assistant:kit", acts_for: `person:${BOB}`, message: "m9" });
  log.append("text-delta", { message: "m10", index: 0, text: "Anything else?" }, { author: "assistant:kit", acts_for: `person:${BOB}`, message: "m10" });
  const watch = async (/** @type {string} */ who) => {
    /** @type {any[]} */ const got = [];
    const c = connect({ open: async ({ from }) => { const o = ok(await w.as(who)("stream.open", { session: chat.id, from })); return wsDuplex(`ws://127.0.0.1:${w.port}${o.path}`); }, onFrame: f => got.push(f), backoff: { base: 5, cap: 10 } });
    t.after(() => c.close());
    const end = Date.now() + 5000;
    while (!got.some(f => f.type === "session.text-delta" && f.data.message === "m10") && Date.now() < end) await new Promise(r => setTimeout(r, 5));
    assert.ok(got.some(f => f.type === "session.text-delta" && f.data.message === "m10"), "the later frame arrives after the cited one, in order");
    return got;
  };
  const mgr = await watch("bob"), mem = await watch("carol");
  const cite = (/** @type {any[]} */ g) => g.find(f => f.type === "session.text-done" && f.data.message === "m9").data.blocks[0];
  assert.deepEqual([cite(mgr).block, cite(mgr).label, cite(mgr).value], ["field", "Fee", { amount: 4200, currency: "USD" }], "the manager sees the value");
  assert.equal(cite(mem).block, "field");
  assert.equal(cite(mem).placeholder, true, "the member sees the chip");
  assert.ok(!JSON.stringify(mem).includes("4200"), "no value on the member's wire");
  assert.ok(!JSON.stringify(mem).includes("field-ref"), "and the ref frame is not what they got");
  assert.deepEqual(seen.map(s => [s.viewer.id, s.viewer.roles]).sort(), [[`person:${BOB}`, ["manager"]], [`person:${CAROL}`, ["member"]]], "roles come from the kernel's members");
  assert.deepEqual(mem.map((/** @type {any} */ f) => f.cur).filter((/** @type {number} */ c) => c > 0), mgr.map((/** @type {any} */ f) => f.cur).filter((/** @type {number} */ c) => c > 0), "same cursors for both");
  // the shared frame in the log is never mutated: a late viewer still gets the ref resolved for them
  assert.equal(log.read(0).find((/** @type {any} */ f) => f.type === "session.text-done" && f.data.message === "m9").data.blocks[0].block, "field-ref");
});
