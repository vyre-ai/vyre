// @ts-check
// Documents (R032-01, R032-03): templates in the Drive, generate from values and records, file the result, refuse a missing value by name. The Drive and the records are in-memory stand-ins for the
// kernel's gateway; the door is the same minimal stand-in the Drive tools' tests use.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { registerDocuments } from "./index.js";
import { docx, textOf } from "./testing/docx.js";
import { allowLoopbackForTests } from "../../lib/http.js";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };

function rig({ chain = /** @type {any} */ (person), types = ["document"], records = /** @type {Record<string, any>} */ ({}), config = {} } = {}) {
  /** @type {Map<string, Buffer[]>} */ const files = new Map();
  const made = /** @type {any[]} */ ([]);
  const gateway = {
    drive: {
      async put(_c, p, bytes) { const v = files.get(p) || []; v.push(Buffer.from(bytes)); files.set(p, v); return { version: v.length, conflict: false }; },
      async get(_c, p, o) { const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return new Uint8Array(v[(o && o.version ? o.version : v.length) - 1]); },
      async history(_c, p) { const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return v.map((b, i) => ({ ver: i + 1, size: b.length })); },
      async listPage(_c, prefix) { return { entries: [...files.keys()].filter(k => k.startsWith(prefix)).map(k => ({ path: k, size: files.get(k)?.at(-1)?.length })), next: null }; },
    },
    async definitions() { return types.map(n => ({ name: n, fields: [{ name: "name" }, { name: "status" }, { name: "template" }, { name: "template_version" }, { name: "file" }, { name: "contact" }, { name: "project" }, { name: "sha256" }, { name: "source" }] })); },
    records: { async get(_c, type, id) { return records[`${type}/${id}`] || null; }, async create(_c, type, data) { made.push({ type, data }); return { urn: `${SPACE}/${type}/rec${made.length}` }; } },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const ctx = { config, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call: async () => ({}), log: () => {},
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway, surfaces: {} }), chainIn: async () => { if (!chain) throw Object.assign(new Error("x"), { code: "denied" }); return chain; } } };
  registerDocuments(ctx);
  const run = (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta);
  return { run, files, made, tools };
}
const b64 = (/** @type {Buffer} */ b) => b.toString("base64");
const LETTER = () => docx(["Dear {client.name},", "Your fee is {matter.fee}.", "{#fees}{label} {amount}; {/fees}"]);
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e);

test("a template is added to the Drive, a new version when the name is used again, and lists with what it asks for", async () => {
  const r = rig();
  const a = await r.run("documents.template.add", { name: "Engagement letter", base64: b64(LETTER()) });
  assert.deepEqual([a.name, a.version, a.placeholders.sort(), a.loops], ["Engagement letter", 1, ["client.name", "matter.fee"], ["fees"]]);
  assert.equal((await r.run("documents.template.add", { name: "Engagement letter", base64: b64(LETTER()) })).version, 2);
  assert.deepEqual((await r.run("documents.template.list", {})).templates.map((/** @type {any} */ t) => t.name), ["Engagement letter"]);
  const g = await r.run("documents.template.get", { name: "Engagement letter", version: 1 });
  assert.equal(g.version, 1);
  assert.equal((await code(r.run("documents.template.get", { name: "Nothing" }))).code, "not_found");
  for (const bad of ["../x", "", "a/b", " x"]) assert.equal((await code(r.run("documents.template.add", { name: bad, base64: b64(LETTER()) }))).code, "bad_input", bad);
  assert.equal((await code(r.run("documents.template.add", { name: "x", base64: b64(Buffer.from("not a docx")) }))).code, "bad_template");
});

