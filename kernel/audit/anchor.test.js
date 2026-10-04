// BL-2: the log anchor. The sealing process keeps the newest (seq, head) it was shown outside the database, forward only; each checkpoint advances it with a head just verified,
// and a restart compares the log with it, which the checkpoints inside the log cannot do (they go back with the log).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createCheckpointer, verifyTail, anchorCheck, ed25519Signer } from "./index.js";
import { createEventLog, verifyEvents } from "../core/events.js";
import { createChainBuilder } from "../core/chain.js";
import { createKernel } from "../index.js";

const SPACE = "spc_aaaaaaaaaaaa";
let T = 1_800_000_000_000;
const clock = () => ++T;
const chains = createChainBuilder({ space: SPACE, owner: "per_owner", owner_uid: 501, key: Buffer.alloc(32, 6), clock });
const owner = () => chains.fromFacts({ kind: "socket", surface: "deck", uid: 501, pid: 1, inside_model_process: false, capsule_verified: true });
const fill = (log, n, from = 0) => { for (let i = 0; i < n; i++) log.append(owner(), { type: "note.added", sv: 1, subject: `vyre://${SPACE}/note/n${from + i}`, data: { i: from + i } }); };
/** The sealing process's anchor, as the real one behaves: forward only, the same seq must carry the same head. */
const fakeAnchor = () => {
  let held = null;
  return {
    get held() { return held; },
    read: async () => held,
    advance: async ({ seq, head }) => {
      if (!Number.isInteger(seq) || seq < 1 || typeof head !== "string" || !head) throw Object.assign(new Error("bad_input"), { code: "bad_input" });
      if (held) { if (seq < held.seq) throw Object.assign(new Error("anchor_behind"), { code: "anchor_behind" }); if (seq === held.seq && head !== held.head) throw Object.assign(new Error("anchor_split"), { code: "anchor_split" }); }
      held = { seq, head };
      return held;
    },
    reset: () => { held = null; },
  };
};
/** The log as it was at event n: what a database put back to an older copy shows. */
const viewAt = (log, n) => {
  const prefix = () => log.read({}).filter(e => e.seq <= n);
  return { latestSeq: () => n, head: () => log.get(n).hash, get: s => (s <= n ? log.get(s) : undefined), read: f => log.read(f).filter(e => e.seq <= n),
    verify: o => (o && o.from ? { ok: true, head: log.get(n).hash, seq: n } : verifyEvents(SPACE, prefix())) };
};
const rig = (over = {}) => {
  const log = createEventLog({ space: SPACE, clock });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const anchor = fakeAnchor();
  const cp = createCheckpointer({ space: SPACE, log, chains, sign: ed25519Signer(privateKey), key_id: "k1", clock, publicKey, anchor, ...over });
  return { log, cp, publicKey, anchor };
};

test("BL-2: a fresh home has no anchor and boots; the first checkpoint writes it, and each later one moves it forward to the head it signed", async () => {
  const { log, cp, anchor } = rig();
  fill(log, 5);
  assert.deepEqual(await anchorCheck({ log, anchor }), { ok: true, seq: null }, "no anchor yet: boots");
  const c1 = await cp.sign();
  assert.deepEqual(anchor.held, { seq: c1.seq, head: c1.hash });
  assert.deepEqual(await anchorCheck({ log, anchor }), { ok: true, seq: c1.seq });
  fill(log, 4, 5);
  const c2 = await cp.sign();
  assert.deepEqual(anchor.held, { seq: c2.seq, head: c2.hash }, "moved forward");
  assert.ok(c2.seq > c1.seq);
});

test("BL-2: a database put back to an older copy is found by the anchor though its own checkpoints say it is fine (the probe: the newest events deleted)", async () => {
  const { log, cp, publicKey, anchor } = rig();
  fill(log, 300);
  const old = await cp.sign();
  fill(log, 300, 300);
  const newest = await cp.sign();
  fill(log, 4, 600);
  const back = viewAt(log, old.seq + 3);          // the copy from just after the older checkpoint
  assert.ok(back.latestSeq() < newest.seq);
  // the log's own check cannot see it: the older checkpoint is in the copy and still verifies
  assert.equal(verifyTail({ space: SPACE, log: back, publicKey }).ok, true, "tail check alone passes on a rollback");
  const a = await anchorCheck({ log: back, anchor });
  assert.deepEqual([a.ok, a.why, a.seq], [false, "anchor_rolled_back", newest.seq]);
  assert.deepEqual(await anchorCheck({ log, anchor }), { ok: true, seq: newest.seq }, "the real log passes");
});

