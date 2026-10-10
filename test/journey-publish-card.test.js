// @ts-check
// R032-07, Publish from a preview card, on a real daemon with a real person: the card's own calls. A folder of files is a preview (previews.open); Publish sends the preview's id, never a path (publish.quick);
// the call holds for the person's one yes and names what goes public; the yes carries the plan's hash (publish.decide) and the answer is the live address; a decline puts nothing live. A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });

test("Publish from a preview card: the preview's id, the plan held for one yes, the live address; a decline puts nothing live", { timeout: 240_000 }, async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "card-box", vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
    return d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  };
  assert.ok(!(await as("spaces.identity.create", { name: "alex" })).error);
  assert.ok(!(await as("spaces.create", { name: "bakery", home: { kind: "this-computer", confirmed: true } })).error);
  const site = fs.mkdtempSync(path.join(root, "intake-"));
  fs.writeFileSync(path.join(site, "index.html"), "<!doctype html><title>Intake</title><h1>Tell us about your case</h1>\n");

  const pv = await as("previews.open", { title: "Intake form", path: site });
  assert.ok(!pv.error, JSON.stringify(pv.error));
  assert.equal(pv.data.preview.source, "files", "the card has a source the app can tell is a folder of files");
  assert.ok(!JSON.stringify(pv.data).includes(site), "no path crosses to the card");

  const q = await as("publish.quick", { name: "intake-form", preview: pv.data.id, space: "bakery.vyre.run" });
  assert.ok(!q.error, JSON.stringify(q.error));
  assert.equal(q.data.held, true, "nothing is live yet: the call holds for the person");
  assert.ok(q.data.plan.files.paths.includes("index.html"), "the plan names what goes public");
  assert.ok(!JSON.stringify(q.data).includes(site), "the answer holds no path");
  const done = await as("publish.decide", { task: q.data.task, approve: true, plan_hash: q.data.plan.hash });
  assert.ok(!done.error, JSON.stringify(done.error));
  assert.equal(done.data.outcome, "approved");
  assert.equal(done.data.deployment.stage, "Production");
  assert.match(done.data.deployment.url, /^https:\/\//, "the answer is the live address");

  const pv2 = await as("previews.open", { title: "Other", path: site });
  const q2 = await as("publish.quick", { name: "other-site", preview: pv2.data.id, space: "bakery.vyre.run" });
  const no = await as("publish.decide", { task: q2.data.task, approve: false });
  assert.equal(no.data.outcome, "declined");
  const list = await as("publish.list", { space: "bakery.vyre.run" });
  const live = (list.data.deployments || list.data).filter((/** @type {any} */ x) => x.stage === "Production").map((/** @type {any} */ x) => x.name);
  assert.deepEqual(live, ["intake-form"], "only the one that was approved is live");

  const bad = await as("publish.quick", { name: "x", preview: "00000000", space: "bakery.vyre.run" });
  assert.ok(bad.error, "a preview that is not there is refused in words");
});
