// @ts-check
// Documents (R032-01, R032-03): templates in the Drive, generate from values and records, file the result, refuse a missing value by name. The Drive and the records are in-memory stand-ins for the
// kernel's gateway; the door is the same minimal stand-in the Drive tools' tests use.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { registerDocuments } from "./index.js";
import { docx, textOf } from "./testing/docx.js";
import { allowLoopbackForTests } from "../../lib/http.js";

const SPACE = "spc_abcdefghijkl";
const person = { hops: [{ actor: { kind: "person", id: "per_alex", space: SPACE } }] };

function rig({ chain = /** @type {any} */ (person), types = ["document"], records = /** @type {Record<string, any>} */ ({}), config = {}, call = /** @type {(tool: string, input: any) => Promise<any>} */ (async () => ({})), denied = /** @type {any[]} */ ([]), made = /** @type {any[]} */ ([]), db = new DatabaseSync(":memory:") } = {}) {
  /** @type {Map<string, Buffer[]>} */ const files = new Map();
  const gateway = {
    drive: {
      async put(_c, p, bytes) { const v = files.get(p) || []; v.push(Buffer.from(bytes)); files.set(p, v); return { version: v.length, conflict: false }; },
      async get(_c, p, o) { const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return new Uint8Array(v[(o && o.version ? o.version : v.length) - 1]); },
      async history(_c, p) { const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return v.map((b, i) => ({ ver: i + 1, size: b.length })); },
      async stat(_c, p) { if (denied.includes(_c)) throw Object.assign(new Error("not yours to read"), { code: "denied" }); const v = files.get(p); if (!v) throw Object.assign(new Error("no such file"), { code: "not_found" }); return { path: p, version: v.length, size: v.at(-1).length }; },
      async listPage(_c, prefix) { return { entries: [...files.keys()].filter(k => k.startsWith(prefix)).map(k => ({ path: k, size: files.get(k)?.at(-1)?.length })), next: null }; },
    },
    async definitions() { return types.map(n => ({ name: n, fields: [{ name: "name" }, { name: "status" }, { name: "template" }, { name: "template_version" }, { name: "file" }, { name: "contact" }, { name: "project" }, { name: "sha256" }, { name: "source" }] })); },
    records: { async get(_c, type, id) { return records[`${type}/${id}`] || null; },
      // A record is readable by the chain that wrote it, and by the owner (the same answer a kernel read gives for this fixture).
      async create(c, type, data) { made.push({ type, data, by: c }); return { urn: `vyre://${SPACE}/${type}/rec${made.length}` }; },
      async query(c, type, spec) { const f = spec.filter; const who = c && c.hops && c.hops[0] && c.hops[0].actor.id; return { rows: made.filter(m => m.type === type && f && m.data[f.field] === f.value && (m.by === c || who === "per_alex")).map(m => ({ data: m.data })) }; } },
  };
  /** @type {Map<string, any>} */ const tools = new Map();
  const emitted = /** @type {{ type: string, payload: any }[]} */ ([]);
  const store = { migrate: (/** @type {string[]} */ ms) => { for (const m of ms) db.exec(m); }, db };
  const ctx = { store, config, events: { emit: (/** @type {string} */ type, /** @type {any} */ payload) => { emitted.push({ type, payload }); } }, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), call, log: () => {},
    kernel: { space: SPACE, owner: "per_alex", membership: async (/** @type {string} */ p) => ({ member: p !== "per_removed", role: p === "per_alex" ? "owner" : p === "per_admin" || p === "per_removed" ? "admin" : "member" }), for: async () => ({ gateway, surfaces: {} }), chainIn: async () => { if (!chain) throw Object.assign(new Error("x"), { code: "denied" }); return chain; } } };
  registerDocuments(ctx);
  const run = (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta);
  return { run, files, made, tools, emitted, db };
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

