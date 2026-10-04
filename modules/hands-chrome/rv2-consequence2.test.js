// reviewer-2 repro HD-6c against work/kernel-declare bca589989 (drop into modules/hands-chrome/): the passive role still decides alone for a name that is not on the allow-list.
import test from "node:test";
import assert from "node:assert/strict";
import { of } from "./consequence.js";

test("HD-6c: a role the page chose must not make a name outside the allow-list observable", () => {
  const cases = [{ name: "Finish", role: "tab" }, { name: "Activate account", role: "option" }, { name: "Upgrade now", role: "row" }, { name: "Join", role: "cell" }, { name: "Unlock access", role: "listbox" }, { name: "Done", role: "label" }];
  const out = cases.map(c => [c.name, c.role, of(c).consequential]);
  console.log("HD-6c", JSON.stringify(out));
  assert.deepEqual(out.filter(o => !o[2]).map(o => o[0]), [], "names not on the allow-list stay consequential whatever role the page gives them");
});
