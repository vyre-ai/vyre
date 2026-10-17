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

const lendRig = (/** @type {any[]} */ asked, /** @type {any} */ lendAnswer) => async (/** @type {string} */ tool, /** @type {any} */ input) => {
  asked.push([tool, input]);
  if (tool === "vault.me.mention.resolve") return { data: { name: input.id, kind: "login", hint: "login: a private note", note: "Only its name is shown in the chat, never the value." } };
  return lendAnswer;
};

test("a chip with her yes and a turn agent asks the Vault to lend it for this turn; the Vault's answer decides, and the chip names the credential for vault.request", async () => {
  const asked = /** @type {any[]} */ ([]);
  const [tag] = await memberVaultTags({ call: lendRig(asked, { data: { lent: true, name: "clio", note: "The agent can use it for this turn and never sees it.", use: "lent-abc123" } }), asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [{ kind: "vault", id: "clio", yes: "signed-yes-opaque" }], names: [] });
  const lend = asked.find(([tool]) => tool === "vault.me.mention.lend");
  assert.deepEqual(lend[1], { asker: "per_bob", id: "clio", thread: "t1", agent: "kit", yes: "signed-yes-opaque" }, "her yes goes through untouched, with the turn's asker and the turn's own agent");
  assert.ok(tag.note.includes('Pass credential "lent-abc123" to vault.request.'), tag.note);
  assert.equal(JSON.stringify(tag).includes("private note"), false);
});

test("no yes, or no agent for the turn, asks for no lend; a refusal such as presence_required leaves the chip a pill", async () => {
  const asked = /** @type {any[]} */ ([]);
  await memberVaultTags({ call: lendRig(asked, { data: { lent: true } }), asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [{ kind: "vault", id: "clio" }], names: [] });
  await memberVaultTags({ call: lendRig(asked, { data: { lent: true } }), asker: "per_bob", thread: "t1", said: "u1", agent: null, chips: [{ kind: "vault", id: "clio", yes: "y" }], names: [] });
  assert.equal(asked.some(([tool]) => tool === "vault.me.mention.lend"), false);
  const [tag] = await memberVaultTags({ call: lendRig([], { error: { code: "presence_required", message: "needs her yes" } }), asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [{ kind: "vault", id: "clio", yes: "bad" }], names: [] });
  assert.equal(tag.note, "Only its name is shown in the chat, never the value.", "still only a named pill");
});

test("a #Name never lends: only a picked chip that carries her yes does", async () => {
  const asked = /** @type {any[]} */ ([]);
  await memberVaultTags({ call: lendRig(asked, { data: { lent: true } }), asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [], names: ["clio"] });
  assert.equal(asked.some(([tool]) => tool === "vault.me.mention.lend"), false);
});

test("an origin the chip names is passed with her yes, and no origin means none is sent", async () => {
  const asked = /** @type {any[]} */ ([]);
  await memberVaultTags({ call: lendRig(asked, { data: { lent: true } }), asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [{ kind: "vault", id: "clio", yes: "y", origin: "https://app.clio.com" }], names: [] });
  await memberVaultTags({ call: lendRig(asked, { data: { lent: true } }), asker: "per_bob", thread: "t1", said: "u1", agent: "kit", chips: [{ kind: "vault", id: "clio", yes: "y" }], names: [] });
  const lends = asked.filter(([tool]) => tool === "vault.me.mention.lend").map(([, i]) => Object.keys(i).sort());
  assert.deepEqual(lends, [["agent", "asker", "id", "origin", "thread", "yes"], ["agent", "asker", "id", "thread", "yes"]]);
});