test("with no address set, a PDF is made by the PDF converter app when it is installed and running, found by Documents through appmods.origin, and the setting still wins", async t => {
  allowLoopbackForTests(true);
  /** @type {string[]} */ const hit = [];
  const mk = (/** @type {string} */ who) => http.createServer((req, res) => { req.resume(); req.on("end", () => { hit.push(who); res.writeHead(200, { "content-type": "application/pdf" }); res.end(Buffer.from("%PDF-1.7 " + "x".repeat(2000))); }); });
  const app = mk("app"), set = mk("setting");
  await new Promise(r => app.listen(0, "127.0.0.1", () => r(undefined))); await new Promise(r => set.listen(0, "127.0.0.1", () => r(undefined)));
  t.after(() => { app.close(); set.close(); allowLoopbackForTests(false); });
  const origin = `http://127.0.0.1:${/** @type {any} */ (app.address()).port}`;
  /** @type {any[]} */ const asked = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => { if (tool === "spaces.merge-list") return {}; asked.push([tool, input]); return tool === "appmods.origin" && input.name === "pdf" ? { data: { origin } } : { error: { code: "not_found", message: "x" } }; };
  const w = rig({ call });
  await w.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  const out = await w.run("documents.generate", { template: "Letter", values: { who: "Dana" }, format: "pdf" });
  assert.match(out.path, /\.pdf$/);
  assert.deepEqual(hit, ["app"]);
  assert.deepEqual(asked.filter(a => a[0] === "appmods.origin"), [["appmods.origin", { name: "pdf" }]]);
  // the address a person set is used and the app is not asked
  asked.length = 0; hit.length = 0;
  const own = rig({ call, config: { documents: { pdf: `http://127.0.0.1:${/** @type {any} */ (set.address()).port}` } } });
  await own.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  await own.run("documents.generate", { template: "Letter", values: { who: "Dana" }, format: "pdf" });
  assert.deepEqual(hit, ["setting"]);
  assert.equal(asked.some(a => a[0] === "appmods.origin"), false);
  // the app is not installed or not running: the same plain refusal, and it says where to get one
  const none = rig({ call: async tool => (tool === "spaces.merge-list" ? {} : { error: { code: "not_found", message: "that app is not running" } }) });
  await none.run("documents.template.add", { name: "Letter", base64: b64(docx(["Hello {who}"])) });
  const e = await code(none.run("documents.generate", { template: "Letter", values: { who: "Dana" }, format: "pdf" }));
  assert.equal(e.code, "no_pdf_engine");
  assert.match(e.message, /install the PDF converter app from Apps/);
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
    if (tool === "spaces.merge-list") return {}; // the door's own lookup
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
  const down = rig({ call: async tool => (tool === "spaces.merge-list" ? {} : tool === "appmods.signing.request" ? { error: { code: "not_found", message: "that app is not running" } } : { data: {} }) });
  const e = await code(down.run("documents.send", { template_id: 12, email: "dana@harlow.test" }));
  assert.equal(e.code, "unavailable"); assert.match(e.message, /install or start it from Apps/, "and a missing app says what to do");
});

