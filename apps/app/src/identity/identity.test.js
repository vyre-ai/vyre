// @ts-check
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as C from "../../../../kernel/identity/chain.js";
import { argon2id, STRETCH as NODE_STRETCH } from "../../../../kernel/identity/stretch.js";
import { codeKey as nodeCodeKey } from "../../../../core/spaces/recovery.js";
import { sealRecord as nodeSeal, openRecord as nodeOpen, idDirectory, memorySeen, memorySigner } from "../../../../lib/identity/directory.js";
import { newCode, codeKey, normalizeCode, codeLooksRight, STRETCH } from "./recovery.js";
import { sealRecord, openRecord } from "./seal.js";
import { generateDeviceKey, fromSeed, restoreDeviceKey, wrapKept } from "./keys.js";
import { claimIdentity } from "./claim.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FAST = { memoryKiB: 64, passes: 2 };

test("the app's work factor is the Node file's", () => {
  assert.equal(STRETCH.memoryKiB, NODE_STRETCH.memoryKiB);
  assert.equal(STRETCH.passes, NODE_STRETCH.passes);
});

test("a recovery code: 26 base32 characters in groups of four, forgiving to type back", () => {
  const c = newCode();
  assert.match(c, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  assert.equal(codeLooksRight(c), true);
  assert.equal(normalizeCode(c.toUpperCase().replace(/-/g, " ")), normalizeCode(c));
  assert.equal(codeLooksRight("nope"), false);
  assert.notEqual(newCode(), newCode());
  // the same bytes give the same code as the Node version: 16 zero bytes
  assert.equal(newCode(n => new Uint8Array(n)), "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aa");
});

test("the recovery key is byte-identical to Node's, with the real work factor and with a small one", async () => {
  const code = "abcd-efgh-ijkl-mnop-qrst-uvwx-yz";
  for (const [password, params] of [["", FAST], ["four words in a row", FAST], ["four words in a row", STRETCH]]) {
    const mine = await codeKey(code, password, params);
    const node = nodeCodeKey(code, password, params);
    assert.deepEqual(mine, { eid: node.eid, publicKey: node.publicKey }, `password "${password}" memory ${params.memoryKiB}`);
  }
  // and the stretch itself: the seed Node derives from the same secret
  const seed = argon2id(Buffer.from(`${normalizeCode(code)}\n`), "vyre-recovery-code-v1", FAST);
  assert.equal(seed.length, 32);
});

test("a sealed record opens in the other implementation, both ways, and only for its own name", async () => {
  const payload = { v: 1, home: { kind: "this-computer" } };
  const mine = await sealRecord("alex", payload);
  assert.deepEqual(nodeOpen("alex", mine), payload);
  assert.equal(nodeOpen("someone", mine), null);
  const theirs = nodeSeal("alex", payload);
  assert.deepEqual(await openRecord("alex", theirs), payload);
  assert.equal(await openRecord("someone", theirs), null);
  // same key and associated data: the same iv gives the same bytes
  const iv = new Uint8Array(12).fill(7);
  assert.equal(await sealRecord("alex", payload, () => iv), nodeSeal("alex", payload, () => Buffer.from(iv)));
  assert.equal(await openRecord("alex", "not base64!"), null);
});

test("a device key is non-extractable where WebCrypto has Ed25519, and the noble one signs the same way", async () => {
  const k = await generateDeviceKey();
  if (!k.software) {
    const kept = /** @type {any} */ (k.keep());
    assert.equal(kept.pair.privateKey.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("pkcs8", kept.pair.privateKey));
    const again = await restoreDeviceKey(kept);
    assert.equal(again.eid, k.eid);
  }
  const msg = new TextEncoder().encode("hello");
  for (const key of [k, await fromSeed(crypto.getRandomValues(new Uint8Array(32)))]) {
    const sig = await key.sign(msg);
    assert.equal(sig.length, 64);
    assert.equal(await C.verifyWith(key.publicKey, msg, C.b64u(sig)), true);
    assert.equal(key.eid, await C.eidOf(key.publicKey));
  }
});

test("KP-2: a software key is stored sealed under a non-extractable key, never as the 32 seed bytes, and restores to the same eid", async () => {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const k = await fromSeed(seed);
  const kept = /** @type {any} */ (await wrapKept(k.keep()));
  assert.equal(kept.kind, "wrapped-seed");
  assert.equal(kept.wk.extractable, false);
  await assert.rejects(crypto.subtle.exportKey("raw", kept.wk));
  const hex = x => Buffer.from(x).toString("hex");
  for (const [name, v] of Object.entries(kept)) if (v instanceof Uint8Array) assert.notEqual(hex(v), hex(seed), `${name} is not the seed`);
  assert.equal(JSON.stringify(kept, (_, v) => (v instanceof Uint8Array ? hex(v) : v)).includes(hex(seed)), false, "the seed's bytes are nowhere in the stored record");
  assert.equal((await restoreDeviceKey(kept)).eid, k.eid);
  const webcrypto = { kind: "webcrypto", pair: {} };
  assert.equal(await wrapKept(webcrypto), webcrypto, "a WebCrypto key pair is stored as it is");
});

test("KP-3: the key is kept before the name is claimed; a failed keep claims nothing", async () => {
  let fetched = 0;
  const fetch = async () => { fetched++; return /** @type {any} */ ({ ok: true, json: async () => ({ data: {} }) }); };
  await assert.rejects(claimIdentity({ name: "alex", base: "http://x", fetch, params: { memoryKiB: 8, passes: 1 }, beforeClaim: async () => { throw new Error("quota"); } }), /quota/);
  assert.equal(fetched, 0, "nothing was sent to the directory");
  let seen = null;
  await claimIdentity({ name: "alex", base: "http://x", fetch, params: { memoryKiB: 8, passes: 1 }, beforeClaim: async m => { seen = m; assert.equal(fetched, 0, "the keep comes first"); } });
  assert.equal(fetched, 1);
  assert.ok(seen && /** @type {any} */ (seen).key && /** @type {any} */ (seen).ops.length === 1);
});

const freePort = () => new Promise(res => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = /** @type {any} */ (s.address()).port; s.close(() => res(p)); }); });
async function standIn(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(REPO, "scripts/standin-directory.mjs"), "--port", String(port)], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => { child.kill("SIGTERM"); });
  await new Promise((res, rej) => { child.stdout.on("data", d => { if (String(d).includes("stand-in names directory")) res(null); }); child.on("exit", c => rej(new Error(`the stand-in exited early (${c})`))); });
  return `http://127.0.0.1:${port}`;
}

