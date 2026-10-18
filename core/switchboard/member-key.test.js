// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memberKey } from "./member-key.js";

const acct = (over = {}) => ({ id: "acc1", label: "Ben's key", person: "per_ben", kind: "api-key", own_vault: 1, ...over });
const turn = { asker: "per_ben", space: null };
const ctxOf = (reply) => { const calls = []; return { calls, lendKey: async (q) => { calls.push(q); return reply; } }; };

test("a person's key is lent for the turn from their own vault, and the value goes to the caller alone", async () => {
  const c = ctxOf({ data: { value: "sk-fixture-0123456789" } });
  assert.equal(await memberKey(c, acct(), turn), "sk-fixture-0123456789");
  assert.deepEqual(c.calls, [{ asker: "per_ben", account: "acc1", space: null }], "the daemon is asked for the settled asker and the account, nothing else");
});

test("a key not kept in its owner's own vault is refused without asking any vault", async () => {
  const c = ctxOf({ data: { value: "sk-fixture-0123456789" } });
  await assert.rejects(memberKey(c, acct({ own_vault: 0 }), turn), e => e.code === "denied" && /not kept in its owner's own vault/.test(e.message));
  assert.deepEqual(c.calls, []);
});

test("a locked vault says to unlock it, another refusal says the key is one person's, and no value is a refusal, never a fall back", async () => {
  await assert.rejects(memberKey(ctxOf({ error: { code: "locked", message: "x" } }), acct(), turn), e => e.code === "no_credential" && /unlock your own vault/.test(e.message));
  await assert.rejects(memberKey(ctxOf({ error: { code: "denied", message: "x" } }), acct(), turn), e => e.code === "no_credential" && /used only in their own turns/.test(e.message));
  await assert.rejects(memberKey(ctxOf({ data: {} }), acct(), turn), e => e.code === "no_credential" && /gave no key/.test(e.message));
  await assert.rejects(memberKey(ctxOf({ data: { value: "" } }), acct(), turn), e => e.code === "no_credential");
});

test("the turn may be given as a function, asked only when a key is to be lent: a refusal before that never asks it", async () => {
  let asked = 0;
  const lazy = async () => { asked++; return { asker: "per_ben", space: null }; };
  await assert.rejects(memberKey(ctxOf({ data: { value: "sk-fixture-0123456789" } }), acct({ own_vault: 0 }), lazy), e => e.code === "denied");
  assert.equal(asked, 0, "not kept in its owner's vault: the turn is never settled");
  assert.equal(await memberKey(ctxOf({ data: { value: "sk-fixture-0123456789" } }), acct(), lazy), "sk-fixture-0123456789");
  assert.equal(asked, 1);
});
