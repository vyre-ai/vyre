// @ts-check
// A deployment in a CREATED Space can hold a secret: the grant Publish makes says the kernel's own Space (where the Vault and its credentials live), so the Vault answers Publish on it and only on it. Before,
// the deployment's own Space was in the address and the kernel refused the grant ("publish may not make that grant"). A real daemon with a claimed name and a created Space; a test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "standin-directory.mjs");
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });


test("a deployment in a created Space holds a secret on a kernel grant the Vault answers, and loses it when the person takes it away", { timeout: 240_000 }, async t => {
  const port = await freePort();
  const child = spawn(process.execPath, [SCRIPT, "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "bakery-box", vault: { keystore: "file" }, names: { directory: `http://127.0.0.1:${port}` } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => {
    const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
    return d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });
  };
  assert.ok(!(await as("spaces.identity.create", { name: "alex" })).error);
  assert.ok(!(await as("spaces.create", { name: "bakery", home: { kind: "this-computer", confirmed: true } })).error);
  const KEY = "fixture-stripe-key-0123456789abcdef0123";
  assert.ok(!(await as("vault.put", { name: "stripe", kind: "secret", fields: { value: KEY } })).error);
  const site = fs.mkdtempSync(path.join(root, "site-"));
  fs.writeFileSync(path.join(site, "index.html"), "<h1>Northwind</h1>");
  const q = await as("publish.quick", { name: "bakery", folder: site, space: "bakery.vyre.run" });
  assert.ok(!q.error, JSON.stringify(q.error));
  const dep = q.data.deployment.id;

  const g = await as("publish.secret.grant", { deployment: dep, ref: "vault://stripe", name: "STRIPE_KEY", use: ["build"], space: "bakery.vyre.run" });
  assert.equal(g.data.held, true, "a real secret is held for the person");
  const yes = await as("publish.decide", { task: g.data.task, approve: true, plan_hash: g.data.plan.hash });
  assert.ok(!yes.error, JSON.stringify(yes.error));
  const release = (/** @type {string} */ deployment) => d.registry.call("vault.release", { name: "stripe", deployment }, "module:publish", { door: true });
  assert.equal((await release(dep)).data.value, KEY, "the Vault answers Publish for this deployment on its grant");
  assert.match((await release("dep_other")).error.message, /not granted to this deployment/, "and for no other");
  assert.deepEqual((await as("publish.status", { deployment: dep, space: "bakery.vyre.run" })).data.secrets.map((/** @type {any} */ s) => s.name), ["STRIPE_KEY"]);

  const gone = await as("publish.secret.revoke", { deployment: dep, name: "STRIPE_KEY", space: "bakery.vyre.run" });
  assert.ok(!gone.error, JSON.stringify(gone.error));
  assert.match((await release(dep)).error.message, /not granted to this deployment/, "taking it away ends the Vault's answer");
});
