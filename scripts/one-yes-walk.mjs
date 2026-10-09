#!/usr/bin/env node
// scripts/one-yes-walk.mjs: the one-yes walk on a real daemon (a fresh home, the real sealing process, a development software key standing in for the device that gives the yes). One line per step, PASS or FAIL.
// It walks the three moments of DESIGN-one-yes.md the way a person meets them, before and after any change to how a yes is asked or kept:
//   pair      relay.enable needs the yes; no proof, another tool's proof and a replayed proof are refused.
//   vault     vault.reveal and vault.backup (a value tool that used to ask the vault's own prove.js as well) need the yes; the value comes back once.
//   outward   an assistant's mail.send is HELD as one card in the one approvals queue; the device's yes on that card lets exactly that call through, once.
//   waiting   what waits for the person is read from one place (core/waiting): the held card is listed there.
// Run it on a test box, never on the Mac:  node scripts/one-yes-walk.mjs [--out DIR]
import "./mac-test-guard.mjs";
import "../test/helpers.js";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRun } from "./lib/proof/run.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const out = path.resolve(argv.includes("--out") ? argv[argv.indexOf("--out") + 1] : path.join(os.tmpdir(), `one-yes-walk-${process.pid}`));
process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_SEAL_SOFTWARE = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
const { start } = await import("../core/daemon/index.js");
const { call } = await import("../core/daemon/client.js");
const { homeIdentity } = await import("../kernel/home.js");

const script = (/** @type {string} */ name, /** @type {string[]} */ args) => spawnSync(process.execPath, [path.join(ROOT, "scripts", name), ...args], { encoding: "utf8" });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-yes-walk-home-"));
homeIdentity(root);
const enrol = script("dev-enrol-software-key.mjs", ["--home", root]);
if (enrol.status !== 0) { process.stderr.write(`one-yes-walk: could not enrol the stand-in device key: ${enrol.stderr}\n`); process.exit(2); }
const d = await start({ root, log: () => {}, kernel: true });
await new Promise(r => setTimeout(r, 300)); // the sealing process takes no proof made before it started

