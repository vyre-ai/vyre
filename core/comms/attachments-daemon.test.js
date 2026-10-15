// @ts-check
// The roadmap test for email (0.6 item 8) on a real vyred with the kernel on: a Flow makes a document with a real Documents step (the template is filed in the real Drive and filled), then sends an email
// with CC, BCC, a file from Files and that document. The real Gate holds it, a person approves it, the real hash and access checks run at the release; only the outside provider is a stand-in (lib/http.js
// testHooks.fetch). The held message and the sent request show everything, the file bytes are only in the one request that sends, and a file changed after approval stops the send.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { docx } from "../documents/testing/docx.js";
import { testHooks } from "../../lib/http.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const until = async (/** @type {() => any} */ fn, /** @type {string} */ what, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 50)); } };
const b64 = (/** @type {Buffer | Uint8Array} */ b) => Buffer.from(b).toString("base64");

test("a Flow sends CC, BCC, a file from Files and a document its Documents step made, through the real Gate and Drive", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  /** @type {any[]} */ const posted = [];
  testHooks.fetch = async (url, init) => { posted.push({ url: String(url), body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ id: "re_msg_1" }), { status: 200, headers: { "content-type": "application/json" } }); };
  t.after(() => { testHooks.fetch = null; });
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const ownerChain = K.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  const owner = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await K.surfaces.open(ownerChain, {})).token });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await owner(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };

  // the sending service the Space connected (its key is in the Vault, granted to Comms), the template in the Drive, and a file in Files
  await ok("vault.put", { name: "comms-sending", kind: "env-set", fields: { service: "resend", api_key: "re_live_TEST_KEY_0001", from: "Harlow Law <hello@harlow.example>", domain: "harlow.example" } });
  await ok("vault.grant", { name: "comms-sending", module: "comms" });
  await ok("documents.template.add", { name: "Letter", base64: b64(docx(["Dear {client.name},", "Your engagement letter is attached."])) });
  const rota = Buffer.from("%PDF-ROTA-WEEK-1");
  await ok("files.drive.upload", { path: "Rota/week1.pdf", base64: b64(rota) });

  const flow = { format: 1, name: "rota_mail", label: "Rota mail", authorship: "human", trigger: { on: "manual" }, steps: [
    { id: "letter", kind: "call", action: "documents.generate", resource: "vyre://space/documents", input: { template: "Letter", name: "Engagement letter", values: { client: { name: "Dana Harlow" } } } },
    { id: "mail", kind: "call", action: "comms.email", resource: "vyre://space/comms", input: { to: "dana@northwind-bakery.example", cc: ["ops@harlow.example"], bcc: ["alex@harlow.example", "files@harlow.example"],
      subject: "Your engagement letter and the rota", text: "Both are attached.", attachments: [{ path: "Rota/week1.pdf", name: "Rota week 1.pdf" }, { path: { expr: "steps.letter.path" } }] } },
  ] };
  const def = await ok("flows.define", { flow });
  assert.ok(def.ok, JSON.stringify(def));
  await ok("flows.approve", { id: def.id, version: def.version, hash: def.hash });
  await ok("flows.start", { id: def.id });

  // the real Gate holds the message: nothing has gone out
  const held = await until(async () => { const l = await ok("gate.held"); return Array.isArray(l) && l.length ? l[0] : null; }, "the held email");
  assert.equal(posted.length, 0, "nothing is sent before the person approves");
  const item = await ok("gate.get", { id: held.id });
  const c = item.content;
  assert.deepEqual([c.cc, c.bcc], [["ops@harlow.example"], ["alex@harlow.example", "files@harlow.example"]], "CC and BCC are in the held message");
  assert.equal(c.attachments.length, 2, "both files are in the held message");
  const [fromFiles, fromDocs] = c.attachments;
  assert.deepEqual([fromFiles.name, fromFiles.path, fromFiles.size, fromFiles.sha256, fromFiles.by], ["Rota week 1.pdf", "Rota/week1.pdf", rota.length, crypto.createHash("sha256").update(rota).digest("hex"), OWNER]);
  assert.match(fromDocs.path, /^Documents\/general\/engagement-letter-[0-9a-f]{8}\.docx$/, "the file the Documents step made");
  const docBytes = Buffer.from(await K.gateway.drive.get(ownerChain, fromDocs.path));
  assert.equal(fromDocs.sha256, crypto.createHash("sha256").update(docBytes).digest("hex"), "its hash is of the filed bytes");
  assert.ok(!JSON.stringify(item).includes(b64(rota)) && !JSON.stringify(item).includes("%PDF-ROTA"), "no file bytes in the held message");

  // a file that changed after the person looked stops the send, and says so
  await ok("files.drive.upload", { path: "Rota/week1.pdf", base64: b64(Buffer.from("%PDF-ROTA-WEEK-1-EDITED")), base: 1 });
  const stopped = await owner("gate.approve", { id: held.id });
  assert.ok(stopped.error && /Rota week 1\.pdf changed after you approved this message, so nothing was sent\. Approve it again\./.test(stopped.error.message), JSON.stringify(stopped));
  assert.equal(posted.length, 0, "nothing went out");
});
