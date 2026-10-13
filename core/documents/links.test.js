// @ts-check
// Documents through links: {contact.spouse.name} reads the linked record under the caller's own chain.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerDocuments } from "./index.js";
import { docx, textOf } from "./testing/docx.js";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };
const lk = (/** @type {string} */ id) => ({ urn: `vyre://${SPACE}/contact/${id}` });

function rig(/** @type {Record<string, any>} */ records) {
  /** @type {Map<string, Buffer[]>} */ const files = new Map();
  const gateway = {
    drive: {
      async put(_c, p, bytes) { const v = files.get(p) || []; v.push(Buffer.from(bytes)); files.set(p, v); return { version: v.length, conflict: false }; },
      async get(_c, p) { const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return new Uint8Array(v[v.length - 1]); },
      async history(_c, p) { const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return v.map((b, i) => ({ ver: i + 1, size: b.length })); },
    },
    async definitions() { return []; },
    records: { async get(_c, type, id) { return records[`${type}/${id}`] ? { data: records[`${type}/${id}`] } : null; }, async create() { return null; } },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { config: {}, events: { emit: () => {} }, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({}), log: () => {},
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway, surfaces: {} }), chainIn: async () => person } };
  registerDocuments(ctx);
  const run = (/** @type {string} */ n, /** @type {any} */ i) => tools.get(n).run(i, { caller: "cli" });
  return { run, files };
}
const b64 = (/** @type {Buffer} */ b) => b.toString("base64");
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e);
const RECS = {
  "contact/a": { name: "Dana", spouse: lk("b"), children: [lk("c"), lk("d")] },
  "contact/b": { name: "Sam", ssn: { sealed: "ssn", ref: "r1", present: true }, mother: lk("m") },
  "contact/c": { name: "Kit" }, "contact/d": { name: "Lou" }, "contact/m": { name: "Rae" },
  "contact/n": { name: "Solo" },
  "contact/x": { name: "Ghost", spouse: lk("gone") },
};
const gen = async (/** @type {ReturnType<typeof rig>} */ r, /** @type {string[]} */ lines, /** @type {string} */ id) => {
  await r.run("documents.template.add", { name: "T", base64: b64(docx(lines)) });
  const out = await r.run("documents.generate", { template: "T", records: { contact: `vyre://${SPACE}/contact/${id}` } });
  return textOf(r.files.get(out.path)[0]);
};

test("one hop and two hops fill from the linked records", async () => {
  const r = rig(RECS);
  assert.deepEqual(await gen(r, ["{contact.name} and {contact.spouse.name}, whose mother is {contact.spouse.mother.name}."], "a"), ["Dana and Sam, whose mother is Rae."]);
});

test("a loop over a many link repeats once per linked record", async () => {
  const r = rig(RECS);
  assert.deepEqual(await gen(r, ["{#contact.children}{name}; {/contact.children}"], "a"), ["Kit; Lou; "]);
});

test("a sealed value through a link is the placeholder, never the value", async () => {
  const r = rig(RECS);
  const text = await gen(r, ["SSN {contact.spouse.ssn}"], "a");
  assert.deepEqual(text, ["SSN [sealed: ssn]"]);
});

test("a linked record the caller cannot read stops the document and says so", async () => {
  const r = rig(RECS);
  await r.run("documents.template.add", { name: "T", base64: b64(docx(["{contact.spouse.name}"])) });
  const e = await code(r.run("documents.generate", { template: "T", records: { contact: `vyre://${SPACE}/contact/x` } }));
  assert.equal(e.code, "not_found");
  assert.match(e.message, /the document was not made: contact\.spouse: the contact it links to is not there, or is not yours to see/);
  assert.equal(r.files.size, 1, "only the template is in the Drive");
});

test("a missing link stops the document and names the value", async () => {
  const r = rig(RECS);
  await r.run("documents.template.add", { name: "T", base64: b64(docx(["{contact.spouse.name}"])) });
  const e = await code(r.run("documents.generate", { template: "T", records: { contact: `vyre://${SPACE}/contact/n` } }));
  assert.equal(e.code, "missing_values");
  assert.deepEqual(e.missing, ["contact.spouse.name"]);
});