/** The device's yes over one tool call, as the header value. @param {"pair" | "vault" | "outward"} moment @param {string} tool @param {any} [input] */
const yes = (moment, tool, input = {}) => { const r = script("dev-sign-proof.mjs", ["--home", root, "--yes", moment, "--tool", tool, "--input", JSON.stringify(input), "--header"]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
/** The device's signature over a card's payload, as the kernel-proof header value. @param {{ op: string, fields: any }} sign */
const cardProof = sign => { const r = script("dev-sign-proof.mjs", ["--home", root, "--op", sign.op, "--fields", JSON.stringify(sign.fields), "--header"]); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
/** @param {string} tool @param {any} input @param {{ yes?: string, caller?: string, headers?: Record<string, string> }} [o] */
const at = (tool, input, o = {}) => call(tool, input, { root, caller: o.caller || "cli", headers: { ...(o.yes ? { "x-vyre-presence": o.yes } : {}), ...(o.headers || {}) } });
const refused = (/** @type {any} */ r) => r && r.error && r.error.code === "presence_required";

const run = createRun({ out });
try {
  // A value to reveal. A person's put needs a method of its own (not one of the three moments), so the walk seeds it the way the daemon's own tests do, straight into the module.
  const seeded = await d.registry.tools.get("vault.put").run({ name: "walk-key", kind: "api-key", value: "walk-secret-value" }, { caller: "module:vault", firstParty: true });
  assert.ok(seeded && seeded.created, "the walk's item was made");

  await run.step("pair: relay.enable without a yes is refused", async () => { assert.ok(refused(await at("relay.enable", {})), "presence_required"); });
  await run.step("pair: another tool's yes is not this call's", async () => { assert.ok(refused(await at("relay.enable", {}, { yes: yes("pair", "relay.pair.start") }))); });
  await run.step("pair: the device's yes opens relay.enable, once", async () => {
    const h = yes("pair", "relay.enable");
    const r = await at("relay.enable", {}, { yes: h });
    assert.ok(!refused(r) && r.error?.code !== "software_key", `past the floor (${JSON.stringify(r.error || "ok")})`);
    assert.ok(refused(await at("relay.enable", {}, { yes: h })), "the same yes does not open it twice");
    return r.error ? `past the floor, then: ${r.error.code}` : "ok";
  });

  await run.step("vault: reveal without a yes is refused", async () => { assert.ok(refused(await at("vault.reveal", { name: "walk-key" }))); });
  await run.step("vault: a yes for another item is not this call's", async () => { assert.ok(refused(await at("vault.reveal", { name: "walk-key" }, { yes: yes("vault", "vault.reveal", { name: "other" }) }))); });
  await run.step("vault: the device's yes shows the value, once", async () => {
    const h = yes("vault", "vault.reveal", { name: "walk-key" });
    const r = await at("vault.reveal", { name: "walk-key" }, { yes: h });
    assert.equal(r.data?.value, "walk-secret-value", JSON.stringify(r.error || r.data));
    assert.ok(refused(await at("vault.reveal", { name: "walk-key" }, { yes: h })), "the same yes does not show it twice");
  });
  await run.step("vault: backup (a value tool the vault used to ask twice) takes the same yes", async () => {
    const file = path.join(root, "walk.vyre-backup"), input = { file, passphrase: "walk passphrase 123" };
    assert.ok(refused(await at("vault.backup", input)), "no yes, no backup");
    const r = await at("vault.backup", input, { yes: yes("vault", "vault.backup", input) });
    assert.ok(!refused(r), `the yes opened it (${JSON.stringify(r.error || r.data).slice(0, 160)})`);
    assert.ok(fs.existsSync(file) && fs.statSync(file).size > 0, "the backup file exists");
  });

  /** @type {any} */ let held = null;
  const mail = { to: "walk@example.com", subject: "walk", body: "hello from the walk" };
  await run.step("outward: an assistant's mail.send is held as one card, and nothing runs", async () => {
    held = await at("mail.send", mail, { caller: "mcp" });
    assert.equal(held.error?.code, "held_for_approval", JSON.stringify(held.error || held.data));
    assert.match(String(held.error.approval), /^ap_/);
  });
  await run.step("waiting: the held card is listed where the person looks (waiting.list)", async () => {
    const w = await at("waiting.list", {});
    assert.ok(!w.error, JSON.stringify(w.error));
    assert.ok(JSON.stringify(w.data).includes(held.error.approval), `waiting lists ${held.error.approval}`);
  }, { needs: ["outward: an assistant's mail.send is held as one card, and nothing runs"] });
  await run.step("outward: the card shows the exact call on the device", async () => {
    const list = await at("approvals.pending", {});
    const card = (list.data?.approvals || []).find((/** @type {any} */ c) => c.id === held.error.approval);
    assert.ok(card && card.sign, "the card carries what the device signs");
    held.card = card;
  }, { needs: ["outward: an assistant's mail.send is held as one card, and nothing runs"] });
  await run.step("outward: the assistant cannot run it again without the yes", async () => {
    const r = await at("mail.send", mail, { caller: "mcp" });
    assert.equal(r.error?.code, "held_for_approval", JSON.stringify(r.error || r.data));
  }, { needs: ["outward: the card shows the exact call on the device"] });
  await run.step("outward: the device's yes on the card is accepted", async () => {
    const r = await at("approvals.answer", { id: held.error.approval, approve: true }, { headers: { "x-vyre-kernel-proof": cardProof(held.card.sign) } });
    assert.equal(r.data?.answered, "approved", JSON.stringify(r.error || r.data));
  }, { needs: ["outward: the card shows the exact call on the device"] });
  await run.step("outward: the assistant's retry with the card goes through once, and only for that call", async () => {
    const other = await at("mail.send", { ...mail, subject: "another", approval: held.error.approval }, { caller: "mcp" });
    assert.notEqual(other.error?.code, "no_account", `another call does not ride this card (${JSON.stringify(other.error || other.data).slice(0, 120)})`);
    const r = await at("mail.send", { ...mail, approval: held.error.approval }, { caller: "mcp" });
    assert.equal(r.error?.code, "no_account", `the held call ran past the gate (${JSON.stringify(r.error || r.data).slice(0, 160)})`);
    const again = await at("mail.send", { ...mail, approval: held.error.approval }, { caller: "mcp" });
    assert.notEqual(again.error?.code, "no_account", "one card, one send");
  }, { needs: ["outward: the device's yes on the card is accepted"] });
} catch (e) {
  process.stderr.write(`one-yes-walk: the walk could not start: ${/** @type {Error} */ (e).stack || e}\n`);
  run.results.push({ name: "start", ok: false, why: String(e), ms: 0 });
} finally {
  const code = run.finish();
  await d.stop();
  process.exit(code);
}
