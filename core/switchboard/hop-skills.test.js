// Whose personal skills a launch is given: the verified asker of the turn (a member's one-turn hop gets the member's), nobody's for a thread a chat turn started that is launched with no verified person
// (the hop back, a plain resume), and the library's default (no person) for an ordinary thread no chat turn started.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { libraryPerson, NOBODY } from "./asker-account.js";
import { Switchboard } from "./index.js";

const sb = /** @type {any} */ ({ turnAsker: new Map() });

test("libraryPerson: the hop's asker, the running turn's asker, nobody for a chat-started thread with no verified person, the default otherwise", () => {
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob", kernelTurn: { chat: "c", asker: "per_carol" } }), "per_carol", "carol's hop asks for carol's skills");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob", kernelTurn: { chat: "c", asker: "per_bob" } }), "per_bob", "bob's own turn asks for bob's");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob" }), NOBODY, "a chat-started thread launched with no verified person (the hop back) asks for nobody's");
  sb.turnAsker.set("t", "per_ada");
  assert.equal(libraryPerson(sb, { id: "t" }, { person: "per_bob" }), "per_ada", "a respawn takes the running turn's asker");
  sb.turnAsker.clear();
  assert.equal(libraryPerson(sb, { id: "own" }, {}), undefined, "an ordinary thread no chat turn started keeps the library's default");
});

test("libraryPlugin passes that person to skills.materialise", async () => {
  /** @type {any[]} */ const asked = [];
  const board = { turnAsker: new Map(), deps: { call: async (/** @type {string} */ tool, /** @type {any} */ input) => { asked.push([tool, input]); return { error: { code: "not_found" } }; } } };
  await Switchboard.prototype.libraryPlugin.call(board, { id: "t", provider: "claude" }, { person: "per_bob", kernelTurn: { chat: "c", asker: "per_carol" } });
  await Switchboard.prototype.libraryPlugin.call(board, { id: "t", provider: "claude" }, { person: "per_bob" });
  await Switchboard.prototype.libraryPlugin.call(board, { id: "own", provider: "claude" }, {});
  assert.deepEqual(asked.map(a => a[1].person), ["per_carol", NOBODY, undefined]);
});
