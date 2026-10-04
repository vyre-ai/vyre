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
import { codeKey } from "./recovery.js";
import { recoverIdentity, replaceRecoveryCode } from "./restore.ts";
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

test("RX-1: a phone (requireEnclave) without its Secure Enclave key signs and keeps nothing; with it the entry carries `enclave`", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "kim", base, params: PARAMS });
  await assert.rejects(recoverIdentity({ name: "kim", code: made.recoveryCode, deviceLabel: "phone", base, params: PARAMS, requireEnclave: true }), { code: "not_hardware" });
  assert.equal((await resolve(base, "kim")).ops.length, 1, "nothing was appended");
  assert.equal(await loadIdentity(), null, "and nothing kept");
  const point = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
  // the chain checks the enclave point's shape, so a stand-in point is refused by the directory: the entry still carries it on its way (the op is built with it)
  let sent = null;
  const spy = async (url, init) => { if (init && init.method === "POST") sent = JSON.parse(init.body); return fetch(url, init); };
  await recoverIdentity({ name: "kim", code: made.recoveryCode, deviceLabel: "phone", base, params: PARAMS, requireEnclave: true, enclave: point, fetch: spy }).catch(() => {});
  assert.ok(sent && sent.ops[0].entry.enclave === point, "the add op's entry carries the enclave key");
  await forgetIdentity();
});

test("RX-2: a publish whose answer is lost after the directory applied it keeps the identity; a clear refusal forgets it", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "lee", base, params: PARAMS });
  // the directory applies the append, then the connection drops
  const dropAfter = async (url, init) => { const r = await fetch(url, init); if (init && init.method === "POST") throw new TypeError("connection dropped"); return r; };
  const got = await recoverIdentity({ name: "lee", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS, fetch: dropAfter });
  assert.equal(got.id, made.id, "the lost answer did not lose the recovery");
  assert.ok(await loadIdentity(), "the identity is kept");
  assert.equal((await resolve(base, "lee")).ops.length, 2, "one op, not two");
  // a second call is idempotent and adds nothing
  await recoverIdentity({ name: "lee", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS });
  assert.equal((await resolve(base, "lee")).ops.length, 2);
  await forgetIdentity();
  // a clear refusal (the directory answers 4xx) forgets the key
  const made2 = await claimIdentity({ name: "moe", base, params: PARAMS });
  const refuse = async (url, init) => (init && init.method === "POST" ? new Response(JSON.stringify({ error: { code: "bad_op", message: "no" } }), { status: 400 }) : fetch(url, init));
  await assert.rejects(recoverIdentity({ name: "moe", code: made2.recoveryCode, deviceLabel: "p", base, params: PARAMS, fetch: refuse }));
  assert.equal(await loadIdentity(), null, "a refusal kept nothing");
});

test("replaceRecoveryCode: a device under 24 hours old is refused (newcomer) and changes nothing; a day later the op replaces the code on the list (the directory refuses back-dated ops, so its answer is faked)", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "lee", base, params: PARAMS });
  await recoverIdentity({ name: "lee", code: made.recoveryCode, deviceLabel: "new phone", base, params: PARAMS });
  await assert.rejects(replaceRecoveryCode({ base, params: PARAMS }), { code: "newcomer" });
  assert.equal((await resolve(base, "lee")).ops.length, 2, "nothing was appended");
  const later = () => Date.now() + 25 * 3600_000;
  const posted = [];
  const fake = async (_url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ data: {} }) }; };
  const got = await replaceRecoveryCode({ base, params: PARAMS, now: later, fetch: fake });
  assert.notEqual(got.recoveryCode, made.recoveryCode);
  assert.equal(posted.length, 1);
  const ops = (await resolve(base, "lee")).ops;
  const state = await C.verifyChain([...ops, ...posted[0].ops], { now: later() + C.SKEW_MS });
  assert.equal(state.entries.filter(e => e.kind === "code").length, 1);
  assert.equal(state.entries.find(e => e.kind === "code").eid, (await codeKey(got.recoveryCode, "", PARAMS)).eid, "the list holds the new code and no other");
  assert.equal((await loadIdentity()).ops.length, 3, "kept");
  await forgetIdentity();
});

test("RX-2a: a retry while the directory is down does not say success; with the directory back it sends the op and succeeds", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "ola", base, params: PARAMS });
  // the first publish is lost: the append is refused as unreachable and the re-read cannot be read either
  const down = async () => { throw new Error("down"); };
  let gets = 0;
  const lost = async (u, i) => ((i && i.method) === "POST" || ++gets > 1 ? down() : fetch(u, i));
  await assert.rejects(recoverIdentity({ name: "ola", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS, fetch: lost }), { code: "unreachable" });
  assert.equal((await resolve(base, "ola")).ops.length, 1, "nothing was published");
  assert.ok(await loadIdentity(), "the key stays");
  await assert.rejects(recoverIdentity({ name: "ola", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS, fetch: down }), { code: "unreachable" });
  assert.equal((await resolve(base, "ola")).ops.length, 1);
  const got = await recoverIdentity({ name: "ola", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS });
  assert.equal(got.name, "ola");
  assert.equal((await resolve(base, "ola")).ops.length, 2, "the retry sent the op");
  await forgetIdentity();
});

test("RX-2b: a directory that lies (a list without the key) after a lost answer does not make the phone keep it; one that cannot be verified is not 'there'", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "pia", base, params: PARAMS });
  let reads = 0;
  const liar = async (u, i) => {
    if (i && i.method === "POST") throw new Error("lost");
    if (++reads > 1) return { ok: true, status: 200, json: async () => ({ data: { kind: "person", id: made.id, ops: [{ junk: true, entry: { eid: "anything" } }] } }) };
    return fetch(u, i);
  };
  await assert.rejects(recoverIdentity({ name: "pia", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS, fetch: liar }), { code: "unreachable" });
  await forgetIdentity();
});

test("RC-1: the new code is saved before it is published and is not returned when the publish is refused (the old list is put back)", { timeout: 90_000 }, async t => {
  await forgetIdentity();
  const base = await standIn(t);
  const made = await claimIdentity({ name: "ida", base, params: PARAMS });
  await recoverIdentity({ name: "ida", code: made.recoveryCode, deviceLabel: "p", base, params: PARAMS });
  const later = () => Date.now() + 25 * 3600_000;
  const refuse = async () => ({ ok: false, status: 409, json: async () => ({ error: { code: "conflict", message: "no" } }) });
  await assert.rejects(replaceRecoveryCode({ base, params: PARAMS, now: later, fetch: refuse }));
  assert.equal((await loadIdentity()).ops.length, 2, "the old list is back");
  await forgetIdentity();
});
