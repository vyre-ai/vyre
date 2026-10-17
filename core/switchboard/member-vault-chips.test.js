// @ts-check
// A member's vault chip and #Name resolve from their own vault through vault.me.mention.resolve, naming the asker; another's item, a missing one and a locked vault are handled in words, and no value is carried.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { memberVaultTags } from "./member-vault-chips.js";

const rig = (/** @type {Record<string, any>} */ vault, /** @type {any[]} */ asked) => async (/** @type {string} */ tool, /** @type {any} */ input) => {
  asked.push([tool, input]);
  const v = vault[input.id];
  if (v === "locked") return { error: { code: "locked", message: "Unlock your vault to tag one of your own items." } };
  return v ? { data: { name: input.id, kind: v.kind, hint: v.kind, note: "Your own item. Tagging it does not hand it to an agent." } } : { error: { code: "not_found", message: "no such item" } };
};

test("a member's chip and #Name resolve from their own vault for that asker, and ask nothing else", async () => {
  const asked = /** @type {any[]} */ ([]);
  const tags = await memberVaultTags({ call: rig({ "my-login": { kind: "login" } }, asked), asker: "per_bob", thread: "t1", said: "u1", chips: [{ kind: "vault", id: "my-login" }, { kind: "drive", id: "f" }], names: ["my-login", "nothing"] });
  assert.deepEqual(tags.map(t => [t.kind, t.id, t.hint]), [["vault", "my-login", "login"]]);
  assert.ok(asked.every(([tool, i]) => tool === "vault.me.mention.resolve" && i.asker === "per_bob" && i.thread === "t1"), JSON.stringify(asked));
  assert.deepEqual(asked.map(([, i]) => i.id).sort(), ["my-login", "nothing"], "the same item named twice is asked once; a Drive chip is not asked here");
  assert.equal(JSON.stringify(tags).includes("value"), false);
});

test("an item that is not in their vault, such as the owner's, is plain text", async () => {
  const tags = await memberVaultTags({ call: rig({}, []), asker: "per_bob", thread: "t1", said: "u1", chips: [{ kind: "vault", id: "owner-secret" }], names: ["owner-secret"] });
  assert.deepEqual(tags, []);
});

test("a locked vault says so in the vault's own words, once, and a refusal that is not a lock says nothing", async () => {
  const tags = await memberVaultTags({ call: rig({ mine: "locked" }, []), asker: "per_bob", thread: "t1", said: "u1", chips: [{ kind: "vault", id: "mine" }], names: [] });
  assert.equal(tags.length, 1);
  assert.equal(tags[0].hint, "locked");
  assert.equal(tags[0].note, "Unlock your vault to tag one of your own items.");
  assert.deepEqual(await memberVaultTags({ call: async () => { throw new Error("boom"); }, asker: "per_bob", thread: "t", said: "u", chips: [{ kind: "vault", id: "x" }], names: [] }), []);
});

test("the asker is the one the caller passes from the verified turn, never a field of a chip", async () => {
  const asked = /** @type {any[]} */ ([]);
  const tags = await memberVaultTags({ call: rig({ "my-login": { kind: "login" } }, asked), asker: "per_bob", thread: "t1", said: "u1", chips: [{ kind: "vault", id: "my-login", asker: "per_owner", person: "per_owner" }], names: [] });
  assert.equal(tags.length, 1);
  assert.deepEqual(asked.map(([, i]) => i.asker), ["per_bob"], "a chip that names another person changes nothing");
});

test("the item's description never reaches the tag: only its name and kind do", async () => {
  const call = async () => ({ data: { name: "my-login", kind: "login", hint: "login: my private note about the bank", note: "Only its name is shown in the chat, never the value." } });
  const [tag] = await memberVaultTags({ call, asker: "per_bob", thread: "t1", said: "u1", chips: [{ kind: "vault", id: "my-login" }], names: [] });
  assert.equal(JSON.stringify(tag).includes("private note"), false);
  assert.equal(tag.hint, "login");
});

test("a vault chip, even one that still carries a yes, asks the Vault for nothing but its name: nothing is lent", async () => {
  const asked = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { asked.push([tool, input]); return { data: { name: input.id, kind: "login", hint: "login: a private note", note: "Only its name is shown in the chat, never the value." } }; };
  const [tag] = await memberVaultTags({ call, asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [{ kind: "vault", id: "clio", yes: "signed", origin: "https://app.clio.com" }], names: ["clio"] });
  assert.deepEqual([...new Set(asked.map(([tool]) => tool))], ["vault.me.mention.resolve"]);
  assert.equal(tag.note, "Only its name is shown in the chat, never the value.");
  assert.equal(JSON.stringify(asked).includes("signed"), false, "her yes is never read or passed on");
});
