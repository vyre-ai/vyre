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

function rig({ chain = /** @type {any} */ (person), types = ["document"], records = /** @type {Record<string, any>} */ ({}), config = {}, call = /** @type {(tool: string, input: any) => Promise<any>} */ (async () => ({})) } = {}) {
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
    records: { async get(_c, type, id) { return records[`${type}/${id}`] || null; }, async create(_c, type, data) { made.push({ type, data }); return { urn: `vyre://${SPACE}/${type}/rec${made.length}` }; } },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const emitted = /** @type {{ type: string, payload: any }[]} */ ([]);
  const ctx = { config, events: { emit: (/** @type {string} */ type, /** @type {any} */ payload) => { emitted.push({ type, payload }); } }, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call, log: () => {},
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway, surfaces: {} }), chainIn: async () => { if (!chain) throw Object.assign(new Error("x"), { code: "denied" }); return chain; } } };
  registerDocuments(ctx);
  const run = (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta);
  return { run, files, made, tools, emitted };
}
const b64 = (/** @type {Buffer} */ b) => b.toString("base64");
const LETTER = () => docx(["Dear {client.name},", "Your fee is {matter.fee}.", "{#fees}{label} {amount}; {/fees}"]);
const code = (/** @type {Promise<any>} */ p) => p.then(() => null, e => e);

test("a template is added to the Drive, a new version when the name is used again, and lists with what it asks for", async () => {
  const r = rig();
  const a = await r.run("documents.template.add", { name: "Engagement letter", base64: b64(LETTER()) });
  assert.deepEqual([a.name, a.version, a.placeholders.sort(), a.loops, a.loopFields], ["Engagement letter", 1, ["client.name", "matter.fee"], ["fees"], { fees: ["label", "amount"] }]);
  assert.equal((await r.run("documents.template.add", { name: "Engagement letter", base64: b64(LETTER()) })).version, 2);
  assert.deepEqual((await r.run("documents.template.list", {})).templates.map((/** @type {any} */ t) => t.name), ["Engagement letter"]);
  const g = await r.run("documents.template.get", { name: "Engagement letter", version: 1 });
  assert.equal(g.version, 1);
  assert.equal((await code(r.run("documents.template.get", { name: "Nothing" }))).code, "not_found");
  for (const bad of ["../x", "", "a/b", ".hidden", "x".repeat(90)]) assert.equal((await code(r.run("documents.template.add", { name: bad, base64: b64(LETTER()) }))).code, "bad_input", bad);
  assert.equal((await code(r.run("documents.template.add", { name: "x", base64: b64(Buffer.from("not a docx")) }))).code, "bad_template");
});

test("generate fills the template from values and a record, files it in the Drive and as a Document record", async () => {
  const r = rig({ records: { "client/c1": { data: { name: "Dana Harlow" } } } });
  await r.run("documents.template.add", { name: "Letter", base64: b64(LETTER()) });
  const out = await r.run("documents.generate", { template: "Letter", records: { client: `vyre://${SPACE}/client/c1` }, values: { matter: { fee: 1500 }, fees: [{ label: "filing", amount: 100 }] }, project: "Harlow estate", contact: `vyre://${SPACE}/contact/k1` });
  assert.match(out.path, /^Documents\/harlow-estate\/letter-[0-9a-f]{8}\.docx$/);
  assert.equal(out.template_version, 1);
  assert.equal(out.sha256, crypto.createHash("sha256").update(r.files.get(out.path)[0]).digest("hex"));
  assert.deepEqual(textOf(r.files.get(out.path)[0]), ["Dear Dana Harlow,", "Your fee is 1500.", "filing 100; "]);
  assert.equal(r.made.length, 1);
  assert.deepEqual(r.emitted.map(e => e.type), ["documents.generated"], "the timeline hears of the new document");
  assert.equal(r.emitted[0].payload.path, out.path);
  assert.deepEqual([r.made[0].type, r.made[0].data.name, r.made[0].data.template, r.made[0].data.template_version, r.made[0].data.file, r.made[0].data.contact, r.made[0].data.project, r.made[0].data.source],
    ["document", "Letter", "Letter", 1, out.path, `vyre://${SPACE}/contact/k1`, "Harlow estate", "generated"]);
  assert.ok(out.record);
  // the same inputs file the same bytes at the same path: a second run is the same document, not a second file
  const again = await r.run("documents.generate", { template: "Letter", records: { client: `vyre://${SPACE}/client/c1` }, values: { matter: { fee: 1500 }, fees: [{ label: "filing", amount: 100 }] }, project: "Harlow estate" });
  assert.equal(again.sha256, out.sha256);
  assert.equal(again.path, out.path);
});

