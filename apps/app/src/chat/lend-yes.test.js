import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { lendYes, setLendSigner, withYes, lendSignerFor, lendWithSite, LEND_OP } from "./lend-yes.ts";
import { signOf } from "../../../../lib/one-yes-sign.js";

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

test("the device signs the vault moment for exactly the lend op and the four fields, and the yes is base64url of the proof", async () => {
  const seen = [];
  const device = { signPresence: async (req) => { seen.push(req); return { sig: "abc", op: req.op }; } };
  const sign = lendSignerFor({ device, person: F.asker, space: "spc_aaaaaaaaaaaa" });
  const yes = await sign(LEND_OP, F);
  assert.equal(seen.length, 1);
  const want = signOf("vault", { op: LEND_OP, fields: F });
  assert.equal(seen[0].op, want.op);
  assert.deepEqual(seen[0].fields, want.fields, "the fields are the vault moment's, with the lend op and the four fields nested");
  assert.deepEqual(seen[0].fields.fields, F);
  assert.equal(seen[0].person, F.asker);
  assert.match(seen[0].prompt, /kit/);
  assert.deepEqual(JSON.parse(Buffer.from(yes, "base64url").toString()), { sig: "abc", op: want.op });
});

test("a closed prompt gives no yes, so no chip carries one and nothing is lent", async () => {
  const sign = lendSignerFor({ device: { signPresence: async () => null }, person: F.asker, space: "spc_aaaaaaaaaaaa" });
  assert.equal(await sign(LEND_OP, F), null);
  setLendSigner(sign);
  assert.equal(await lendYes(F), null);
  assert.deepEqual(withYes({ kind: "vault", id: "clio", name: "clio" }, await lendYes(F)), { kind: "vault", id: "clio", name: "clio" }, "a chip without a yes lends nothing");
  setLendSigner(null);
});

test("an origin is signed into her yes exactly when the tag names one, and a malformed one gives no yes", async () => {
  const seen = [];
  setLendSigner(async (op, fields) => { seen.push(fields); return "yes"; });
  await lendYes({ ...F, origin: "https://app.clio.com" });
  await lendYes(F);
  assert.deepEqual(seen, [{ ...F, origin: "https://app.clio.com" }, F]);
  assert.equal(await lendYes({ ...F, origin: "not a site" }), null);
  setLendSigner(null);
});

test("a login with several sites: the origin signed is the one she picked, and a site that is not in the list is never signed", async () => {
  const seen = [];
  setLendSigner(async (op, fields) => { seen.push(fields); return "yes"; });
  const sites = ["https://app.clio.com", "https://eu.clio.com", "https://support.clio.com"];
  const r = await lendWithSite(F, sites, async (list) => list[1]);
  assert.deepEqual(r, { yes: "yes", origin: "https://eu.clio.com" });
  assert.deepEqual(seen.at(-1), { ...F, origin: "https://eu.clio.com" });
  seen.length = 0;
  assert.equal(await lendWithSite(F, sites, async () => "https://evil.example"), null, "a site she was not offered");
  assert.equal(await lendWithSite(F, sites, async () => null), null, "she closed the picker: nothing is signed");
  assert.equal(seen.length, 0);
  setLendSigner(null);
});

test("one site or none needs no choice and signs no origin: the Vault uses the address it has, or asks which site", async () => {
  const seen = [];
  setLendSigner(async (op, fields) => { seen.push(fields); return "yes"; });
  let asked = 0;
  const choose = async () => { asked++; return null; };
  assert.deepEqual(await lendWithSite(F, ["https://app.clio.com"], choose), { yes: "yes" });
  assert.deepEqual(await lendWithSite(F, [], choose), { yes: "yes" });
  assert.equal(asked, 0);
  assert.deepEqual(seen, [F, F]);
  setLendSigner(null);
});
