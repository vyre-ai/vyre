import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { kitLibrary, kitFromLibrary } from "./library.js";

test("the library lists the Kit this build ships, with what it adds", () => {
  const lib = kitLibrary();
  const estate = lib.find((k) => k.id === "estate-planning");
  assert.ok(estate, "the estate Kit is on offer");
  assert.ok(estate.description.length > 20 && estate.version >= 1);
  assert.deepEqual(estate.adds.types.sort(), ["contact", "matter"]);
  assert.deepEqual(estate.adds.sealed_fields, ["contact.ssn"]);
  assert.equal(estate.adds.flows, 1);
});

test("a Kit from the library is in the kernel's form and a name outside the library is refused", () => {
  const k = kitFromLibrary("estate-planning");
  assert.equal(k.id, "estate-planning");
  assert.ok(k.version >= 1);
  assert.throws(() => kitFromLibrary("../x"), { code: "not_found" });
  assert.throws(() => kitFromLibrary("nope"), { code: "not_found" });
});

test("a Kit's views are stored with the type they show", () => {
  const k = kitFromLibrary("estate-planning");
  const matter = k.includes.types.find((t) => t.name === "matter");
  assert.deepEqual(matter.views, [{ name: "matters_board", type: "board", label: "Matters by stage", groupBy: "stage", columns: ["title", "client", "plan", "fee"] }]);
  assert.equal(k.includes.types.find((t) => t.name === "contact").views, undefined);
  assert.equal(k.includes.views.length, 1, "the Kit's own view list stays for the install card");
});

test("the base Kit ships: Contact, Lead, Appointment, Client, Subscriber and Project, with roles linked to the contact and practice area a choice", () => {
  const lib = kitLibrary();
  const base = lib.find((k) => k.id === "base");
  assert.ok(base, "the base Kit is on offer");
  assert.deepEqual(base.adds.types, ["contact", "lead", "appointment", "client", "subscriber", "project"]);
  const k = kitFromLibrary("base");
  const t = (n) => k.includes.types.find((x) => x.name === n);
  for (const r of ["lead", "client", "subscriber"]) {
    assert.equal(t(r).role.link, "contact", `${r} is a role held by a contact`);
    const link = t(r).fields.find((f) => f.name === "contact");
    assert.deepEqual([link.kind, link.to, link.required], ["link", "contact", true]);
  }
  for (const n of ["lead", "appointment", "client", "project"]) {
    const f = t(n).fields.find((x) => x.name === "practice_area");
    assert.equal(f.kind, "choice", `${n}.practice_area is a choice`);
    assert.ok(f.options.includes("Personal Injury") && f.options.includes("Estate Planning"));
  }
  assert.equal(t("project").kind, "project");
  assert.equal(t("project").stage_sets, undefined, "the base Kit is generic: per-area stages are the Law firm Kit's");
  assert.equal(t("project").fields.find((f) => f.name === "accident_date"), undefined);
  assert.deepEqual(k.includes.types.filter((x) => x.views).map((x) => [x.name, x.views.map((v) => v.type)]), [["lead", ["board"]], ["appointment", ["calendar"]], ["client", ["list"]], ["project", ["board"]]]);
});

test("the Law firm Kit adds per-area stages and the fields that apply to one area, on the same Project", () => {
  assert.ok(kitLibrary().find((k) => k.id === "law-firm"));
  const p = kitFromLibrary("law-firm").includes.types.find((x) => x.name === "project");
  assert.deepEqual(p.stage_sets.map((s) => s.name), ["personal_injury", "estate_planning"]);
  assert.equal(p.fields.find((f) => f.name === "accident_date").required_if, 'practice_area == "Personal Injury"');
  assert.equal(p.views.length, 1, "the base board is kept when the type is replaced");
  const base = kitFromLibrary("base").includes.types.find((x) => x.name === "project");
  for (const f of base.fields) assert.ok(p.fields.some((x) => x.name === f.name), `${f.name} is still there`);
});
