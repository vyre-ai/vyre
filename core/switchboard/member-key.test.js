// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { memberKey } from "./member-key.js";

const acct = (over = {}) => ({ id: "acc1", label: "Ben's key", person: "per_ben", kind: "api-key", own_vault: 1, ...over });
const ctxOf = (reply) => { const calls = []; const opts = []; return { calls, opts, call: async (tool, input, o) => { calls.push({ tool, input }); opts.push(o); return reply; } }; };

test("a person's key is lent for the turn from their own vault, and the value goes to the caller alone", async () => {
  const c = ctxOf({ data: { value: "sk-fixture-0123456789" } });
  assert.equal(await memberKey(c, acct()), "sk-fixture-0123456789");
  assert.deepEqual(c.calls, [{ tool: "vault.me.lend", input: { account: "acc1" } }]);
  assert.deepEqual(c.opts, [{ relay: true }], "asked as the person on the turn: a plain module call carries no person");
});

test("a key not kept in its owner's own vault is refused without asking any vault", async () => {
  const c = ctxOf({ data: { value: "sk-fixture-0123456789" } });
  await assert.rejects(memberKey(c, acct({ own_vault: 0 })), e => e.code === "denied" && /not kept in its owner's own vault/.test(e.message));
  assert.deepEqual(c.calls, []);
});

test("a locked vault says to unlock it, another refusal says the key is one person's, and no value is a refusal, never a fall back", async () => {
  await assert.rejects(memberKey(ctxOf({ error: { code: "locked", message: "x" } }), acct()), e => e.code === "no_credential" && /unlock your own vault/.test(e.message));
  await assert.rejects(memberKey(ctxOf({ error: { code: "denied", message: "x" } }), acct()), e => e.code === "no_credential" && /used only in their own turns/.test(e.message));
  await assert.rejects(memberKey(ctxOf({ data: {} }), acct()), e => e.code === "no_credential" && /gave no key/.test(e.message));
  await assert.rejects(memberKey(ctxOf({ data: { value: "" } }), acct()), e => e.code === "no_credential");
});
