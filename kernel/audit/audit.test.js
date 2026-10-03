import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCheckpointer, verifyLog, verifyCheckpoint, createDeviceCheckpoints, compareCheckpoints, ed25519Signer } from "./index.js";
import { createEventLog } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";

const SPACE = "spc_aaaaaaaaaaaa";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 6), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const keys = () => crypto.generateKeyPairSync("ed25519");
const fill = (log, n, from = 0) => { for (let i = 0; i < n; i++) log.append(owner(), { type: "note.added", sv: 1, subject: `vyre://${SPACE}/note/n${from + i}`, data: { i: from + i } }); };
const rig = (over = {}) => {
  const log = createEventLog({ space: SPACE, clock });
  const { publicKey, privateKey } = keys();
  const cp = createCheckpointer({ space: SPACE, log, chains, sign: ed25519Signer(privateKey), key_id: "space-key-1", clock, ...over });
  return { log, cp, publicKey, privateKey };
};

test("checkpoints: signed over the head before their own event, appended, and verify walks them", async () => {
  const { log, cp, publicKey } = rig();
  fill(log, 5);
  const c = await cp.sign();
  assert.equal(c.seq, 5);
  assert.equal(c.hash, log.read({})[4].hash);
  assert.equal(log.latestSeq(), 6, "the checkpoint is itself an event, after the head it names");
  assert.ok(verifyCheckpoint(c, publicKey));
  assert.equal(verifyCheckpoint({ ...c, seq: 4 }, publicKey), false, "a changed field breaks the signature");
  assert.equal(verifyCheckpoint(c, keys().publicKey), false, "another key");
  fill(log, 3, 5);
  await cp.sign();
  const v = verifyLog({ space: SPACE, log, publicKey });
  assert.deepEqual([v.ok, v.checkpoints, v.problems], [true, 2, []]);
});

test("checkpoints: tick signs after 1,000 events or 10 minutes, and never when nothing happened", async () => {
  const { log, cp } = rig({ every_events: 10, every_ms: 600_000 });
  assert.equal(await cp.tick(), null, "nothing yet");
  fill(log, 3);
  assert.equal(await cp.tick(), null, "too few events, too soon");
  fill(log, 7, 3);
  assert.ok(await cp.tick(), "10 events");
  assert.equal(await cp.tick(), null, "nothing since");
  fill(log, 1, 10);
  T += 601_000;
  assert.ok(await cp.tick(), "10 minutes with something to say");
});

test("audit verify: a forged checkpoint, an edited event and a checkpoint naming another history are found", async () => {
  const { log, cp, publicKey } = rig();
  fill(log, 4);
  await cp.sign();
  const good = verifyLog({ space: SPACE, log, publicKey });
  assert.equal(good.ok, true);
  // a checkpoint signed by someone else
  const evil = keys();
  const forged = createCheckpointer({ space: SPACE, log, chains, sign: ed25519Signer(evil.privateKey), key_id: "space-key-1", clock });
  await forged.sign();
  const v = verifyLog({ space: SPACE, log, publicKey });
  assert.equal(v.ok, false);
  assert.ok(v.problems.some(p => /signature/.test(p.why)));
  // a log that kept the signed checkpoint but whose history differs below it
  const other = createEventLog({ space: SPACE, clock });
  fill(other, 4, 100);
  const stolen = log.read({ type: "checkpoint.signed" })[0];
  const spliced = [...other.read({}), { ...stolen, seq: 5, prev: other.head() }];
  assert.equal(verifyLog({ space: SPACE, log: { read: () => spliced }, publicKey }).ok, false);
});

test("device checkpoints: a rollback, a rewrite and a split are detected; an older checkpoint is refused", async () => {
  const { log, cp, publicKey } = rig();
  const dev = createDeviceCheckpoints({ space: SPACE, publicKey });
  fill(log, 6);
  const c1 = await cp.sign();
  assert.deepEqual(dev.accept(c1), { ok: true });
  assert.deepEqual(dev.check(log), { ok: true });
  fill(log, 4, 6);
  const c2 = await cp.sign();
  assert.deepEqual(dev.accept(c2), { ok: true });
  assert.deepEqual(dev.accept(c1), { ok: false, why: "older_than_held" }, "the home cannot walk a device back");
  assert.deepEqual(dev.accept({ ...c2, signature: "AAAA" }), { ok: false, why: "bad_signature" });
  // rolled back: a copy of the log from before c2
  const earlier = createEventLog({ space: SPACE, clock });
  for (const e of log.read({}).slice(0, 7)) earlier.append(owner(), { type: e.type, sv: 1, subject: e.subject, data: e.data });
  assert.deepEqual(dev.check(earlier), { ok: false, why: "rolled_back" });
  // rewritten: same length, different events
  const rewritten = createEventLog({ space: SPACE, clock });
  fill(rewritten, log.latestSeq(), 500);
  assert.deepEqual(dev.check(rewritten), { ok: false, why: "history_differs" });
  // split: the home shows device B another history at the same position
  const fork = rig();
  fill(fork.log, 6, 900);
  const cb = await createCheckpointer({ space: SPACE, log: fork.log, chains, sign: ed25519Signer(fork.privateKey), key_id: "space-key-1", clock }).sign();
  assert.deepEqual(compareCheckpoints(c1, { ...c1 }, publicKey), { ok: true });
  const sameSeq = createDeviceCheckpoints({ space: SPACE, publicKey });
  sameSeq.accept(c1);
  assert.equal(compareCheckpoints(c1, c1, publicKey).ok, true);
  assert.equal(compareCheckpoints(c1, cb, fork.publicKey).ok, false, "not the same key at all");
  void sameSeq;
});

test("device checkpoints: two devices holding one position with two hashes expose a split; with a log they check inclusion", async () => {
  const { log, cp, publicKey, privateKey } = rig();
  fill(log, 5);
  const a = await cp.sign();
  const sign = ed25519Signer(privateKey);
  const body = { space: SPACE, seq: a.seq, hash: "x".repeat(43), time: a.time, key_id: a.key_id };
  const b = { ...body, signature: sign(Buffer.from("vyre-checkpoint-v1\n" + JSON.stringify({ hash: body.hash, key_id: body.key_id, seq: body.seq, space: body.space, time: body.time }))) };
  assert.equal(compareCheckpoints(a, b, publicKey).ok, false);
  fill(log, 3, 5);
  const c = await cp.sign();
  assert.deepEqual(compareCheckpoints(a, c, publicKey, log), { ok: true });
  const other = createEventLog({ space: SPACE, clock });
  fill(other, 12, 300);
  assert.deepEqual(compareCheckpoints(a, c, publicKey, other), { ok: false, why: "history_differs" });
});