test("a template with one missing field refuses with its name, and nothing is filed", async () => {
  const r = rig({ records: { "client/c1": { data: { name: "Dana Harlow" } } } });
  await r.run("documents.template.add", { name: "Letter", base64: b64(LETTER()) });
  const e = await code(r.run("documents.generate", { template: "Letter", records: { client: `vyre://${SPACE}/client/c1` }, values: { fees: [] } }));
  assert.equal(e.code, "missing_values");
  assert.match(e.message, /matter\.fee/);
  assert.deepEqual([...r.files.keys()], ["Templates/Letter.docx"], "no document file");
  assert.equal(r.made.length, 0, "no record");
});

test("a record the caller cannot see is said, not guessed; the Space with no Document type still files the file", async () => {
  const r = rig({ types: [] });
  await r.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  const e = await code(r.run("documents.generate", { template: "Letter", records: { who: `vyre://${SPACE}/client/gone` } }));
  assert.equal(e.code, "not_found");
  assert.equal((await code(r.run("documents.generate", { template: "Letter", records: { "bad alias": `vyre://${SPACE}/client/c1` } }))).code, "bad_input");
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

test("the signing Flow comes back ready to define, and a bad ask is said", async () => {
  const r = rig();
  const out = await r.run("documents.signing.flow", { type: "matter", out_stage: "Out for signature", signed_stage: "Signed", template_id: 12 });
  assert.deepEqual(out.flow.trigger, { on: "stage", type: "matter", stage: "Out for signature" });
  assert.equal(out.flow.steps.at(-1).id, "once");
  assert.equal((await code(r.run("documents.signing.flow", { type: "matter", out_stage: "A", signed_stage: "B", template_id: 0 }))).code, "bad_input");
});

test("a link to the signed copy: the person's chain is needed, the slug is checked, and the app's own module makes it", async () => {
  const r = rig();
  const asked = [];
  r.tools.get("documents.signed-link");
  const ctx2 = null; void ctx2;
  assert.equal((await code(r.run("documents.signed-link", { slug: "../x" }))).code, "bad_input");
  const none = rig({ chain: null });
  assert.equal((await code(none.run("documents.signed-link", { slug: "abc123" }))).code, "denied");
  void asked;
});

test("documents.send makes the signing request and emails the link in one act; a refusal from either is passed on in its own words", async () => {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const r = rig({ call: async (tool, input) => {
    if (tool === "spaces.self") return {}; // the door's own lookup
    seen.push({ tool, input });
    if (tool === "appmods.signing.request") return { data: { submission: 4411, slug: "abc123", url: "https://documents.harlow.vyre.run/sign/4411/abc123" } };
    return { data: { held: "gi_1", via: "email" } };
  } });
  const out = await r.run("documents.send", { template_id: 12, email: "dana@harlow.test", signer: "Dana Harlow" });
  assert.deepEqual(seen.map(s => s.tool), ["appmods.signing.request", "comms.send"], "the request first, then the email that carries its link");
  assert.deepEqual(seen[0].input, { name: "documents", template_id: 12, email: "dana@harlow.test", signer: "Dana Harlow" });
  assert.deepEqual(seen[1].input, { via: "email", to: "dana@harlow.test", subject: "Your document is ready to sign", body: "Your document is ready to sign: https://documents.harlow.vyre.run/sign/4411/abc123", why: "signing request" });
  assert.equal(out.submission, 4411); assert.equal(out.slug, "abc123"); assert.equal(out.sent.held, "gi_1");
  assert.deepEqual(r.emitted, [{ type: "documents.sent", payload: { submission: 4411, template_id: 12 } }], "the timeline hears of it, without the signer's code");
  seen.length = 0;
  await r.run("documents.send", { template_id: 12, email: "dana@harlow.test", note: "Dana, here is the engagement letter we discussed." });
  assert.equal(seen[1].input.body, "Dana, here is the engagement letter we discussed.\n\nYour document is ready to sign: https://documents.harlow.vyre.run/sign/4411/abc123", "a note goes first, the link after");
  assert.equal((await code(r.run("documents.send", { template_id: 12, email: "dana@harlow.test", note: "x".repeat(1001) }))).code, "bad_input");
  assert.equal((await code(r.run("documents.send", { template_id: 12, email: " " }))).code, "bad_input");
  const none = rig({ chain: null });
  assert.equal((await code(none.run("documents.send", { template_id: 12, email: "dana@harlow.test" }))).code, "denied");
  const down = rig({ call: async tool => (tool === "spaces.self" ? {} : tool === "appmods.signing.request" ? { error: { code: "not_found", message: "that app is not running" } } : { data: {} }) });
  const e = await code(down.run("documents.send", { template_id: 12, email: "dana@harlow.test" }));
  assert.equal(e.code, "unavailable"); assert.match(e.message, /install or start it from Apps/, "and a missing app says what to do");
});

test("documents.send-signed makes the expiring link and emails it; the slug is checked before anything is made", async () => {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const r = rig({ call: async (tool, input) => {
    if (tool === "spaces.self") return {};
    seen.push({ tool, input });
    return tool === "appmods.signed.link" ? { data: { url: "https://documents.harlow.vyre.run/signed/1.abc.sig", expires: Date.now() + 30 * 86_400_000 } } : { data: { held: "gi_2" } };
  } });
  const out = await r.run("documents.send-signed", { slug: "abc123", email: "dana@harlow.test" });
  assert.deepEqual(seen.map(s => s.tool), ["appmods.signed.link", "comms.send"]);
  assert.equal(seen[1].input.subject, "Your signed copy");
  assert.match(seen[1].input.body, /works for 30 days.*signed\/1\.abc\.sig$/);
  assert.equal(out.sent.held, "gi_2");
  assert.deepEqual(r.emitted, [{ type: "documents.copy-sent", payload: { days: 30 } }]);
  const before = seen.length;
  assert.equal((await code(r.run("documents.send-signed", { slug: "../x", email: "dana@harlow.test" }))).code, "bad_input");
  assert.equal(seen.length, before, "nothing was made for a bad slug");
});

test("one yes: the card for documents.send rides down to the mail module's own send, and a tool that is not named is held as ever", async () => {
  const { coveredRide } = await import("../modules/index.js");
  const { COVERED } = await import("../../lib/covered.js");
  const { readFileSync } = await import("node:fs");
  const declared = (/** @type {string} */ dir) => JSON.parse(readFileSync(new URL(`../${dir}/module.json`, import.meta.url), "utf8")).does.tools.filter((/** @type {any} */ t) => typeof t === "object");
  const tools = new Map([...declared("documents"), ...declared("comms"), ...declared("mail")].map(t => [t.name, { covers: t.covers || [] }]));
  const card = { card: "ap_1", tool: "documents.send", input_sha256: "x", asker: "mcp>agent" };
  const meta = (/** @type {any} */ mark) => ({ [COVERED]: mark });
  const toComms = coveredRide(tools, meta(card), "comms.send", "module:documents");
  assert.ok(toComms && toComms.via.includes("comms"), "documents.send names comms.send, so the email rides the card");
  const toMail = coveredRide(tools, meta(toComms), "mail.send", "module:comms");
  assert.ok(toMail && toMail.via.includes("mail"), "and comms.send's own mail.send rides it too");
  // a Gmail account is one hop further (mail.send files google.mail.send, which files the send at the Gate) and an MCP account goes through mcp.call: the card names them, so the Gate sees a mark its caller may present
  const toGoogle = coveredRide(tools, meta(toMail), "google.mail.send", "module:mail");
  assert.ok(toGoogle && toGoogle.via.includes("google"), "a Gmail account's send rides the same card");
  const toMcp = coveredRide(tools, meta(toMail), "mcp.call", "module:mail");
  assert.ok(toMcp && toMcp.via.includes("mcp"), "and so does a mail account reached through MCP");
  const direct = { ...card, tool: "mail.send" };
  assert.ok(coveredRide(tools, meta(direct), "google.mail.send", "module:mail"), "a card for mail.send itself carries its Gmail hop");
  assert.equal(coveredRide(tools, meta(card), "mail.send", "module:billing"), null, "another module's send is not the same act");
  assert.equal(coveredRide(tools, meta(card), "documents.signed-link", "module:documents"), null, "a tool the card does not name is held as its own card");
  const signed = { ...card, tool: "documents.send-signed" };
  assert.ok(coveredRide(tools, meta(signed), "comms.send", "module:documents"));
  assert.equal(coveredRide(tools, meta(signed), "appmods.signing.request", "module:documents"), null);
});

test("an agent sees lean tool descriptions, and documents.generate is held to the projects the agent is granted", async () => {
  const { readFileSync } = await import("node:fs");
  const r = rig();
  for (const [name, def] of r.tools) assert.ok(String(def.description).trim().split(/\s+/).length <= 25, `${name} is over the 25-word cap`);
  const manifest = JSON.parse(readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const entry = manifest.does.tools.find((/** @type {any} */ t) => t && t.name === "documents.generate");
  assert.equal(entry.projectArg, "project");
});