test("BL-2: a log with another event at the anchor's position (rewritten and grown past it) is found", async () => {
  const { log, cp, anchor } = rig();
  fill(log, 20);
  const c = await cp.sign();
  const rewritten = { ...log, get: s => (s === c.seq ? { ...log.get(s), hash: "x".repeat(64) } : log.get(s)) };
  const a = await anchorCheck({ log: rewritten, anchor });
  assert.deepEqual([a.ok, a.why], [false, "anchor_history_differs"]);
});

test("BL-2a: the anchor moves only with a head just verified: a broken log signs no checkpoint and the anchor stays where it was", async () => {
  const { log, cp, anchor } = rig();
  fill(log, 10);
  const c = await cp.sign();
  fill(log, 6, 10);
  const before = log.latestSeq();
  const broken = { ...log, verify: () => ({ ok: false, at: 12, why: "hash does not match the envelope" }), read: f => log.read(f), get: s => (s === 12 ? { ...log.get(s), hash: "y" } : log.get(s)) };
  const cp2 = createCheckpointer({ space: SPACE, log: broken, chains, sign: () => "sig", key_id: "k1", clock, anchor });
  await assert.rejects(() => cp2.sign(), { code: "log_broken" });
  assert.deepEqual(anchor.held, { seq: c.seq, head: c.hash }, "unchanged");
  assert.equal(log.latestSeq(), before, "nothing was written");
});

test("BL-2a: an anchor that is ahead of the log refuses the checkpoint of a rolled-back log: nothing is written, nothing is signed into it", async () => {
  const { log, cp, anchor } = rig();
  fill(log, 30);
  const c = await cp.sign();
  fill(log, 30, 30);
  await cp.sign();
  // a log put back to just after the first checkpoint tries to checkpoint itself again
  const back = viewAt(log, c.seq + 1);
  let appended = 0;
  const writable = { ...back, append: () => { appended++; }, head: back.head, latestSeq: back.latestSeq };
  const cp2 = createCheckpointer({ space: SPACE, log: writable, chains, sign: () => "sig", key_id: "k1", clock, anchor });
  await assert.rejects(() => cp2.sign(), { code: "anchor_behind" });
  assert.equal(appended, 0, "no checkpoint event for a log the anchor says is behind");
});

test("BL-2: after the owner's reset the anchor reads null again and the log boots; the next checkpoint writes it afresh", async () => {
  const { log, cp, anchor } = rig();
  fill(log, 30);
  const c = await cp.sign();
  fill(log, 30, 30);
  await cp.sign();
  const back = viewAt(log, c.seq + 1);
  assert.equal((await anchorCheck({ log: back, anchor })).ok, false);
  anchor.reset();
  assert.deepEqual(await anchorCheck({ log: back, anchor }), { ok: true, seq: null });
});

test("BL-2: an anchor that cannot be read is a failed check, not a pass", async () => {
  const { log } = rig();
  fill(log, 3);
  const a = await anchorCheck({ log, anchor: { read: async () => { throw new Error("sealing process gone"); } } });
  assert.deepEqual([a.ok, a.why], [false, "anchor_unreadable"]);
});

test("BL-2 in the kernel: createKernel reads the sealing process's anchor at start and reports a rolled-back log in `boot`; with the Space's key it signs checkpoints that move the anchor", async () => {
  const anchor = fakeAnchor();
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const sign = ed25519Signer(privateKey);
  const sealer = { anchor: { read: async () => anchor.read(), advance: async i => anchor.advance(i) }, spaceKey: {
    pub: async () => ({ key_id: "k1", pub: publicKey.export({ type: "spki", format: "der" }).toString("base64") }), sign: async ({ bytes }) => ({ signature: await sign(Buffer.from(bytes)) }) } };
  const key = Buffer.alloc(32, 9);
  const log = createEventLog({ space: SPACE, clock });
  const k = await createKernel({ space: SPACE, owner: "per_owner", owner_uid: 501, key, log, sealer, checkpoints: true });
  assert.deepEqual([k.boot.ok, k.boot.anchor.seq], [true, null], "a fresh home boots");
  assert.ok(k.checkpoints, "the kernel has a checkpointer");
  const c = await k.checkpoints.sign();
  assert.deepEqual(anchor.held, { seq: c.seq, head: c.hash }, "the checkpoint moved the anchor");
  // a restart over a log that is shorter than the anchor
  await anchor.advance({ seq: 999, head: "h".repeat(64) });
  const again = await createKernel({ space: SPACE, owner: "per_owner", owner_uid: 501, key, log: createEventLog({ space: SPACE, clock }), sealer, checkpoints: true });
  assert.deepEqual([again.boot.ok, again.boot.why, again.boot.anchor.seq], [false, "anchor_rolled_back", 999]);
});
