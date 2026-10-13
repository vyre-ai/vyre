// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePath, expandPaths, fieldTree, LinkError, MAX_HOPS } from "./path.js";

const S = "spc_abcdefghijkl";
const u = (/** @type {string} */ type, /** @type {string} */ id) => `vyre://${S}/${type}/${id}`;
const link = (/** @type {string} */ type, /** @type {string} */ id) => ({ urn: u(type, id) });
/** Records by "type/id"; a missing one is not readable by the caller. */
const rig = (/** @type {Record<string, any>} */ recs) => {
  const reads = /** @type {string[]} */ ([]);
  return { reads, o: { space: S, read: async (/** @type {string} */ t, /** @type {string} */ i) => { reads.push(`${t}/${i}`); return recs[`${t}/${i}`] ? { data: recs[`${t}/${i}`] } : null; } } };
};
const contact = { name: "Dana", spouse: link("contact", "b"), children: [link("contact", "c"), link("contact", "d")] };
const recs = {
  "contact/b": { name: "Sam", spouse: link("contact", "a"), mother: link("contact", "m"), ssn: { sealed: "ssn", ref: "r1", present: true } },
  "contact/c": { name: "Kit", employer: link("company", "x") },
  "contact/d": { name: "Lou" },
  "contact/m": { name: "Rae", father: link("contact", "f") },
  "contact/f": { name: "Gus", grandfather: link("contact", "g") },
  "contact/g": { name: "Old" },
  "company/x": { name: "Acme" },
};

test("one hop: a link field reads the linked record's field", async () => {
  const { o } = rig(recs);
  assert.equal(await resolvePath(contact, ["spouse", "name"], o, "contact"), "Sam");
  assert.equal(await resolvePath(contact, ["name"], o), "Dana", "no link, no read");
});

test("two hops, and a path that stops at a link gives the link", async () => {
  const { o } = rig(recs);
  assert.equal(await resolvePath(contact, ["spouse", "mother", "name"], o), "Rae");
  assert.deepEqual(await resolvePath(contact, ["spouse"], o), link("contact", "b"));
  assert.equal(await resolvePath(contact, ["spouse", "urn"], o), u("contact", "b"));
});

test("three links are the most: the fourth stops with a plain error that says what to do", async () => {
  const { o } = rig(recs);
  assert.equal(MAX_HOPS, 3);
  assert.equal(await resolvePath(contact, ["spouse", "mother", "father", "name"], o), "Gus");
  const e = await resolvePath(contact, ["spouse", "mother", "father", "grandfather", "name"], o).catch(x => x);
  assert.ok(e instanceof LinkError);
  assert.equal(e.code, "too_deep");
  assert.match(e.message, /at most 3 links/);
});

test("a many link gives a list; a number picks one", async () => {
  const { o } = rig(recs);
  assert.deepEqual(await resolvePath(contact, ["children", "name"], o), ["Kit", "Lou"]);
  assert.equal(await resolvePath(contact, ["children", "0", "name"], o), "Kit");
  assert.deepEqual(await resolvePath(contact, ["children", "employer", "name"], o), ["Acme"], "an item with nothing there is left out");
});

test("a linked record the caller cannot read stops the path with a plain error", async () => {
  const { o } = rig({ ...recs, "contact/b": undefined });
  const e = await resolvePath(contact, ["spouse", "name"], o, "contact").catch(x => x);
  assert.ok(e instanceof LinkError);
  assert.equal(e.code, "not_found");
  assert.match(e.message, /^contact.spouse: the contact it links to is not there, or is not yours to see$/);
});

test("a sealed value read through a link is its placeholder, never the value", async () => {
  const { o } = rig(recs);
  assert.equal(await resolvePath(contact, ["spouse", "ssn"], o), "[sealed: ssn]");
  const x = await expandPaths(contact, [["spouse", "ssn"]], o);
  assert.equal(x.spouse.ssn, "[sealed: ssn]");
  assert.ok(!JSON.stringify(x).includes("r1"), "not even the reference");
});

test("a missing link is undefined, and a link into another Space is not followed", async () => {
  const { o } = rig(recs);
  assert.equal(await resolvePath({ name: "Solo" }, ["spouse", "name"], o), undefined);
  const e = await resolvePath({ spouse: { urn: "vyre://spc_zzzzzzzzzzzz/contact/b" } }, ["spouse", "name"], o).catch(x => x);
  assert.match(e.message, /another Space/);
});

test("expandPaths lays the linked records into a copy, reading only what the paths need, each record once", async () => {
  const { o, reads } = rig(recs);
  const x = await expandPaths(contact, [["spouse", "name"], ["spouse", "mother", "name"], ["children", "name"]], o);
  assert.equal(x.spouse.name, "Sam");
  assert.equal(x.spouse.mother.name, "Rae");
  assert.deepEqual(x.children.map((/** @type {any} */ c) => c.name), ["Kit", "Lou"]);
  assert.equal(x.spouse.urn, u("contact", "b"));
  assert.deepEqual(contact.spouse, link("contact", "b"), "the record it was given is untouched");
  assert.deepEqual(reads.sort(), ["contact/b", "contact/c", "contact/d", "contact/m"]);
  assert.deepEqual(contact.children[0], link("contact", "c"));
});

test("fieldTree: an object's fields with each link's target nested, three links deep", () => {
  const types = [{ name: "contact", fields: [{ name: "name", kind: "text" }, { name: "spouse", kind: "link", to: "contact" }, { name: "kids", kind: "link", to: "contact", many: true }] }];
  const t = fieldTree(types, "contact");
  assert.deepEqual(t.map(f => f.name), ["name", "spouse", "kids"]);
  assert.equal(t[1].to, "contact");
  assert.equal(t[2].many, true);
  assert.equal(t[1].fields[1].fields[1].fields[1].fields, undefined, "stops after three");
  assert.deepEqual(fieldTree(types, "nothing"), []);
});
