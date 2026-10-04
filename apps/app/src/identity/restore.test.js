import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as C from "../../../../kernel/identity/chain.js";
import { claimIdentity } from "./claim.js";
import { recoverIdentity } from "./restore.ts";
import { forgetIdentity, hadIdentity, loadIdentity } from "./store.ts";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const PARAMS = { memoryKiB: 8, passes: 1 };
const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function standIn(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, "scripts/standin-directory.mjs"), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  return `http://127.0.0.1:${port}`;
}
const resolve = async (base, name) => (await (await fetch(`${base}/v1/ids/resolve?name=${name}`)).json()).data;

test("recover: a wrong code is refused and changes nothing; the right code returns the same identity with one more device; a second recovery on this device is idempotent", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "robin", base, params: PARAMS });
  assert.equal((await resolve(base, "robin")).ops.length, 1);
  const wrongCode = made.recoveryCode.replace(/^./, c => (c === "a" ? "b" : "a"));
  await assert.rejects(recoverIdentity({ name: "robin", code: wrongCode, deviceLabel: "new phone", base, params: PARAMS }), { code: "wrong_code" });
  assert.equal((await resolve(base, "robin")).ops.length, 1, "a wrong code changed nothing at the directory");
  assert.equal(await loadIdentity(), null, "and kept nothing on this device");
  const got = await recoverIdentity({ name: "robin", code: made.recoveryCode, deviceLabel: "new phone", base, params: PARAMS });
  assert.deepEqual(got, { name: "robin", id: made.id }, "the same identity");
  const after = await resolve(base, "robin");
  assert.equal(after.ops.length, 2);
  const state = await C.verifyChain(after.ops, { now: Date.now() + C.SKEW_MS });
  assert.equal(state.entries.filter(e => e.kind === "device").length, 2, "one more device on the list");
  assert.ok(state.entries.find(e => e.label === "new phone"), "the new device is on the list under its label");
  const kept = await loadIdentity();
  assert.equal(kept.id, made.id);
  assert.notEqual(kept.eid, made.eid, "this device's own key, not the first device's");
  assert.equal(await hadIdentity(), true);
  // again on the same device: nothing more is appended
  assert.deepEqual(await recoverIdentity({ name: "robin", code: made.recoveryCode, deviceLabel: "new phone", base, params: PARAMS }), got);
  assert.equal((await resolve(base, "robin")).ops.length, 2, "idempotent: no third op");
  await assert.rejects(recoverIdentity({ name: "someone-else", code: made.recoveryCode, deviceLabel: "x", base, params: PARAMS }), { code: "exists" });
  await forgetIdentity();
  assert.equal(await hadIdentity(), false);
});

test("recover: no such name, a bad format, and a rolled-back chain (the pin) are refused with their codes", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  await assert.rejects(recoverIdentity({ name: "nobody", code: "aaaa-bbbb-cccc-dddd-eeee-ffff-gg", deviceLabel: "x", base, params: PARAMS }), { code: "not_found" });
  const made = await claimIdentity({ name: "sam", base, params: PARAMS });
  await assert.rejects(recoverIdentity({ name: "sam", code: "nope", deviceLabel: "x", base, params: PARAMS }), { code: "wrong_code" });
  // a device that saw the chain at seq 5 is told seq 0: refused, and nothing is changed
  await assert.rejects(recoverIdentity({ name: "sam", code: made.recoveryCode, deviceLabel: "x", base, params: PARAMS, pin: { id: made.id, seq: 5, head: "0".repeat(64) } }), { code: "rolled_back" });
  assert.equal((await resolve(base, "sam")).ops.length, 1);
  await assert.rejects(recoverIdentity({ name: "sam", code: made.recoveryCode, deviceLabel: "x", base: "http://127.0.0.1:9", params: PARAMS }), { code: "unreachable" });
  await forgetIdentity();
});
