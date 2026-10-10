// @ts-check
// J3, secrets done right, the part the Vault owns, on a real daemon: a key the person said yes to is in the Vault and shows no value; a module uses it by reference on its own grant and the value
// reaches that module only; a scan of every file the home holds, the audit log, the events and the daemon's own log finds the key nowhere in plain text; the Vault's health shows in Now as one row of
// counts. (The paste card in chat is chat's step; the agent's sign-in on a site is core/vault/agent-fill.test.js against a real Chrome.) A test box, never a Mac.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../core/daemon/index.js";
import { tempHome, present } from "./helpers.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
const KEY = "fixture-deepgram-key-" + "0123456789abcdef0123456789abcdef";

/** Every file under a folder. @param {string} dir @returns {string[]} */
const files = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(path.join(dir, e.name)) : e.isFile() ? [path.join(dir, e.name)] : []));

test("a key the person said yes to lives in the Vault, is used by reference, and is in plain text nowhere else", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "alex", vault: { keystore: "file" } }));
  const lines = /** @type {string[]} */ ([]);
  const d = await start({ root, presence: present, log: m => lines.push(String(m)) });
  t.after(() => d.stop());
  const events = /** @type {string[]} */ ([]);
  if (d.registry.deps.events && typeof d.registry.deps.events.on === "function") d.registry.deps.events.on("*", (/** @type {any} */ e) => events.push(JSON.stringify(e)));
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const as = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => d.registry.call(tool, input, "cli", { token: (await d.kernel.surfaces.open(owner, {})).token });

  // 1. the key is saved (the person's yes), and the list shows the name and no value
  const put = await as("vault.put", { name: "deepgram", kind: "secret", fields: { value: KEY } });
  assert.ok(!put.error, JSON.stringify(put.error));
  const list = await as("vault.list");
  assert.ok(JSON.stringify(list.data).includes("deepgram"));
  assert.ok(!JSON.stringify([put, list]).includes(KEY), "neither the save nor the list carries the value");

  // 2. a module uses it by reference, on a grant the person gave; another module gets nothing
  const release = (/** @type {string} */ caller) => d.registry.call("vault.release", { name: "deepgram" }, caller, { door: true });
  assert.match((await release("module:voice")).error.message, /not granted/);
  assert.ok(!(await as("vault.grant", { name: "deepgram", module: "voice" })).error);
  assert.equal((await release("module:voice")).data.value, KEY, "the module that was given it uses it");
  assert.match((await release("module:notes")).error.message, /not granted/, "a module that was not given it does not");

  // 3. the scan: the key is in no file of the home in plain text, in no audit row, no event, no log line
  const hits = files(root).filter(f => { try { return fs.readFileSync(f).includes(KEY); } catch { return false; } });
  assert.deepEqual(hits, [], "no file of the home holds the key in plain text");
  const audit = d.registry.deps.db.prepare("SELECT who, action, name, ok FROM vault_audit ORDER BY rowid").all();
  assert.ok(audit.some((/** @type {any} */ r) => r.action === "release" && r.who === "module:voice" && r.ok === 1), "the use is on the log");
  assert.ok(events.length > 0 && lines.length > 0, "the scan had events and log lines to look through");
  assert.ok(!JSON.stringify(audit).includes(KEY) && !events.join("\n").includes(KEY) && !lines.join("\n").includes(KEY));

  // 4. Vault health is one row in Now: counts only, zero while nothing is found
  const quiet = await as("vault.health.summary");
  assert.equal(quiet.data.total, 0);
  d.registry.deps.db.prepare("INSERT INTO vault_reminders (name, reason, planner, state, at) VALUES (?,?,?,?,?)").run("deepgram", "rotate", null, "open", Date.now());
  const row = await as("vault.health.summary");
  assert.deepEqual([row.data.total, row.data.rotate, row.data.fix], [1, 1, 0]);
  assert.ok(!JSON.stringify(row.data).includes("deepgram"), "the row says how many, never which");
});
