// @ts-check
// A member's turn in a chat hears only a picked record and an account chip. A #Name in the words, and a vault, Drive or GitHub chip, are not resolved: those providers would answer under the owner's access.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { Switchboard } from "./index.js";

/** @param {string[]} calls */
function rig(calls) {
  return /** @type {any} */ ({
    record: () => ({ project: null }),
    emit() {},
    hearActs: async () => {},
    deps: {
      call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
        calls.push(`${tool}:${input && (input.kind || input.id || input.q) || ""}`);
        if (tool === "vault.me.mention.resolve") return { error: { code: "not_found", message: "not in their own vault" } };
        if (tool === "mentions.search") return { data: [{ kind: "vault", id: "owner-secret", name: "owner-secret" }] };
        return { data: { name: String(input.id), note: "ok", outside: true } };
      },
      recordTags: async (/** @type {any[]} */ chips) => ({ chips: chips.filter(c => c.kind !== "record"), tags: chips.filter(c => c.kind === "record").map(c => ({ kind: "record", id: c.id, name: c.id, hint: null, hosts: [], note: null, outside: true })) }),
    },
  });
}

const CHIPS = [{ kind: "vault", id: "owner-secret" }, { kind: "drive", id: "owner-file" }, { kind: "github", id: "owner/repo" }, { kind: "record", id: "urn:rec:1" }, { kind: "account", id: "claude" }];

test("a member's turn resolves no vault, Drive or GitHub chip and no #Name under the owner's access", async () => {
  const calls = /** @type {string[]} */ ([]);
  const sb = rig(calls);
  const heard = await Switchboard.prototype.ingress.call(sb, "t1", "use #owner-secret please", "deck", "u1", CHIPS, [], "deck", null, { memberTurn: true });
  assert.deepEqual(heard.map((/** @type {any} */ t) => t.kind).sort(), ["account", "record"]);
  assert.equal(calls.some(c => /mentions\.search|vault\.mention\.resolve/.test(c)), false, calls.join(" "));
  assert.equal(calls.some(c => /vault|drive|github/.test(c)), false, calls.join(" "));
});

test("the owner's own turn still resolves chips and #Names", async () => {
  const calls = /** @type {string[]} */ ([]);
  const sb = rig(calls);
  const heard = await Switchboard.prototype.ingress.call(sb, "t1", "use #owner-secret please", "deck", "u1", CHIPS, [], "deck", null, {});
  assert.ok(heard.some((/** @type {any} */ t) => t.kind === "vault"));
  assert.ok(calls.some(c => c.startsWith("mentions.search")));
});

test("a chat turn hears its picks as its asker: the daemon reads a record under the asker's chain, a member's turn skips what the owner's access would answer, and the words record no ask", async () => {
  const calls = /** @type {string[]} */ ([]);
  const sb = rig(calls);
  /** @type {any[]} */ const asked = [];
  sb.deps.recordTags = async (/** @type {any[]} */ chips, /** @type {any} */ turn) => { asked.push(turn); return { chips: chips.filter(c => c.kind !== "record"), tags: chips.filter(c => c.kind === "record").map(c => ({ kind: "record", id: c.id, name: "Jane", hint: null, hosts: [], note: "n", outside: true })) }; };
  let heardActs = 0;
  sb.hearActs = async () => { heardActs++; };
  const heard = await Switchboard.prototype.ingress.call(sb, "t1", "use #owner-secret please", "deck", "u1", CHIPS, [], "module:stream", null, { memberTurn: true, asker: "per_bob" });
  assert.deepEqual(heard.map((/** @type {any} */ t) => t.kind).sort(), ["account", "record"]);
  assert.equal(asked[0].asker, "per_bob", "the picks are read for the asker");
  assert.equal(heardActs, 0, "a chat turn's words are never heard as the owner's asks");
  assert.equal(calls.some(c => /mentions\.search|vault|drive|github/.test(c)), false, calls.join(" "));
});

test("the owner's own words in a chat are heard for asks, as before; a member's are not", async () => {
  for (const [memberTurn, expected] of [[false, 1], [true, 0]]) {
    const sb = rig([]);
    sb.deps.recordTags = async (/** @type {any[]} */ chips) => ({ chips, tags: [] });
    let heardActs = 0;
    sb.hearActs = async () => { heardActs++; };
    await Switchboard.prototype.ingress.call(sb, "t1", "email Dana", "deck", "u1", [], [], "module:stream", null, { memberTurn, asker: memberTurn ? "per_bob" : "per_owner" });
    assert.equal(heardActs, expected, memberTurn ? "a member's chat words record no ask" : "the owner's chat words are heard");
  }
});

test("a member's #Name and vault chip are asked of THEIR vault for that asker, and the owner's vault tools are never called", async () => {
  const calls = /** @type {string[]} */ ([]);
  const sb = rig(calls);
  sb.hearActs = async () => {};
  sb.deps.recordTags = async (/** @type {any[]} */ chips) => ({ chips, tags: [] });
  const inner = sb.deps.call;
  sb.deps.call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool === "vault.me.mention.resolve") { calls.push(`me:${input.asker}:${input.id}`); return input.id === "my-login" ? { data: { name: "my-login", kind: "login", hint: "login", note: "Your own item. Tagging it does not hand it to an agent." } } : { error: { code: "not_found", message: "no" } }; }
    return inner(tool, input);
  };
  const heard = await Switchboard.prototype.ingress.call(sb, "t1", "use #my-login and #owner-secret", "deck", "u1", [{ kind: "vault", id: "owner-secret" }], [], "module:stream", null, { memberTurn: true, asker: "per_bob" });
  assert.deepEqual(heard.map((/** @type {any} */ t) => t.id), ["my-login"], "only the item in their own vault is a tag");
  assert.ok(calls.some(c => c === "me:per_bob:my-login"), calls.join(" "));
  assert.equal(calls.some(c => /^(vault\.mention|mentions\.)/.test(c)), false, "the owner's vault and the shared search are not asked: " + calls.join(" "));
});
