import "../scripts/mac-test-guard.mjs";
// @ts-check
// The one yes at the registry's floor (inventory item 4, step B), on a real daemon with a development software key standing in for the device: a moment tool takes a yes in the forms of
// spec team/0.3.1/SPEC-one-yes-clients.md and nothing else; a reveal's yes may carry a five-minute reuse for that device only; a 0.3.0 client's old header is turned into a card at the edge;
// every other tool the floor used to guard needs the person and no proof; an agent is never the person.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { homeIdentity } from "../kernel/home.js";
import { tempHome } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (/** @type {string} */ script, /** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8" });

test("a moment takes a yes in its forms, a reveal's yes may be reused for five minutes by one device, the old header is admitted at the edge, and an agent never counts", { timeout: 180_000 }, async t => {
  const saved = Object.fromEntries(["VYRE_SEAL_DEV", "VYRE_SEAL_SOFTWARE", "VYRE_KERNEL_PATH_RULE"].map(k => [k, process.env[k]]));
  Object.assign(process.env, { VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1", VYRE_KERNEL_PATH_RULE: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const root = tempHome(t);
  homeIdentity(root);
  assert.equal(run("dev-enrol-software-key.mjs", ["--home", root]).status, 0);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 200));
  assert.ok((await d.registry.tools.get("vault.put").run({ name: "k", kind: "api-key", value: "secret-1" }, { caller: "module:vault", firstParty: true })).created);
  /** @param {string} tool @param {any} input */
  const sign = (tool, input) => { const r = run("dev-sign-proof.mjs", ["--home", root, "--yes", "vault", "--tool", tool, "--input", JSON.stringify(input), "--header"]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const bare = (/** @type {string} */ h) => h.replace(/^yes proof=/, "");
  const at = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {Record<string, string>} */ headers = {}, caller = "cli") => call(tool, input, { root, caller, headers });

  const none = await at("vault.reveal", { name: "k" });
  assert.equal(none.error?.code, "presence_required");
  assert.equal(none.error.moment, "vault");
  assert.deepEqual(none.error.request, { op: "vault.reveal", fields: { name: "k" } }, "the refusal carries exactly what must be approved");
  assert.equal((await at("vault.reveal", { name: "k" }, { "x-vyre-yes": bare(sign("vault.reveal", { name: "other" })) })).error?.code, "presence_required", "a yes for another call");
  const h = bare(sign("vault.reveal", { name: "k" }));
  assert.equal((await at("vault.reveal", { name: "k" }, { "x-vyre-yes": h })).data?.value, "secret-1");
  assert.equal((await at("vault.reveal", { name: "k" }, { "x-vyre-yes": h })).error?.code, "presence_required", "single use");
  assert.equal((await at("vault.reveal", { name: "k" }, { "x-vyre-presence": sign("vault.reveal", { name: "k" }) })).data?.value, "secret-1", "a 0.3.0 client's header still works");
  // reuse
  assert.equal((await at("vault.reveal", { name: "k" }, { "x-vyre-yes": bare(sign("vault.reveal", { name: "k", reuse: true })) })).data?.value, "secret-1");
  assert.equal((await at("vault.reveal", { name: "k" })).data?.value, "secret-1", "five minutes of reveals for this device");
  assert.equal((await at("vault.backup", { file: path.join(root, "b.vyre"), passphrase: "walk passphrase 1" })).error?.code, "presence_required", "the window is for a reveal, a copy and a code only");
  assert.ok((await at("vault.reveal", { name: "k" }, {}, "mcp")).error, "an agent never rides a window");
  // an agent is not the person: no proof makes it one
  assert.ok((await at("vault.reveal", { name: "k" }, { "x-vyre-yes": bare(sign("vault.reveal", { name: "k" })) }, "mcp:agent:kit")).error);
  // only the registry admits a card
  assert.ok((await at("approvals.admit", { moment: "vault", op: "vault.reveal", fields: { name: "k" }, device: "local:cli" })).error);
  // a tool that is not a moment needs the person and no proof
  assert.notEqual((await at("relay.disable", {})).error?.code, "presence_required");
  fs.rmSync(path.join(root, "b.vyre"), { force: true });
});
