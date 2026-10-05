import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { groupsOf, matches, recordGroup, routeFor } from "./search-model.js";

const world = { types: [{ name: "contact", label: "Contact" }, { name: "def-x", label: "Def" }, { name: "matter", label: "Matter" }],
  byType: { contact: [{ urn: "vyre://s/contact/c1", id: "c1", data: { name: "Jane Doe", email: "jane@harlow.test", ssn: { sealed: "SSN" } } }], "def-x": [{ id: "d", data: { name: "Jane" } }], matter: [{ urn: "vyre://s/matter/m1", id: "m1", data: { title: "Doe estate plan" } }] } };
const titleOf = (d, r) => String(r.data.name ?? r.data.title ?? r.id);

test("every word typed must be in the record's plain text, and a sealed value is never read", () => {
  assert.ok(matches(world.byType.contact[0], "jane harlow"));
  assert.ok(!matches(world.byType.contact[0], "jane smith"));
  assert.ok(!matches({ data: { ssn: { sealed: "123-45" } } }, "123"));
  assert.ok(!matches(world.byType.contact[0], "  "));
});

test("the record group lists matches across the person's own types, with the type as the hint, and skips internal types", () => {
  const g = recordGroup(world, "doe", titleOf);
  assert.deepEqual(g.items.map((i) => [i.name, i.hint]), [["Jane Doe", "Contact"], ["Doe estate plan", "Matter"]]);
  assert.equal(recordGroup(world, "zzz", titleOf), null);
  assert.equal(recordGroup(null, "doe", titleOf), null);
});

test("a result opens where it belongs", () => {
  assert.equal(routeFor("record", "vyre://s/contact/c1"), "/u/record/c1");
  assert.equal(routeFor("session", "t9"), "/session/t9");
  assert.equal(routeFor("vault", "x"), "/u/vault");
  assert.equal(routeFor("github", "x"), null);
});

test("the box's groups come through without anything but id, name and hint", () => {
  const gs = groupsOf({ groups: [{ kind: "drive", label: "Files", items: [{ id: "f1", name: "plan.pdf", hint: "Drive", secret: "no" }] }, { kind: "empty", items: [] }] });
  assert.deepEqual(gs, [{ kind: "drive", label: "Files", items: [{ id: "f1", name: "plan.pdf", hint: "Drive" }] }]);
});
