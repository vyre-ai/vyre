// reviewer-2 repro HD-6b against work/kernel-declare a5ddff27b (drop into modules/hands-chrome/): the allow-list still trusts two things the PAGE controls, the role and the words around an allowed verb.
import test from "node:test";
import assert from "node:assert/strict";
import { of } from "./consequence.js";

test("HD-6b: a page cannot make a consequential control observable by giving it a passive role or an allowed verb in its name", () => {
  const cases = [
    { name: "Authorize", role: "tab" }, { name: "Allow all access", role: "option" }, { name: "Accept and continue", role: "row" },
    { name: "Open Authorize app" }, { name: "Show Allow access" }, { name: "View Accept terms" }, { name: "Select Continue to grant access" }, { name: "Next: Authorize" },
  ];
  const out = cases.map(c => ({ ...c, consequential: of(c).consequential }));
  console.log("HD-6b", JSON.stringify(out.map(o => [o.name, o.role || "-", o.consequential])));
  assert.deepEqual(out.filter(o => !o.consequential).map(o => o.name), [], "these must all be consequential");
});