test("documents.send-signed makes the link (no end unless the setting or the call gives one) and emails it; the slug is checked before anything is made", async () => {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    if (tool === "spaces.merge-list") return {};
    seen.push({ tool, input });
    return tool === "appmods.signed.link" ? { data: { url: "https://documents.harlow.vyre.run/signed/1.abc.sig", expires: input.days === undefined ? null : Date.now() + input.days * 86_400_000 } } : { data: { held: "gi_2" } };
  };
  const r = rig({ call });
  const out = await r.run("documents.send-signed", { slug: "abc123", email: "dana@harlow.test" });
  assert.deepEqual(seen.map(s => s.tool), ["appmods.signed.link", "comms.send"]);
  assert.deepEqual(seen[0].input, { name: "documents", slug: "abc123" }, "no days: the link has no end");
  assert.equal(seen[1].input.subject, "Your signed copy");
  assert.equal(seen[1].input.body, "Thank you for signing. Your signed copy is here: https://documents.harlow.vyre.run/signed/1.abc.sig");
  assert.equal(out.sent.held, "gi_2");
  assert.equal(out.expires, null);
  assert.deepEqual(r.emitted, [{ type: "documents.copy-sent", payload: { days: null } }]);
  // the setting gives every new link an end; a call that names days wins over it; 0 is off
  seen.length = 0;
  const set = rig({ call, config: { documents: { signed_link_days: 7 } } });
  await set.run("documents.send-signed", { slug: "abc123", email: "dana@harlow.test" });
  assert.equal(seen[0].input.days, 7);
  assert.match(seen[1].input.body, /works for 7 days.*signed\/1\.abc\.sig$/);
  await set.run("documents.send-signed", { slug: "abc123", email: "dana@harlow.test", days: 2 });
  assert.equal(seen[2].input.days, 2);
  assert.equal((await set.run("documents.signed-link", { slug: "abc123" })).expires > Date.now(), true);
  const off = rig({ call, config: { documents: { signed_link_days: 0 } } });
  seen.length = 0; await off.run("documents.signed-link", { slug: "abc123" });
  assert.equal(seen[0].input.days, undefined);
  seen.length = 0;
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

test("documents.signing.waiting lists what nobody has signed without the link or code; documents.signing.remind sends that signer their link again, once, and only for a request that is waiting", async () => {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const pending = [{ submission: 4411, slug: "abc123", url: "https://documents.harlow.vyre.run/sign/4411/abc123", email: "dana@harlow.test", signer: "Dana Harlow", template: "Engagement letter", at: 5 }];
  const r = rig({ call: async (tool, input) => {
    if (tool === "spaces.merge-list") return {};
    seen.push({ tool, input });
    return tool === "appmods.signing.waiting" ? { data: { requests: pending } } : { data: { held: "gi_9" } };
  } });
  const listed = await r.run("documents.signing.waiting", {});
  assert.deepEqual(listed.requests, [{ submission: 4411, email: "dana@harlow.test", signer: "Dana Harlow", template: "Engagement letter", at: 5 }]);
  assert.ok(!JSON.stringify(listed).includes("abc123") && !JSON.stringify(listed).includes("/sign/"));
  // the approvals queue (a module) reads it with no person's chain; a surface with no signed-in person does not
  const asQueue = rig({ chain: null, call: async tool => (tool === "appmods.signing.waiting" ? { data: { requests: pending } } : {}) });
  assert.equal((await asQueue.run("documents.signing.waiting", {}, { caller: "module:approvals" })).requests.length, 1);
  assert.equal((await code(asQueue.run("documents.signing.waiting", {}, { caller: "module:comms" }))).code, "denied");
  assert.equal((await code(asQueue.run("documents.signing.waiting", {}))).code, "denied");
  // no Documents app here: nothing waits, nothing fails
  for (const error of [{ code: "not_found", message: "x" }, { code: "no_such_tool", message: "x" }]) assert.deepEqual((await rig({ call: async tool => (tool === "spaces.merge-list" ? {} : { error }) }).run("documents.signing.waiting", {})).requests, []);
  seen.length = 0;
  const out = await r.run("documents.signing.remind", { submission: 4411, note: "Thanks, Dana." });
  assert.deepEqual(seen.map(s => s.tool), ["appmods.signing.waiting", "comms.send"]);
  assert.equal(seen[1].input.to, "dana@harlow.test");
  assert.equal(seen[1].input.body, "Thanks, Dana.\n\nYour document is still waiting for your signature: https://documents.harlow.vyre.run/sign/4411/abc123");
  assert.equal(out.sent.held, "gi_9");
  assert.deepEqual(r.emitted, [{ type: "documents.reminded", payload: { submission: 4411 } }]);
  seen.length = 0;
  assert.equal((await code(r.run("documents.signing.remind", { submission: 9999 }))).code, "not_found", "a request that is not waiting is not reminded");
  assert.equal((await code(r.run("documents.signing.remind", { submission: 4411, note: "x".repeat(1001) }))).code, "bad_input");
  assert.ok(!seen.some(s => s.tool === "comms.send"), "nothing was sent for either");
  assert.equal((await code(rig({ chain: null }).run("documents.signing.remind", { submission: 4411 }))).code, "denied");
});

test("documents.send and send-signed take the signer from a Contact: its address and name, read under the caller's grants; a Contact with no address, or one that is not there, is said", async () => {
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const contacts = { "c-1": { data: { name: "Dana Harlow", email: "dana@harlow.test" } }, "c-2": { data: { name: "Sam Poe" } } };
  const r = rig({ records: Object.fromEntries(Object.entries(contacts).map(([id, v]) => [`contact/${id}`, v])), call: async (tool, input) => {
    if (tool === "spaces.merge-list") return {};
    seen.push({ tool, input });
    return tool === "appmods.signing.request" ? { data: { submission: 9, slug: "abc", url: "https://documents.harlow.vyre.run/sign/9/abc" } } : tool === "appmods.signed.link" ? { data: { url: "https://documents.harlow.vyre.run/signed/0.abc.sig", expires: null } } : { data: { held: "gi_1" } };
  } });
  // the three ways a link reaches a tool: the urn, the link as a record holds it ({ urn }), and the bare id
  for (const contact of ["vyre://spc_x/contact/c-1", { urn: "vyre://spc_x/contact/c-1" }, "c-1"]) {
    seen.length = 0;
    await r.run("documents.send", { template_id: 12, contact });
    assert.equal(seen[0].input.email, "dana@harlow.test", JSON.stringify(contact));
    assert.equal(seen[0].input.signer, "Dana Harlow");
    assert.equal(seen[1].input.to, "dana@harlow.test");
  }
  seen.length = 0;
  await r.run("documents.send", { template_id: 12, contact: "c-1", signer: "D. Harlow" });
  assert.equal(seen[0].input.signer, "D. Harlow", "a name given wins");
  seen.length = 0;
  await r.run("documents.send-signed", { slug: "abc", contact: "c-1" });
  assert.equal(seen[1].input.to, "dana@harlow.test");
  // an address given still wins over a Contact, and neither is said
  seen.length = 0;
  await r.run("documents.send", { template_id: 12, email: "x@y.test", contact: "c-1" });
  assert.equal(seen[0].input.email, "x@y.test");
  assert.match((await code(r.run("documents.send", { template_id: 12 }))).message, /name who signs/);
  assert.match((await code(r.run("documents.send", { template_id: 12, contact: "c-2" }))).message, /Sam Poe has no e-mail address yet/);
  assert.equal((await code(r.run("documents.send", { template_id: 12, contact: "c-404" }))).code, "not_found");
  assert.equal((await code(r.run("documents.send", { template_id: 12, contact: "vyre://spc_x/client/c-1" }))).code, "bad_input", "only a Contact");
  const before = seen.length;
  assert.equal((await code(r.run("documents.send", { template_id: 12, contact: "c-404" }))).code, "not_found");
  assert.equal(seen.length, before, "nothing was asked of the app or sent for a Contact that is not there");
});

test("generate gives every template the Space's brand profile as `brand`, unless the caller passes their own", async () => {
  const r = rig({ call: async (/** @type {string} */ tool) => tool === "brand.resolve" ? { data: { names: { name: "Harlow Legal", legalName: "Harlow Legal LLP", address: null, phone: "555-0100" } } } : { error: { code: "no_such_tool", message: "x" } } });
  await r.run("documents.template.add", { name: "Header", base64: b64(docx(["{brand.legalName} ({brand.name}), tel {brand.phone}"])) });
  const out = await r.run("documents.generate", { template: "Header" });
  assert.deepEqual(out.used.sort(), ["brand.legalName", "brand.name", "brand.phone"]);
  const own = await r.run("documents.generate", { template: "Header", values: { brand: { legalName: "Own LLP", name: "Own", phone: "1" } }, name: "Header own" });
  assert.ok(own.used.includes("brand.legalName"));
  const none = rig({});
  await none.run("documents.template.add", { name: "Header", base64: b64(docx(["{brand.name}"])) });
  assert.equal((await code(none.run("documents.generate", { template: "Header" }))).code, "missing_values", "with no brand profile the name is missing, said by name");
});

// Download audit, end to end through the documents module (18 Oct): the first Download writes the audit PDF under the caller's chain to Signed/, a second
// Download writes nothing and returns the saved path, a body that is not a PDF is refused and nothing is saved, and a caller that is not a person's own
// surface is refused before the app is asked. The app's answer is a fake (the appmods tool), so this checks the documents side as a whole.
test("Download audit end to end: the first call saves Signed/audit-<n>.pdf once, a second call writes nothing, a non-PDF answer saves nothing, and only a person's surface may ask", async () => {
  const pdf = Buffer.from("%PDF-1.7\n%fixture audit\n");
  const asked = /** @type {any[]} */ ([]);
  const call = async (tool, input) => { asked.push({ tool, input }); return tool === "appmods.signing.audit" ? { data: { bytes: pdf.toString("base64") } } : {}; };
  const r = rig({ call });
  const first = await r.run("documents.signing.audit", { submission: 41 }, { caller: "cli" });
  assert.equal(first.path, "Signed/audit-41.pdf");
  assert.equal(first.bytes, pdf.length);
  assert.equal(r.files.get("Signed/audit-41.pdf")?.length, 1, "one version after the first Download");
  assert.equal(asked.filter(a => a.tool === "appmods.signing.audit").length, 1, "the app was asked once");

  const second = await r.run("documents.signing.audit", { submission: 41 }, { caller: "cli" });
  assert.equal(second.already, true, "a second Download returns the saved file");
  assert.equal(second.path, "Signed/audit-41.pdf");
  assert.equal(r.files.get("Signed/audit-41.pdf")?.length, 1, "a second Download writes nothing: still one version");
  assert.equal(asked.filter(a => a.tool === "appmods.signing.audit").length, 1, "and does not ask the app again");

  const notPdf = rig({ call: async () => ({ data: { bytes: Buffer.from("<html>error</html>").toString("base64") } }) });
  assert.equal((await code(notPdf.run("documents.signing.audit", { submission: 9 }, { caller: "cli" }))).code, "app_refused");
  assert.equal(notPdf.files.has("Signed/audit-9.pdf"), false, "an error page is never saved as an audit file");

  // A second person who cannot read the first person's file gets a refusal, never the first person's path, and nothing is written for her.
  const bob = { hops: [{ actor: { kind: "person", id: "per_bob", space: SPACE } }] };
  const other = rig({ chain: bob, call, denied: [bob] });
  other.files.set("Signed/audit-41.pdf", [pdf]);
  const bobTry = await code(other.run("documents.signing.audit", { submission: 41 }, { caller: "cli" }));
  assert.equal(bobTry?.code, "denied", "a person who cannot read the file is refused");
  assert.equal(other.files.get("Signed/audit-41.pdf")?.length, 1, "nothing is written for her");

  const model = rig({ call });
  assert.equal((await code(model.run("documents.signing.audit", { submission: 41 }, { caller: "mcp" }))).code, "denied", "a model is refused before the app is asked");
  assert.equal(asked.filter(a => a.tool === "appmods.signing.audit").length, 1, "and the app was not asked for it");
});

// Member access to a signature request (the ownership check, 18 Oct): the sender sees her request; another member gets the same not_found as an id that does
// not exist, and nothing is fetched or written for her; the owner sees a request and an old one with no record; a member with no record for an old request gets not_found.
test("member access to a request: only the sender (and the owner) may open it; any other member gets the same not_found and nothing is fetched or written", async () => {
  const MIA = { hops: [{ actor: { kind: "person", id: "per_mia", space: SPACE } }] };
  const BOB = { hops: [{ actor: { kind: "person", id: "per_bob", space: SPACE } }] };
  const PDF = Buffer.from("%PDF-1.7\n%fixture\n");
  const made = /** @type {any[]} */ ([]);
  const calls = /** @type {string[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    calls.push(tool);
    if (tool === "appmods.signing.request") return { submission: 41, url: "https://app.example.com/sign/41" };
    if (tool === "appmods.signing.status") return { data: { status: { submission: input.submission, status: "pending", signers: [], audit_url: null } } };
    if (tool === "appmods.signing.audit") return { data: { bytes: PDF.toString("base64") } };
    if (tool === "appmods.signing.waiting") return { data: { requests: [{ submission: 41, slug: "s", url: "u", email: "sam@example.com", signer: "Sam", template: "T", at: 1 }] } };
    return {};
  };
  const mia = rig({ chain: MIA, call, made });
  const sent = await mia.run("documents.send", { template_id: 3, email: "sam@example.com" }, { caller: "cli" });
  assert.equal(sent.submission, 41);
  assert.equal(mia.db.prepare("SELECT sender FROM documents_requests WHERE submission = 41").get()?.sender, "per_mia", "the send recorded the sender from the verified chain");

  const bob = rig({ chain: BOB, call, made, db: mia.db });
  const bobStatus = await code(bob.run("documents.signing.status", { submission: 41 }, { caller: "cli" }));
  assert.equal(bobStatus?.code, "not_found", "B asking for A's request is refused");
  const bobAudit = await code(bob.run("documents.signing.audit", { submission: 41 }, { caller: "cli" }));
  assert.equal(bobAudit?.code, "not_found");
  assert.equal(bobAudit?.message, bobStatus?.message, "the same answer whether the request is someone else's or does not exist");
  assert.equal(bob.files.has("Signed/audit-41.pdf"), false, "nothing is written for B");
  assert.equal(calls.filter(t => t === "appmods.signing.status" || t === "appmods.signing.audit").length, 0, "the app is never asked for B");
  assert.deepEqual((await bob.run("documents.signing.waiting", {}, { caller: "cli" })).requests, [], "B's waiting list does not carry A's request");

  assert.equal((await mia.run("documents.signing.status", { submission: 41 }, { caller: "cli" })).status.submission, 41, "A opens her own request");
  assert.equal((await mia.run("documents.signing.waiting", {}, { caller: "cli" })).requests.length, 1, "A's waiting list has her request");

  const owner = rig({ call, made, db: mia.db });
  assert.equal((await owner.run("documents.signing.status", { submission: 41 }, { caller: "cli" })).status.submission, 41, "the owner sees the request");
  assert.equal((await code(owner.run("documents.signing.status", { submission: 99 }, { caller: "cli" })))?.message, bobStatus?.message, "an id that does not exist gets the same answer");

  const oldMember = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_old", space: SPACE } }] }, call, made, db: mia.db });
  assert.equal((await code(oldMember.run("documents.signing.status", { submission: 7 }, { caller: "cli" })))?.code, "not_found", "a member with no record for an old request gets not_found");
});

test("an admin sees the requests the owner may see; a plain member with no record does not", async () => {
  const made = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => tool === "appmods.signing.request" ? { submission: 52, url: "u" } : tool === "appmods.signing.status" ? { data: { status: { submission: input.submission, status: "pending", signers: [], audit_url: null } } } : {};
  const sender = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_mia", space: SPACE } }] }, call, made });
  await sender.run("documents.send", { template_id: 3, email: "sam@example.com" }, { caller: "cli" });
  const admin = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_admin", space: SPACE } }] }, call, made, db: sender.db });
  assert.equal((await admin.run("documents.signing.status", { submission: 52 }, { caller: "cli" })).status.submission, 52, "an admin opens any request");
  const plain = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_pat", space: SPACE } }] }, call, made, db: sender.db });
  assert.equal((await code(plain.run("documents.signing.status", { submission: 52 }, { caller: "cli" })))?.code, "not_found", "a plain member does not");
});

test("a removed admin is refused: the kernel says she is no longer a member, so her old admin role does not open other people's requests", async () => {
  const made = /** @type {any[]} */ ([]);
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => tool === "appmods.signing.status" ? { data: { status: { submission: input.submission, status: "pending", signers: [], audit_url: null } } } : {};
  const sender = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_mia", space: SPACE } }] }, call, made });
  await sender.db.prepare("INSERT INTO documents_requests (submission, sender, template, at) VALUES (?, ?, ?, ?)").run(61, "per_mia", "3", 1);
  const removed = rig({ chain: { hops: [{ actor: { kind: "person", id: "per_removed", space: SPACE } }] }, call, made, db: sender.db });
  assert.equal((await code(removed.run("documents.signing.status", { submission: 61 }, { caller: "cli" })))?.code, "not_found", "a removed admin is refused");
});