test("generate fills the template from values and a record, files it in the Drive and as a Document record", async () => {
  const r = rig({ records: { "client/c1": { data: { name: "Dana Harlow" } } } });
  await r.run("documents.template.add", { name: "Letter", base64: b64(LETTER()) });
  const out = await r.run("documents.generate", { template: "Letter", records: { client: `${SPACE}/client/c1` }, values: { matter: { fee: 1500 }, fees: [{ label: "filing", amount: 100 }] }, project: "Harlow estate", contact: `${SPACE}/contact/k1` });
  assert.match(out.path, /^Documents\/harlow-estate\/letter-[0-9a-f]{8}\.docx$/);
  assert.equal(out.template_version, 1);
  assert.equal(out.sha256, crypto.createHash("sha256").update(r.files.get(out.path)[0]).digest("hex"));
  assert.deepEqual(textOf(r.files.get(out.path)[0]), ["Dear Dana Harlow,", "Your fee is 1500.", "filing 100; "]);
  assert.equal(r.made.length, 1);
  assert.deepEqual([r.made[0].type, r.made[0].data.name, r.made[0].data.template, r.made[0].data.template_version, r.made[0].data.file, r.made[0].data.contact, r.made[0].data.project, r.made[0].data.source],
    ["document", "Letter", "Letter", 1, out.path, `${SPACE}/contact/k1`, "Harlow estate", "generated"]);
  assert.ok(out.record);
  // the same inputs file the same bytes at the same path: a second run is the same document, not a second file
  const again = await r.run("documents.generate", { template: "Letter", records: { client: `${SPACE}/client/c1` }, values: { matter: { fee: 1500 }, fees: [{ label: "filing", amount: 100 }] }, project: "Harlow estate" });
  assert.equal(again.sha256, out.sha256);
  assert.equal(again.path, out.path);
});

test("a template with one missing field refuses with its name, and nothing is filed", async () => {
  const r = rig({ records: { "client/c1": { data: { name: "Dana Harlow" } } } });
  await r.run("documents.template.add", { name: "Letter", base64: b64(LETTER()) });
  const e = await code(r.run("documents.generate", { template: "Letter", records: { client: `${SPACE}/client/c1` }, values: { fees: [] } }));
  assert.equal(e.code, "missing_values");
  assert.match(e.message, /matter\.fee/);
  assert.deepEqual([...r.files.keys()], ["Templates/Letter.docx"], "no document file");
  assert.equal(r.made.length, 0, "no record");
});

test("a record the caller cannot see is said, not guessed; the Space with no Document type still files the file", async () => {
  const r = rig({ types: [] });
  await r.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  const e = await code(r.run("documents.generate", { template: "Letter", records: { who: `${SPACE}/client/gone` } }));
  assert.equal(e.code, "not_found");
  assert.equal((await code(r.run("documents.generate", { template: "Letter", records: { "bad alias": `${SPACE}/client/c1` } }))).code, "bad_input");
  assert.equal((await code(r.run("documents.generate", { template: "Letter", records: { who: "nonsense" } }))).code, "bad_input");
  const ok = await r.run("documents.generate", { template: "Letter", values: { who: "Dana" } });
  assert.equal(ok.record, null);
  assert.match(ok.note, /install Documents/);
  assert.ok(r.files.has(ok.path));
});

test("a call that proved no person is refused before anything is read", async () => {
  const r = rig({ chain: null });
  assert.equal((await code(r.run("documents.template.list", {}))).code, "denied");
  assert.equal((await code(r.run("documents.generate", { template: "Letter" }))).code, "denied");
});

test("a PDF needs the converter: refused in plain words without one, filed as a PDF with one", async t => {
  const none = rig();
  await none.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  const e = await code(none.run("documents.generate", { template: "Letter", values: { who: "Dana" }, format: "pdf" }));
  assert.equal(e.code, "no_pdf_engine");
  assert.equal([...none.files.keys()].length, 1, "nothing filed");
  allowLoopbackForTests(true);
  /** @type {any[]} */ const seen = [];
  const srv = http.createServer((req, res) => { const chunks = []; req.on("data", c => chunks.push(c)); req.on("end", () => { seen.push({ url: req.url, type: req.headers["content-type"], body: Buffer.concat(chunks) }); res.writeHead(200, { "content-type": "application/pdf" }); res.end(Buffer.from("%PDF-1.7 fake")); }); });
  await new Promise(r => srv.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { srv.close(); allowLoopbackForTests(false); });
  const w = rig({ config: { documents: { pdf: `http://127.0.0.1:${/** @type {any} */ (srv.address()).port}` } } });
  await w.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  const out = await w.run("documents.generate", { template: "Letter", values: { who: "Dana" }, format: "pdf" });
  assert.match(out.path, /\.pdf$/);
  assert.equal(seen[0].url, "/forms/libreoffice/convert");
  assert.match(seen[0].type, /^multipart\/form-data; boundary=/);
  assert.ok(seen[0].body.includes("Hello Dana") === false, "the converter gets the zipped .docx, not text");
  assert.equal(w.files.get(out.path)[0].subarray(0, 4).toString(), "%PDF");
});
