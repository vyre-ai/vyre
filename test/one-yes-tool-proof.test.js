import "../scripts/mac-test-guard.mjs";
// @ts-check
// One yes, the direct form (user ruling 5 Oct 2026): relay.enable, relay.pair.start and wink.phone.open are pairing-weight moments, so they take a proof signed over the call itself through yes() in lib/one-yes.js
// (`x-vyre-presence: yes proof=<base64url>`), in the owner's chain, instead of widening the development stand-in. A software key stands on a development build only; a release build refuses it. The proof is signed
// the way the walk does it: scripts/dev-enrol-software-key.mjs once, scripts/dev-sign-proof.mjs --yes per call. A real daemon on the real sealing process.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../core/daemon/index.js";
import { call } from "../core/daemon/client.js";
import { homeIdentity } from "../kernel/home.js";
import { tempHome } from "./helpers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (/** @type {string} */ script, /** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], { encoding: "utf8" });
const TOOLS = ["relay.enable", "relay.pair.start", "wink.phone.open"];

/** @param {any} t @param {Record<string, string | undefined>} env */
function withEnv(t, env) {
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

test("a software-key proof over the call opens relay.enable, relay.pair.start and wink.phone.open on a development build, once and only for that call", { timeout: 120_000 }, async t => {
  withEnv(t, { VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1", VYRE_KERNEL_PATH_RULE: "1" });
  const root = tempHome(t);
  homeIdentity(root);
  const enrol = run("dev-enrol-software-key.mjs", ["--home", root]);
  assert.equal(enrol.status, 0, enrol.stderr);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 100)); // the sealing process takes no proof made before it started
  /** @param {string} tool @param {any} [input] */
  const sign = (tool, input = {}) => { const r = run("dev-sign-proof.mjs", ["--home", root, "--yes", "pair", "--tool", tool, "--input", JSON.stringify(input), "--header"]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  /** @param {string} tool @param {any} input @param {string} [header] */
  const at = (tool, input, header) => call(tool, input, { root, caller: "cli", ...(header ? { headers: { "x-vyre-presence": header } } : {}) });
  for (const tool of TOOLS) {
    assert.equal((await at(tool, {})).error?.code, "presence_required", `${tool}: no proof, no way in`);
    // a proof for another tool, or another input, is not this call's yes
    const other = sign(TOOLS.find(x => x !== tool) || "relay.enable");
    assert.equal((await at(tool, {}, other)).error?.code, "presence_required", `${tool}: another tool's proof`);
    const good = sign(tool);
    const r = await at(tool, {}, good);
    assert.notEqual(r.error?.code, "presence_required", `${tool}: the owner's software proof stands on a development build (${JSON.stringify(r.error)})`);
    assert.notEqual(r.error?.code, "software_key");
    // spent: the same proof does not open it again
    assert.equal((await at(tool, {}, good)).error?.code, "presence_required", `${tool}: a proof is single use`);
  }
  // a tool that is not one of the moments takes no such proof, however well signed
  const bad = sign("relay.disable");
  assert.equal((await at("relay.disable", {}, bad)).error?.code, "presence_required");
});

test("a release build refuses the software-key proof for the same three tools", { timeout: 120_000 }, async t => {
  // the key is enrolled and the proof signed with the development switches (a person's key is the same either way), then a daemon with no dev switch is asked
  withEnv(t, { VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1", VYRE_KERNEL_PATH_RULE: "1" });
  const root = tempHome(t);
  homeIdentity(root);
  assert.equal(run("dev-enrol-software-key.mjs", ["--home", root]).status, 0);
  /** @param {string} tool */
  const sign = tool => { const r = run("dev-sign-proof.mjs", ["--home", root, "--yes", "pair", "--tool", tool, "--input", "{}", "--header"]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const proofs = Object.fromEntries(TOOLS.map(x => [x, sign(x)]));
  withEnv(t, { VYRE_SEAL_DEV: undefined, VYRE_SEAL_SOFTWARE: undefined });
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 100));
  for (const tool of TOOLS) {
    const r = await call(tool, {}, { root, caller: "cli", headers: { "x-vyre-presence": proofs[tool] } });
    assert.ok(["software_key", "presence_required"].includes(String(r.error?.code)), `${tool}: refused on a release build (${JSON.stringify(r.error || r.data)})`);
  }
});

test("typing the ack back (wink.code.ack) takes the owner's software yes on a development build, bound to its offer and typed code", { timeout: 120_000 }, async t => {
  withEnv(t, { VYRE_SEAL_DEV: "1", VYRE_SEAL_SOFTWARE: "1", VYRE_KERNEL_PATH_RULE: "1" });
  const root = tempHome(t);
  homeIdentity(root);
  assert.equal(run("dev-enrol-software-key.mjs", ["--home", root]).status, 0);
  const d = await start({ root, log: () => {}, kernel: true });
  t.after(() => d.stop());
  await new Promise(r => setTimeout(r, 100));
  const input = { offer: "of_notreal", typed: "WINK-AAAA-AAAA" };
  /** @param {any} i */
  const sign = i => { const r = run("dev-sign-proof.mjs", ["--home", root, "--yes", "pair", "--tool", "wink.code.ack", "--input", JSON.stringify(i), "--header"]); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const at = (/** @type {any} */ i, /** @type {string} */ h) => call("wink.code.ack", i, { root, caller: "cli", ...(h ? { headers: { "x-vyre-presence": h } } : {}) });
  assert.equal((await at(input)).error?.code, "presence_required", "no proof, no way in");
  assert.equal((await at(input, sign({ ...input, typed: "WINK-BBBB-BBBB" }))).error?.code, "presence_required", "a proof for another typed code is not this call's");
  const r = await at(input, sign(input));
  assert.notEqual(r.error?.code, "presence_required", `the owner's software proof stands (${JSON.stringify(r.error)})`);
});
