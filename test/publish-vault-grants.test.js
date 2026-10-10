// @ts-check
// R032-11: Publish uses the Vault's grants. One Deepgram key lives in the Vault once; two deployments each hold their own kernel grant on it (vault.run, made by Publish for the deployment's service actor) and
// the chat's transcripts use it through their own module grant. Each is judged on its own: ending one deployment's grant leaves the others, a deployment with no grant gets nothing, and deleting the
// credential ends every deployment's use of it. On a real daemon with the kernel on (a test box, never a Mac).
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const manifest = JSON.parse(fs.readFileSync(new URL("../core/publish/module.json", import.meta.url), "utf8"));
const KEY = "fixture-deepgram-key-not-real-0123456789";
const until = async (/** @type {() => Promise<any>} */ f, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("timed out"); await new Promise(r => setTimeout(r, 25)); } };

async function world(/** @type {import("node:test").TestContext} */ t) {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const put = await d.registry.call("vault.put", { name: "deepgram", kind: "secret", fields: { value: KEY } }, "cli");
  assert.ok(!put.error, JSON.stringify(put));
  const publish = d.kernel.kernelFor({ name: "publish", needs: manifest.needs });
  const space = d.kernel.id.space;
  /** Publish's grant for one deployment, as lib/publish/grants.js makes it. */
  const give = (/** @type {string} */ dep, name = "deepgram") => publish.mint.make({
    subject: { kind: "actor", actor: { kind: "service", id: `deployment-${dep}`, space } }, actions: ["vault.run"], resource: { prefix: `vyre://${space}/credential/${name}` },
    source: `publish:secret:${dep}:DEEPGRAM_KEY:secret:runtime`, reason: "granted by the owner",
  });
  const release = (/** @type {string} */ caller, /** @type {any} */ input) => d.registry.call("vault.release", input, caller, { door: true });
  return { d, publish, give, release, space };
}

test("one key serves two deployments and the chat's transcripts, each on its own grant", async t => {
  const { d, publish, give, release } = await world(t);
  await give("dep_a"); await give("dep_b");
  assert.equal((await release("module:publish", { name: "deepgram", deployment: "dep_a" })).data.value, KEY);
  assert.equal((await release("module:publish", { name: "deepgram", deployment: "dep_b" })).data.value, KEY);
  // a deployment nobody gave it to, and a Publish call that names no deployment, get nothing
  for (const input of [{ name: "deepgram", deployment: "dep_c" }, { name: "deepgram" }]) {
    const r = await release("module:publish", input);
    assert.match(r.error.message, /not granted to this deployment/, JSON.stringify(input));
  }
  // the chat's transcripts use it through their own module grant: the same item, one key
  assert.match((await release("module:voice", { name: "deepgram" })).error.message, /not granted/);
  assert.ok(!(await d.registry.call("vault.grant", { name: "deepgram", module: "voice" }, "cli")).error);
  assert.equal((await release("module:voice", { name: "deepgram" })).data.value, KEY);
  // another module cannot borrow a deployment's grant
  assert.match((await release("module:voice", { name: "deepgram", deployment: "dep_a" })).data ? "" : "refused", /refused/);
  // ending one deployment's grant leaves the other deployment and the transcripts
  await publish.mint.end({ source: "publish:secret:dep_a:DEEPGRAM_KEY:secret:runtime" });
  assert.match((await release("module:publish", { name: "deepgram", deployment: "dep_a" })).error.message, /not granted to this deployment/);
  assert.equal((await release("module:publish", { name: "deepgram", deployment: "dep_b" })).data.value, KEY);
  assert.equal((await release("module:voice", { name: "deepgram" })).data.value, KEY);
});

test("a grant is for its own item: a deployment with a grant on one credential gets no other", async t => {
  const { d, give, release } = await world(t);
  await d.registry.call("vault.put", { name: "deepgram2", kind: "secret", fields: { value: "fixture-other-key-0123456789" } }, "cli");
  await give("dep_a");
  assert.match((await release("module:publish", { name: "deepgram2", deployment: "dep_a" })).error.message, /not granted to this deployment/, "deepgram is not deepgram2");
});

test("deleting the credential ends every deployment's use of it; each release is audited by deployment, never with the value", async t => {
  const { d, give, release } = await world(t);
  await give("dep_a"); await give("dep_b");
  await release("module:publish", { name: "deepgram", deployment: "dep_a" });
  assert.ok(!(await d.registry.call("vault.delete", { name: "deepgram" }, "cli")).error);
  await d.registry.call("vault.put", { name: "deepgram", kind: "secret", fields: { value: "fixture-a-new-key-0123456789" } }, "cli");
  await until(async () => (await release("module:publish", { name: "deepgram", deployment: "dep_b" })).error);
  assert.match((await release("module:publish", { name: "deepgram", deployment: "dep_a" })).error.message, /not granted to this deployment/, "the new item is a new credential: nothing carries over");
  const audit = d.registry.deps.db.prepare("SELECT who, ok, why FROM vault_audit WHERE action = 'release' ORDER BY rowid").all();
  assert.ok(audit.some((/** @type {any} */ r) => r.who === "module:publish/dep_a" && r.ok === 1), "the first release is on the log by deployment");
  assert.ok(!JSON.stringify(audit).includes(KEY));
});
