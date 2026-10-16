// The module hop (core/modules/hop.js): which module calls carry a person through to a tool, and why. One table; a new way to carry a person is a new row with its reason.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mayHop, onPersonSurface } from "./hop.js";

const none = { relayed: false, spaceHop: false, flowRun: false, viewFor: false };
const call = (/** @type {object} */ o) => ({ firstParty: true, origin: "local", ...none, ...o });
const defaulted = { defaulted: true, reach: "anyone" };
const explicit = { defaulted: false, reach: "person" };

/** @type {[string, { defaulted: boolean, reach?: string }, any, boolean, string][]} */
const TABLE = [
  ["a person's plain call through a module, to a defaulted write", defaulted, call({}), true, "the module acts for the person who called it; origin keeps the caller's own class"],
  ["an added module acting for a person, to a defaulted write", defaulted, call({ firstParty: false }), true, "the defaulted tool is person-only by default; the origin is still judged at the gate"],
  ["a plain module call to an explicit person-only tool", explicit, call({}), false, "the module could be called by anything; explicit person-only tools are not reached by a plain ctx.call"],
  ["a relayed call to an explicit person-only tool", explicit, call({ relayed: true }), true, "the call proves the person (facts or session token)"],
  ["a Flow step the Flows host runs", explicit, call({ flowRun: true }), true, "the Flow's person approved it, and the host runs it as that person"],
  ["a view click the person made", explicit, call({ viewFor: true }), true, "the person's own click authorises the module's own tool"],
  ["a call inside a space's own chain", explicit, call({ spaceHop: true }), true, "that space's authorize allowed it"],
  ["a proven call from an added module", explicit, call({ relayed: true, firstParty: false }), false, "only first-party code carries a person to an explicit person-only tool"],
  ["a proven call with no origin", explicit, call({ relayed: true, origin: undefined }), false, "nobody to act for"],
  ["a proven call to a tool that is not person-only", { defaulted: false, reach: "anyone" }, call({ relayed: true }), false, "the hop is for the person-only door; other tools judge the module itself"],
];

for (const [name, def, c, want, why] of TABLE) test(`hop: ${name}`, () => assert.equal(mayHop(def, c), want, why));

test("hop: only a person's own surface, never a model, stands for the person before a token exists", () => {
  for (const ok of ["local", "cli", "deck"]) assert.equal(onPersonSurface(ok), true, ok);
  for (const no of ["mcp", "mcp:agent:kit", "harness:thread:t1", "module:probe", "hook"]) assert.equal(onPersonSurface(no), false, no);
});
