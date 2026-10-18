// @ts-check
// Who a member's own AI key may be lent to: the verified asker of a turn running or being handed over, still in the chat, with an account that is that same person's. Anything else is refused before the daemon is asked.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lendTurn } from "./lend-turn.js";
import { memberKey } from "./member-key.js";

const acct = (/** @type {any} */ over = {}) => ({ id: "acc1", label: "Ben's key", person: "per_ben", kind: "api-key", own_vault: 1, ...over });
function sbOf(/** @type {{ stored?: string | null, inChat?: boolean, space?: string | null }} */ o = {}) {
  /** @type {any[]} */ const probes = [];
  const sb = { turnAsker: new Map(o.stored ? [["t1", o.stored]] : []), turnSpace: new Map(o.space ? [["t1", o.space]] : []), canon: (/** @type {string} */ x) => x,
    assertAsker: async (/** @type {string} */ id, /** @type {any} */ _rec, /** @type {any} */ turn) => { probes.push({ id, ...turn }); if (o.inChat === false) throw new Error("not in chat"); } };
  return { sb, probes };
}
const rec = { id: "t1", chat: "chat1" };

test("the verified asker of this launch, in the chat, with an account of their own: lent for that asker", async () => {
  const { sb, probes } = sbOf();
  assert.deepEqual(await lendTurn(sb, "t1", rec, { kernelTurn: { asker: "per_ben", chat: "chat1" } }, acct()), { asker: "per_ben", space: null });
  assert.deepEqual(probes, [{ id: "t1", chat: "chat1", asker: "per_ben" }], "still in the chat is asked at lend time");
});

test("no asker, no chat, or an asker who is no longer in the chat: refused", async () => {
  await assert.rejects(lendTurn(sbOf().sb, "t1", rec, {}, acct()), /not available to this turn/);
  await assert.rejects(lendTurn(sbOf({ stored: "per_ben" }).sb, "t1", { id: "t1" }, {}, acct()), /not available to this turn/, "no chat");
  await assert.rejects(lendTurn(sbOf({ inChat: false }).sb, "t1", rec, { kernelTurn: { asker: "per_ben", chat: "chat1" } }, acct()), e => e.code === "no_credential");
});

test("a turn handed over from the queue is its stored asker's; a stale asker cannot lend for another person's turn; an account of someone else is refused", async () => {
  assert.equal((await lendTurn(sbOf({ stored: "per_ben" }).sb, "t1", rec, {}, acct())).asker, "per_ben");
  await assert.rejects(lendTurn(sbOf({ stored: "per_ada" }).sb, "t1", rec, { kernelTurn: { asker: "per_ben", chat: "chat1" } }, acct()), /not available to this turn/, "the stored asker is another person");
  await assert.rejects(lendTurn(sbOf({ stored: "per_ada" }).sb, "t1", rec, {}, acct()), /not available to this turn/, "ada's turn, ben's account");
  await assert.rejects(lendTurn(sbOf().sb, "t1", rec, { kernelTurn: { asker: "per_ada", chat: "chat1" } }, acct()), /not available to this turn/, "ada asks, the account is ben's");
  await assert.rejects(lendTurn(sbOf().sb, "t1", rec, { kernelTurn: { asker: "per_ben", chat: "chat1" } }, acct({ person: null })), /not available to this turn/);
});

test("memberKey asks lendKey for exactly the settled asker and account, and takes the value; without lendKey or a turn nothing is lent", async () => {
  /** @type {any[]} */ const asked = [];
  const ctx = { lendKey: async (/** @type {any} */ q) => { asked.push(q); return { data: { value: "sk-fixture-0123456789" } }; } };
  assert.equal(await memberKey(ctx, acct(), { asker: "per_ben", space: null }), "sk-fixture-0123456789");
  assert.deepEqual(asked, [{ asker: "per_ben", account: "acc1", space: null }]);
  await assert.rejects(memberKey({}, acct(), { asker: "per_ben" }), e => e.code === "no_credential");
  await assert.rejects(memberKey(ctx, acct(), undefined), e => e.code === "no_credential");
  assert.equal(asked.length, 1);
});

test("the asker comes only from the verified asker or the stored one: a person named by the launch's options or the thread's record changes nothing", async () => {
  const named = { person: "per_ada", account: "acc-ada", switchPerson: "per_ada", kernelTurn: { asker: "per_ben", chat: "chat1" } };
  const recOf = { id: "t1", chat: "chat1", person: "per_ada", agent: "per_ada" };
  // ben is the verified asker: the lend is for ben whatever else names ada
  assert.deepEqual(await lendTurn(sbOf().sb, "t1", recOf, named, acct()), { asker: "per_ben", space: null });
  // ada's account in a turn ben asked: refused, though the options and the record both name ada
  await assert.rejects(lendTurn(sbOf().sb, "t1", recOf, named, acct({ id: "acc-ada", person: "per_ada" })), /not available to this turn/);
  // no verified or stored asker at all: naming ada in the options lends nothing
  await assert.rejects(lendTurn(sbOf().sb, "t1", recOf, { person: "per_ada" }, acct({ person: "per_ada" })), /not available to this turn/);
});

import { callLend } from "../modules/lend-call.js";
test("the registry's lend call is vault.me.lend as module:threads on the given token, and nothing without a token", async () => {
  /** @type {any[]} */ const calls = [];
  const registry = { call: async (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller, /** @type {any} */ meta) => { calls.push({ tool, input, caller, meta }); return { data: { value: "v" } }; } };
  assert.deepEqual(await callLend(registry, { account: "acc1", other: "x" }, { token: "T" }), { data: { value: "v" } });
  assert.deepEqual(calls, [{ tool: "vault.me.lend", input: { account: "acc1" }, caller: "module:threads", meta: { origin: "deck", token: "T" } }]);
  assert.equal((await callLend(registry, { account: "acc1" }, { token: "" })).error.code, "denied");
  assert.equal((await callLend(registry, { account: "acc1" }, /** @type {any} */ (null))).error.code, "denied");
  assert.equal(calls.length, 1, "no token, no call");
});
