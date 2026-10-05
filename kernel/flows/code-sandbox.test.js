// @ts-check
// The Code step's sandbox port, on a machine that has an OS sandbox (Linux with bubblewrap, or macOS). Where none exists the port refuses and the tests that need it say so and skip.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createCodeSandbox } from "./code-sandbox.js";
import { mechanism } from "../modules/sandbox.js";

const req = (/** @type {string} */ source, inputs = {}, outputs = ["v"], needs = []) => ({ language: "js", source, hash: "h", inputs, outputs, needs });
const have = mechanism() !== null;

test("code sandbox: computes from declared inputs, async works, and a thrown error is a failure with its message", { skip: !have && "no OS sandbox here" }, async () => {
  const run = createCodeSandbox();
  assert.deepEqual(await run(req("const d = new Date(inputs.signed + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + inputs.days); return { v: d.toISOString().slice(0, 10) };", { signed: "2026-10-05", days: 30 })), { outputs: { v: "2026-11-04" } });
  assert.deepEqual((await run(req("await null; return { v: inputs.a + inputs.b };", { a: 1, b: 2 }))).outputs, { v: 3 });
  await assert.rejects(run(req("throw new Error('nope');")), /the code failed: nope/);
  await assert.rejects(run(req("return 5;")), /must return an object/);
});

test("code sandbox: no network, no files, no child process, no environment, no secrets of the host", { skip: !have && "no OS sandbox here" }, async () => {
  const run = createCodeSandbox();
  const probe = (/** @type {string} */ body) => run(req(`${body}`));
  const blocked = async (/** @type {string} */ body) => (await probe(`try { ${body} return { v: "allowed" }; } catch { return { v: "blocked" }; }`)).outputs.v;
  assert.equal(await blocked("const fs = await import('node:fs'); fs.readFileSync('/etc/passwd', 'utf8');"), "blocked");
  assert.equal(await blocked("const fs = await import('node:fs'); fs.writeFileSync('/module/x', 'y');"), "blocked");
  assert.equal(await blocked("const cp = await import('node:child_process'); cp.spawnSync('/bin/true');"), "blocked");
  assert.equal(await blocked("await new Promise((res, rej) => { import('node:net').then(n => { const s = n.connect({ host: '127.0.0.1', port: 9 }, () => res(1)); s.on('error', rej); setTimeout(() => rej(new Error('t')), 1500); }); });"), "blocked");
  assert.equal((await probe("return { v: Object.keys(process.env).filter(k => !['PATH', 'PWD', 'VYRE_MODULE_ENTRY'].includes(k)).length };")).outputs.v, 0, "no environment");
});

test("code sandbox: a loop that never ends is killed at the time limit, and memory is capped", { skip: !have && "no OS sandbox here" }, async () => {
  const run = createCodeSandbox({ timeoutMs: 1500 });
  const t0 = Date.now();
  await assert.rejects(run(req("while (true) {}")), (/** @type {any} */ e) => e.code === "timeout");
  assert.ok(Date.now() - t0 < 6000);
  await assert.rejects(run(req("const a = []; for (;;) a.push(new Array(1e6).fill(1));")), (/** @type {any} */ e) => e.code === "failed" || e.code === "timeout");
  // FS-1: a Buffer is outside the V8 heap; the address-space cap stops 1 GB of them (and the host is untouched: the next call still runs)
  await assert.rejects(createCodeSandbox({ timeoutMs: 8000 })(req("const b = []; for (let i = 0; i < 4; i++) b.push(Buffer.alloc(256 * 1024 * 1024, 1)); return { v: b.length };")), (/** @type {any} */ e) => e.code === "failed");
  assert.deepEqual((await run(req("return { v: 1 };"))).outputs, { v: 1 });
});

test("code sandbox: a declared power is refused, not granted; another language is refused; no proof means no run", async () => {
  const run = createCodeSandbox({ supervisor: { available: () => false, proof: () => ({ ok: false, why: "no OS sandbox on this platform" }), selfTest: async () => ({ ok: false, why: "no OS sandbox on this platform" }) } });
  await assert.rejects(run(req("return {};", {}, [], /** @type {any} */ (["net"]))), /grants no powers/);
  await assert.rejects(run({ ...req("return {};"), language: "py" }), /only js/);
  await assert.rejects(run(req("return { v: 1 };")), (/** @type {any} */ e) => e.code === "unavailable" && /cannot prove a code sandbox/.test(e.message));
});
