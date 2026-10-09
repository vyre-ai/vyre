// @ts-check
// The kits and the field picker: the LinkedIn recipe is complete and safe by construction, a plan comes out in order, and a wanted field is found by its word wherever it sits.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { KITS, LINKEDIN_KIT, kitFor, teachPlan } from "./kits/linkedin.js";
import { suggestPick } from "./pickfields.js";
import { parseOperation } from "./spec.js";
import { settingsOf } from "../../core/connectors/governor.js";
import { classify } from "./classify.js";

test("the LinkedIn kit is the flagship set: profile, company, search, inbox to read; message and connection request to send; every send is a send", () => {
  assert.deepEqual(LINKEDIN_KIT.operations.map(o => [o.name, o.kind]), [["readProfile", "read"], ["readCompany", "read"], ["searchPeople", "read"], ["readInbox", "read"], ["sendMessage", "send"], ["sendConnectionRequest", "send"]]);
  for (const o of LINKEDIN_KIT.operations) {
    assert.ok(/^[a-z][A-Za-z0-9_]{0,63}$/.test(o.name) && ["read", "send"].includes(o.kind));
    assert.ok(o.trigger.url.startsWith(LINKEDIN_KIT.origins[0]), `${o.name} is taught from the site's own page`);
    for (const i of o.inputs) assert.ok(new RegExp(`^(?:${i.pattern})$`).test(["slug", "to"].includes(i.name) ? "ada-lovelace-3k" : i.name === "keywords" ? "estate planning" : "a message long enough"), `${o.name}.${i.name}'s pattern accepts a normal value`);
    // an operation is valid as the spec reads it once it has a request; the recipe's names and kinds are what the spec checks first
    assert.ok(parseOperation({ name: o.name, kind: o.kind, request: { method: "GET", url: LINKEDIN_KIT.origins[0] }, trigger: { url: o.trigger.url } }).ok, o.name);
  }
  assert.equal(settingsOf("www.linkedin.com", {}) === null, false, "the account governor applies to this site by default");
  assert.match(LINKEDIN_KIT.note, /against LinkedIn's terms/);
  assert.match(LINKEDIN_KIT.note, /held for your yes/);
});

test("a kit is found by its origin or name, and the teaching plan lists each operation in order with the call to make", () => {
  assert.equal(kitFor("https://www.linkedin.com"), LINKEDIN_KIT);
  assert.equal(kitFor("linkedin"), LINKEDIN_KIT);
  assert.equal(kitFor("https://www.linkedin.com/in/x"), LINKEDIN_KIT);
  assert.equal(kitFor("https://app.example.com"), null);
  assert.ok(KITS.linkedin);
  const plan = teachPlan(LINKEDIN_KIT);
  assert.deepEqual(plan.map(p => p.step), [1, 2, 3, 4, 5, 6]);
  assert.equal(plan[0].learn.action, "learn"); assert.equal(plan[0].learn.site, "https://www.linkedin.com");
  assert.match(plan[3].learn.examples, /pass the scout's request id/);
  assert.match(plan[4].then, /kept without being run/);
});

test("wanted fields are found by their word wherever they sit in the answer, the shallowest first; one that is not there is named, not guessed", () => {
  const answer = { data: { elements: [{ first_name: "Ada", last_name: "Lovelace", location: { name: "Sacramento" }, headline: "Attorney", deep: { headline: "NOT THIS" }, tags: ["a"] }] } };
  const r = suggestPick(answer, ["firstName", "lastName", "headline", "name", "salary"], { extract: "data.elements" });
  assert.deepEqual(r.pick, ["firstName=first_name", "lastName=last_name", "headline", "name=location.name"]);
  assert.deepEqual(r.missing, ["salary"]);
  assert.equal(r.at.headline, "headline");
  assert.deepEqual(suggestPick({ a: 1 }, ["b"]).missing, ["b"]);
});

test("a read that gets 'not found' for one thing is the input's fault, even when the thing is in the query", () => {
  const o = /** @type {any} */ (parseOperation({ name: "readProfile", kind: "read", request: { method: "GET", url: "https://s.test/api?q=" }, trigger: { url: "https://s.test/x" }, slots: [{ param: "slug", at: ["query:q"] }], params: [{ name: "slug" }], response: { format: "json" } }));
  const c = classify(o.op, { status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 404, message: "Profile not found" }) });
  assert.equal(c.class, "input");
  assert.equal(classify(o.op, { status: 404, headers: {}, body: "<html>gone</html>" }).class, "drift", "an unexplained 404 on a templated address is still ambiguous");
});
