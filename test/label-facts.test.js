// @ts-check
// LB-1 (reviewer-2): the kernel's person chain for a socket call was built from the x-vyre-caller LABEL alone. A person's surface label is a person only with the daemon's ancestry
// measurement (`callerFacts` takes it as input and gives nothing without it); from under a `claude` the label is a model's and the chain is never a person. Real daemon, kernel on, a fake
// `claude` above a forger for each label; a test box, never a Mac.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tempHome, writeModule } from "./helpers.js";
import { start, callerFacts } from "../core/daemon/index.js";
import { setPeerHosting } from "../core/daemon/peer.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
setPeerHosting(false);
const LABELS = ["cli", "local", "deck", "mobile"];
const k = { id: { owner: "per_" + "a".repeat(26) } };

test("callerFacts gives a person's-surface label nothing without the ancestry measurement, nothing from under a model, and person facts only from a measured outsider", () => {
  for (const label of LABELS) {
    assert.equal(callerFacts(label, {}, null, k), null, `${label}: no measurement, no facts`);
    assert.equal(callerFacts(label, {}, null, k, false, null, undefined), null);
    assert.equal(callerFacts(label, {}, null, k, false, null, /** @type {any} */ ({})), null, "a measurement that says nothing");
    const inside = /** @type {any} */ (callerFacts(label, {}, null, k, false, null, { inside: true }));
    assert.equal(inside.inside_model_process, true, `${label}: under a model the builder is told so`);
    const out = /** @type {any} */ (callerFacts(label, {}, null, k, false, null, { inside: false }));
    assert.equal(out.kind, "socket"); assert.equal(out.inside_model_process, false);
  }
});

/** A forger: a node script under a fake `claude`, sending `label` to the person's socket for `probe.who`. */
function forger(dir, socket, label) {
  const js = path.join(dir, `forge-${label}.mjs`);
  fs.writeFileSync(js, `import http from "node:http";
const req = http.request({ socketPath: ${JSON.stringify(socket)}, path: "/v1/tools/probe.who", method: "POST", headers: { "content-type": "application/json", "content-length": 2, "x-vyre-caller": ${JSON.stringify(label)} } }, res => { res.resume(); res.on("end", () => process.exit(0)); });
req.on("error", () => process.exit(0)); req.end("{}");`);
  fs.mkdirSync(path.join(dir, `f-${label}`), { recursive: true });
  const fake = path.join(dir, `f-${label}`, "claude");
  fs.writeFileSync(fake, `#!${process.execPath}
const c = require("node:child_process").spawn(process.execPath, [${JSON.stringify(js)}], { stdio: "ignore" });
c.on("exit", code => process.exit(code ?? 1));
`, { mode: 0o755 });
  return new Promise(resolve => { const p = spawn(process.execPath, [fake], { stdio: "ignore" }); p.on("close", resolve); });
}

test("on a real daemon: a process under a fake claude sending each person label gets no person chain and runs no person tool; the same label from outside any claude does", { timeout: 180_000, skip: process.platform === "win32" }, async t => {
  const root = tempHome(t);
  globalThis.__who = [];
  writeModule(path.join(root, "modules"), "probe", { does: { tools: ["probe.who"] }, needs: { kernel: { actions: [] } } }, `export default { async start(ctx) {
    ctx.tool("probe.who", { input: { type: "object" }, callers: ["cli", "local", "deck", "mobile", "mcp"], run: async (_i, meta) => {
      let kind = "none"; try { const c = await ctx.kernel.chain(meta); kind = c.hops.map(h => h.actor.kind).join(">"); } catch (e) { kind = "refused"; }
      globalThis.__who.push({ caller: meta.caller, kind }); return { kind };
    } });
    return {};
  } };`);
  const d = await start({ root, log: () => {}, kernel: true, firstPartyRoots: [path.join(root, "modules")] });
  t.after(() => d.stop());
  const dir = fs.mkdtempSync(path.join(root, "forge-"));
  for (const label of LABELS) await forger(dir, d.paths.socket, label);
  assert.equal(globalThis.__who.length, LABELS.length, "every forger reached the tool as something: " + JSON.stringify(globalThis.__who));
  assert.ok(globalThis.__who.every((/** @type {any} */ w) => w.caller === "mcp"), "each was relabelled a model's: " + JSON.stringify(globalThis.__who));
  const person = globalThis.__who.filter((/** @type {any} */ w) => /(^|>)person($|>)/.test(w.kind) && !/agent/.test(w.kind));
  assert.deepEqual(person, [], "no forged label under a claude got a person chain: " + JSON.stringify(globalThis.__who));
  // the control: the same label from a plain process (this test hosting vyred is the one seam) is the person's
  const js = path.join(dir, "person.mjs");
  fs.writeFileSync(js, `import http from "node:http";
const req = http.request({ socketPath: ${JSON.stringify(d.paths.socket)}, path: "/v1/tools/probe.who", method: "POST", headers: { "content-type": "application/json", "content-length": 2, "x-vyre-caller": "deck" } }, res => { res.resume(); res.on("end", () => process.exit(0)); });
req.end("{}");`);
  globalThis.__who = [];
  setPeerHosting(true);
  try { await new Promise(r => spawn(process.execPath, [js], { stdio: "ignore" }).on("close", r)); } finally { setPeerHosting(false); }
  assert.deepEqual(globalThis.__who.map((/** @type {any} */ w) => w.kind), ["person"], "the person's own deck label still gets the person chain");
});