test("a claim made in the app is accepted by the real directory code and verifies with the Node client", { timeout: 60_000 }, async t => {
  const base = await standIn(t);
  const made = await claimIdentity({ name: "appalex", password: "four words in a row", deviceLabel: "Vyre on Mac", base, params: FAST });
  assert.match(made.id, /^per_[a-z2-7]{26}$/);
  assert.equal(made.ops.length, 1);
  assert.match(made.recoveryCode, /^([a-z2-7]{4}-){6}[a-z2-7]{2}$/);
  // The Node client reads it back: the chain verifies, two entries (device and code), the sealed record opens
  const dir = idDirectory({ base, seen: memorySeen() });
  const r = await dir.resolve("appalex");
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.id, made.id);
  assert.deepEqual(r.state.entries.map(e => e.kind).sort(), ["code", "device"]);
  assert.deepEqual(r.payload, { v: 1 });
  // and the code's entry is the one the Node derivation gives for the same code
  const code = r.state.entries.find(e => e.kind === "code");
  assert.equal(code.eid, nodeCodeKey(made.recoveryCode, "four words in a row", FAST).eid);
  // the name is now taken
  await assert.rejects(claimIdentity({ name: "appalex", base, params: FAST }), e => e.code !== undefined);
});

test("a claim made by the Node client is read by the app's code: the chain verifies and the sealed record opens", { timeout: 60_000 }, async t => {
  const base = await standIn(t);
  const kp = crypto.generateKeyPairSync("ed25519");
  const signer = memorySigner(kp.privateKey);
  const g = await C.makeGenesis({ kind: "person", entry: { eid: signer.eid, kind: "device", pub: signer.publicKey }, nonce: "nodenonce123", ts: Date.now(), sign: signer.sign });
  const state = await C.verifyChain([g], { now: Date.now() + 1 });
  const dir = idDirectory({ base, seen: memorySeen() });
  await dir.claim("nodebob", state, [g], signer, { v: 1, from: "node" });
  const raw = await (await fetch(`${base}/v1/ids/resolve?name=nodebob`)).json();
  const got = await C.verifyChain(raw.data.ops, { now: Date.now() + C.SKEW_MS, seenAt: () => 0 });
  assert.equal(got.id, g.id);
  assert.deepEqual(await openRecord("nodebob", raw.data.sealed), { v: 1, from: "node" });
});
