// @ts-check
// The PDF converter app for real: the pinned Gotenberg image installed through appmods on the owner's yes (docker-direct driver, the limits and dropped capabilities of any app), and Documents
// turning a filled template into a real PDF through it, with no address set anywhere. Skips itself unless VYRE_APPMODS_LIVE=1; run it on a test box that has Docker and passwordless sudo:
//   VYRE_APPMODS_LIVE=1 node --test core/appmods/pdf-app-live.test.js
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { namesOf } from "./runtime.js";
import { canonical } from "../../kernel/core/canonical.js";
import { docx } from "../documents/testing/docx.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
delete process.env.VYRE_DOCUMENTS_PDF;
const LIVE = process.env.VYRE_APPMODS_LIVE === "1";
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };
const docker = (/** @type {string[]} */ a) => spawnSync("docker", a, { encoding: "utf8" });

test("the PDF converter app makes a real PDF for Documents, found with no address set", { skip: !LIVE, timeout: 600_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "pdf-live", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: m => { if (process.env.WLOG) console.error(m); }, kernel: true, kernelPresence: stubPresence() });
  const names = namesOf(d.kernel.id.space, "pdf");
  t.after(async () => { try { await d.registry.call("appmods.remove", { name: "pdf", data: true }, "cli"); } catch { /* gone */ } docker(["rm", "-f", names.container]); await d.stop(); });
  const ownerMeta = async () => ({ token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" }), {})).token });
  const own = async () => ({ ...(await ownerMeta()), proof: { method: "passkey", id: "x" } });

  // no converter yet: the plain refusal, and the Word file is still made
  await d.registry.call("documents.template.add", { name: "Letter", base64: docx(["Dear {client.name}, your fee is {fee}."]).toString("base64") }, "cli", await ownerMeta());
  const before = await d.registry.call("documents.generate", { template: "Letter", values: { client: { name: "Dana Harlow" }, fee: 1500 }, format: "pdf" }, "cli", await ownerMeta());
  assert.equal(before.error && before.error.code, "no_pdf_engine", JSON.stringify(before));
  assert.match(before.error.message, /install the PDF converter app from Apps/);

  // install it: the owner's yes
  const inst = await d.registry.call("appmods.install", { name: "pdf" }, "cli", await own());
  assert.equal(inst.data && inst.data.state, "running", JSON.stringify(inst));
  const ins = JSON.parse(docker(["inspect", names.container]).stdout)[0];
  assert.equal(ins.HostConfig.Memory, 1024 * 1048576);
  assert.equal(ins.HostConfig.PidsLimit, 256);
  assert.deepEqual(ins.HostConfig.CapDrop, ["ALL"]);
  assert.equal(ins.HostConfig.Privileged, false);
  assert.match(ins.Config.Image, /gotenberg\/gotenberg:8\.37\.0@sha256:f29984bd/);
  assert.ok(ins.Config.Env.includes("CHROMIUM_DISABLE_ROUTES=true"), "its flags are the unit's, as environment values");

  // Documents finds it and the PDF is real
  const made = await d.registry.call("documents.generate", { template: "Letter", values: { client: { name: "Dana Harlow" }, fee: 1500 }, format: "pdf" }, "cli", await ownerMeta());
  assert.equal(made.error, undefined, JSON.stringify(made.error));
  assert.match(made.data.path, /\.pdf$/);
  const got = await d.registry.call("files.drive.space.read", { path: made.data.path }, "cli", await ownerMeta());
  const bytes = Buffer.from(String(got.data.base64 || got.data.content || ""), "base64");
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-", JSON.stringify(got).slice(0, 200));
  assert.ok(bytes.length > 1000);

  // and the engine's chromium routes are off in the running container (a 404, not the 415 of a route that is there)
  const port = /:(\d+)$/m.exec(docker(["port", names.container, "3000/tcp"]).stdout.split("\n")[0])?.[1];
  const r = await fetch(`http://127.0.0.1:${port}/forms/chromium/convert/url`, { method: "POST" });
  assert.equal(r.status, 404);
});
