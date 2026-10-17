import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lendYes, setLendSigner, withYes, LEND_OP } from "./lend-yes.ts";

const F = { asker: "per_" + "b".repeat(26), id: "clio", thread: "thr_1", agent: "kit" };

test("with no signer (a browser) there is no yes, so nothing is lent", async () => {
  setLendSigner(null);
  assert.equal(await lendYes(F), null);
});

test("the signer is asked for exactly the lend op over exactly the four fields, and a good yes comes back", async () => {
  const seen = [];
  setLendSigner(async (op, fields) => { seen.push([op, fields]); return "device key=k ts=1 nonce=n sig=s"; });
  assert.equal(await lendYes({ ...F, extra: "ignored" }), "device key=k ts=1 nonce=n sig=s");
  assert.deepEqual(seen, [[LEND_OP, F]]);
  assert.equal(LEND_OP, "vault.me.mention.lend");
});

test("a closed prompt, a throw, an empty or an oversized yes, and fields the Vault would not accept are all no yes", async () => {
  for (const out of [null, "", "x".repeat(5000)]) { setLendSigner(async () => out); assert.equal(await lendYes(F), null); }
  setLendSigner(async () => { throw new Error("prompt closed"); });
  assert.equal(await lendYes(F), null);
  setLendSigner(async () => "yes");
  assert.equal(await lendYes({ ...F, asker: "bob" }), null, "the asker is a person id");
  assert.equal(await lendYes({ ...F, agent: "Kit Two" }), null, "the agent is a name, never free text");
  assert.equal(await lendYes({ ...F, thread: "a b" }), null);
  setLendSigner(null);
});

test("only a vault chip carries her yes; a record or a file chip is returned as it was", () => {
  assert.deepEqual(withYes({ kind: "vault", id: "clio", name: "clio" }, "y"), { kind: "vault", id: "clio", name: "clio", yes: "y" });
  assert.deepEqual(withYes({ kind: "record", id: "urn", name: "r" }, "y"), { kind: "record", id: "urn", name: "r" });
  assert.deepEqual(withYes({ kind: "vault", id: "clio", name: "clio" }, null), { kind: "vault", id: "clio", name: "clio" });
});
