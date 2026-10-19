// @ts-check
// The owner's Assistant, talked to through agents.ask (the owner's rule, 20 Oct 2026: every turn runs on the account of the person who asked). Real daemon, real kernel, temp home, the fake claude.
//   - the owner's chat runs on the owner's own account, on the Assistant's one thread;
//   - a member's chat gets a thread of her own with the Assistant, on HER account, never the owner's, and the owner's thread is untouched;
//   - an admin with no account of their own is refused in plain words, never run on the owner's.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { boot } from "../team/team-fixture.js";
import * as config from "../config/index.js";
import { open as openStore } from "../store/index.js";

const BEN = "per_" + "e".repeat(26);
const ADA = "per_" + "f".repeat(26);

test("the Assistant: the owner's chat on the owner's account, a member's on a thread and account of her own, an admin with none refused", { timeout: 180_000 }, async t => {
  const { d, root } = await boot(t);
  const OWNER = d.kernel.id.owner;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  /** @param {string} p @param {string} role @param {number} n */
  const add = async (p, role, n) => {
    await d.kernel.gateway.grants.setRole(ownerChain, { person: p, role }, { presence: { op: "x", fields: {}, n } });
    const chain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-" + p.slice(4, 8), person: p, path: "direct", session: "s-" + p.slice(4, 8) });
    return { token: (await d.kernel.surfaces.open(chain, {})).token };
  };
  const as = (/** @type {any} */ who) => (/** @type {string} */ name, /** @type {any} */ input = {}) => d.registry.call(name, input, "deck", who);
  const ben = as(await add(BEN, "member", 2)), ada = as(await add(ADA, "admin", 3));
  const owner = (/** @type {string} */ n, /** @type {any} */ i = {}) => d.registry.call(n, i, "cli");
  /** @param {string} id */
  const run = id => { const db = openStore(config.paths(root).db); try { return /** @type {any} */ (db.prepare("SELECT account, agent, provider FROM threads_runs WHERE id = ?").get(id)); } finally { db.close(); } };
  const runsOf = () => { const db = openStore(config.paths(root).db); try { return /** @type {any[]} */ (db.prepare("SELECT id, account FROM threads_runs WHERE agent = 'juno'").all()); } finally { db.close(); } };
  const mine = (/** @type {string} */ person) => { const db = openStore(config.paths(root).db); try { return /** @type {any} */ (db.prepare("SELECT thread FROM agents_person_threads WHERE agent = 'juno' AND person = ?").get(person)); } finally { db.close(); } };

  const ownerAcct = await owner("sessions.accounts.add", { provider: "claude", label: "The owner's Claude", kind: "login" });
  assert.equal(ownerAcct.error, undefined, JSON.stringify(ownerAcct.error));
  assert.equal((await owner("agents.create", { name: "juno", kind: "assistant" })).error, undefined);

  // the owner: the Assistant's one thread, on the owner's own account
  const o = await owner("agents.ask", { agent: "juno", text: "hello", wait: false });
  assert.equal(o.error, undefined, JSON.stringify(o.error));
  assert.equal(run(o.data.thread).account, ownerAcct.data.id, "the owner's chat runs on the owner's account");
  assert.equal(mine(OWNER), undefined, "the owner's chat is the Assistant's own thread, not a per-person one");

  // a member it is shared with, with her own Claude: a thread of her own, on her account
  assert.equal((await owner("agents.access.set", { agent: "juno", kind: "person", subject: BEN, level: "use" })).error, undefined);
  const benAcct = await ben("sessions.accounts.add", { provider: "claude", label: "Ben's Claude", kind: "login" });
  assert.equal(benAcct.error, undefined, JSON.stringify(benAcct.error));
  const b = await ben("agents.ask", { agent: "juno", text: "hello", wait: false });
  assert.equal(b.error, undefined, JSON.stringify(b.error));
  assert.notEqual(b.data.thread, o.data.thread, "his own thread with the Assistant, never the owner's");
  assert.equal(run(b.data.thread).account, benAcct.data.id, "on his own account");
  assert.equal(mine(BEN).thread, b.data.thread);
  // NEGATIVE: the owner's account never runs his turn, and the owner's thread stays on the owner's account
  assert.notEqual(run(b.data.thread).account, ownerAcct.data.id);
  assert.equal(run(o.data.thread).account, ownerAcct.data.id);

  // an admin with no account of their own: refused in plain words, nothing started, never the owner's
  const before = runsOf().length;
  const a = await ada("agents.ask", { agent: "juno", text: "hello", wait: false });
  assert.match(String(a.error && a.error.message), /Connect your own AI account in Settings, AI accounts, to use juno\./, JSON.stringify(a));
  assert.equal(runsOf().length, before, "NEGATIVE: no run was started for the admin on anyone's account");
  assert.equal(mine(ADA), undefined);
});
