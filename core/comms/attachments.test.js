// @ts-check
// The roadmap test for email (0.6 item 8): a Flow's email step sends CC, BCC, one file from Files and one file a Documents step made, and the logged message shows all of them. The stand-ins are the same
// as service.test.js (Gate, Vault, sending service); the Drive is a stand-in with the kernel's own refusals (an asker who cannot read, a file that changed). The Flow engine's own value resolution turns the
// step's `{ expr: "steps.letter.path" }` into the path documents.generate returned.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { registerComms, SENDER_SERVICE } from "./index.js";
import { resolveValue } from "../../kernel/flows/runner-util.js";

const FIELDS = { service: "resend", api_key: "re_live_KEY_0000", from: "Harlow Law <hello@harlow.example>", domain: "harlow.example" };
const ROTA = "Files/Rota/week1.pdf", LETTER = "Documents/general/engagement-letter-ab12cd34.docx";

function rig() {
  /** @type {Map<string, any>} */ const tools = new Map();
  /** @type {any[]} */ const calls = [], posted = [], events = [];
  const files = /** @type {Record<string, Buffer>} */ ({ [ROTA]: Buffer.from("PDF-ROTA-1"), [LETTER]: Buffer.from("DOCX-LETTER-1") });
  const readable = new Set([ROTA, LETTER]);
  const kernel = { space: "spc_x", chain: async () => ({ hops: [{ actor: { kind: "person", id: "per_alex" } }] }), serviceChain: () => ({ svc: true }),
    drive: { get: async (/** @type {any} */ c, /** @type {string} */ p) => { if (!c.svc && !readable.has(p)) throw new Error("denied"); return files[p]; } },
    personMay: async (/** @type {string} */ person, /** @type {string} */ _a, /** @type {string} */ res) => person === "per_alex" && readable.has(res.replace("vyre://spc_x/file/", "")) };
  const ctx = { kernel, config: {}, log: () => {}, tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d), events: { emit: (/** @type {string} */ t, /** @type {any} */ p) => events.push([t, p]) },
    vault: { fetch: async (/** @type {string} */ _id, /** @type {any} */ o) => (/** @type {any} */ (FIELDS))[o.field] },
    call: async (/** @type {string} */ tool, /** @type {any} */ input) => {
      calls.push([tool, input]);
      if (tool === "gate.offer") return { data: { ok: true } };
      if (tool === "gate.request") return { data: { id: "gi_1" } };
      if (tool === "vault.connections.list") return { data: [{ ref: "comms-sending", provider: "sending-service" }] };
      if (tool === "gate.get") return { data: { state: "sending", via: SENDER_SERVICE } };
      return { error: { code: "no_such_tool", message: tool } };
    } };
  registerComms(ctx, { http: async (/** @type {string} */ url, /** @type {any} */ init) => { posted.push([url, init]); return new Response(JSON.stringify({ id: "re_1" }), { status: 200 }); } });
  return { run: (/** @type {string} */ n, /** @type {any} */ i, /** @type {any} */ meta = { caller: "cli" }) => tools.get(n).run(i, meta), calls, posted, events, files, readable };
}
const fails = (/** @type {Promise<any>} */ p) => p.then(() => null, (/** @type {any} */ e) => e);

test("a Flow sends CC, BCC, a file from Files and a file a Documents step made; the held and the sent message show all of them", async () => {
  const r = rig();
  // what the Flow stored for the step, and what the engine makes of it once the Documents step (call documents.generate, which answers { path }) has run
  const step = { to: "dana@northwind-bakery.example", cc: ["ops@harlow.example"], bcc: ["alex@harlow.example", "files@harlow.example"], subject: "Your engagement letter and the rota", text: "Both are attached.",
    attachments: [{ path: ROTA, name: "Rota week 1.pdf" }, { path: { expr: "steps.letter.path" } }] };
  const input = resolveValue(step, { steps: { letter: { path: LETTER, version: 1, size: 13, format: "docx" } } });
  assert.equal(input.attachments[1].path, LETTER, "a Documents step's output is a path the email step can name");

  const out = await r.run("comms.email", input, { caller: "mcp agent:kit", thread: "t-1" });
  assert.equal(out.held, "gi_1");
  const req = r.calls.find(c => c[0] === "gate.request")[1];
  assert.deepEqual([req.content.cc, req.content.bcc], [["ops@harlow.example"], ["alex@harlow.example", "files@harlow.example"]], "CC and BCC are in the held message");
  assert.deepEqual(req.content.attachments.map((/** @type {any} */ a) => [a.name, a.path, a.size, a.by]), [["Rota week 1.pdf", ROTA, 10, "per_alex"], ["engagement-letter-ab12cd34.docx", LETTER, 13, "per_alex"]], "both files, by name, path and size, from the asker");
  assert.ok(req.content.attachments.every((/** @type {any} */ a) => a.sha256 === crypto.createHash("sha256").update(r.files[a.path]).digest("hex")), "each with the hash of what was read");
  assert.ok(!JSON.stringify(req).includes("PDF-ROTA") && !JSON.stringify(req).includes("DOCX-LETTER"), "no file bytes in the held message");
  assert.equal(r.posted.length, 0, "nothing is sent until the Gate releases it");

  const sent = await r.run("comms.release", { id: "gi_1", to: [step.to], content: req.content }, { caller: "module:gate" });
  assert.equal(sent.sent.length, 1);
  const body = JSON.parse(r.posted[0][1].body);
  assert.deepEqual([body.cc, body.bcc], [step.cc, step.bcc], "CC and BCC go out");
  assert.deepEqual(body.attachments, [{ filename: "Rota week 1.pdf", content: Buffer.from("PDF-ROTA-1").toString("base64") }, { filename: "engagement-letter-ab12cd34.docx", content: Buffer.from("DOCX-LETTER-1").toString("base64") }], "both files go out");
  const logged = r.events.find(e => e[0] === "comms.sent")[1];
  assert.deepEqual([logged.cc, logged.bcc, logged.files], [1, 2, ["Rota week 1.pdf", "engagement-letter-ab12cd34.docx"]], "the log shows them");
});

test("the send stops when a file changed after approval, and when the asker can no longer read it", async () => {
  const r = rig();
  const input = { to: "dana@northwind-bakery.example", subject: "Rota", text: "Attached.", attachments: [{ path: ROTA, name: "Rota.pdf" }] };
  await r.run("comms.email", input, { caller: "cli" });
  const content = r.calls.find(c => c[0] === "gate.request")[1].content;
  r.files[ROTA] = Buffer.from("PDF-ROTA-2");
  const changed = await fails(r.run("comms.release", { id: "gi_1", to: [input.to], content }, { caller: "module:gate" }));
  assert.match(changed.message, /Rota.pdf changed after you approved this message, so nothing was sent. Approve it again./);
  r.files[ROTA] = Buffer.from("PDF-ROTA-1");
  r.readable.delete(ROTA);
  assert.match((await fails(r.run("comms.release", { id: "gi_1", to: [input.to], content }, { caller: "module:gate" }))).message, /no longer be read by the person who asked/);
  assert.equal(r.posted.length, 0, "nothing was sent either time");
  r.readable.add(ROTA);
  assert.equal((await fails(r.run("comms.email", { ...input, attachments: [{ path: "Files/Other/private.pdf" }] }, { caller: "cli" }))).code, "denied", "a file the asker may not read cannot be attached");
});
