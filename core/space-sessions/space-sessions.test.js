import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createPlacement, offerGrant, acceptGrant, createSpaceStore, openWorkcopy, createRunner, createContinue, createSpaceSessions } from "./index.js";

const SPACE = "spc_harlow000001", OTHER = "spc_northwind0001";
const person = id => ({ kind: "person", id, space: SPACE });
const ALEX = person("per_alex"), BOB = person("per_bob"), ADMIN = person("per_admin");
let n = 0;
const mk = (g, over = {}) => ({ id: `gr_${++n}`, space: SPACE, status: "active", action_set_version: 9, created_at: 0, ...g, ...over });
const chain = (space = SPACE, who = ALEX) => ({ space, hops: [{ actor: who }], labels: { trust: "member" } });
const SCRATCH = process.env.SCRATCH || os.tmpdir();
const tmp = () => fsp.mkdtemp(path.join(SCRATCH, "spsess-"));

// ---- placement ----
function placement(grants, over = {}) {
  return createPlacement({ grants: { list: () => grants }, isAdmin: (s, a) => a.id === "per_admin", deviceOwner: d => (d === "dev_alex" ? ALEX : d === "dev_bob" ? BOB : null), clock: () => 1000, ...over });
}
const offer = () => mk(offerGrant({ space: SPACE, admin: ADMIN, person: ALEX, device: "dev_alex", expires: 9999 }));
const accept = (p = ALEX, d = "dev_alex") => mk(acceptGrant({ space: SPACE, admin: ADMIN, person: p, device: d, expires: 9999 }));

test("placement: no device means the server", async () => {
  assert.equal((await placement([]).placeSession({ space: SPACE, person: ALEX })).where, "server");
});
test("placement: both grants are needed for the member's own computer", async () => {
  const q = { space: SPACE, person: ALEX, device: "dev_alex" };
  assert.equal((await placement([offer(), accept()]).placeSession(q)).where, "device");
  const onlyOffer = await placement([offer()]).placeSession(q);
  assert.equal(onlyOffer.where, "server"); assert.match(onlyOffer.reason, /not accepted/);
  const onlyAccept = await placement([accept()]).placeSession(q);
  assert.equal(onlyAccept.where, "server"); assert.match(onlyAccept.reason, /not offered/);
});
test("placement: an offer from a non-admin does not count; expired or revoked grants do not count", async () => {
  const q = { space: SPACE, person: ALEX, device: "dev_alex" };
  const fake = mk(offerGrant({ space: SPACE, admin: BOB, person: ALEX, device: "dev_alex", expires: 9999 }));
  assert.equal((await placement([fake, accept()]).placeSession(q)).where, "server");
  const old = mk(offerGrant({ space: SPACE, admin: ADMIN, person: ALEX, device: "dev_alex", expires: 500 }));
  assert.equal((await placement([old, accept()]).placeSession(q)).where, "server");
  assert.equal((await placement([{ ...offer(), status: "revoked" }, accept()]).placeSession(q)).where, "server");
});
test("placement: the accept covers one person's own device only; the admin cannot accept for a member; another space's grants are ignored", async () => {
  const q = { space: SPACE, person: ALEX, device: "dev_alex" };
  assert.equal((await placement([offer(), accept(ADMIN)]).placeSession(q)).where, "server", "accept issued by the admin is not the member's");
  assert.equal((await placement([offer(), accept(ALEX, "dev_other")]).placeSession(q)).where, "server", "accept for a different device");
  assert.equal((await placement([offer(), accept(BOB, "dev_bob")]).placeSession({ space: SPACE, person: ALEX, device: "dev_bob" })).where, "server", "Bob's device is not Alex's");
  assert.equal((await placement([offer(), accept()]).placeSession({ ...q, session_owner: BOB })).where, "server", "Alex's computer never runs Bob's session");
  assert.equal((await placement([{ ...offer(), space: OTHER }, { ...accept(), space: OTHER }]).placeSession(q)).where, "server");
});

// ---- the sessions registry: one Space, no cross-space reads ----
test("sessions belong to one space; another space's chain sees nothing", async () => {
  const sessions = createSpaceSessions({ space: SPACE, placement: placement([offer(), accept()]), authorize: async () => ({ effect: "allow" }) });
  const s = await sessions.create({ chain: chain(), person: ALEX, device: "dev_alex" });
  assert.equal(s.space, SPACE); assert.equal(s.where, "device");
  assert.equal((await sessions.get(chain(), s.id)).id, s.id);
  assert.equal(await sessions.get(chain(OTHER), s.id), null);
  assert.deepEqual(await sessions.list(chain(OTHER)), []);
  await assert.rejects(() => sessions.create({ chain: chain(OTHER), person: ALEX }), { code: "not_found" });
  const deny = createSpaceSessions({ space: SPACE, placement: placement([]), authorize: async () => ({ effect: "deny" }) });
  await assert.rejects(() => deny.create({ chain: chain(), person: ALEX }), { code: "not_found" });
});

// ---- the working copy ----
const manual = () => { const q = []; return { q, set: f => { q.push(f); return f; }, clear: f => { const i = q.indexOf(f); if (i >= 0) q.splice(i, 1); }, fire: async () => { const f = q.shift(); if (f) f(); await new Promise(r => setImmediate(r)); } }; };
const vault = (calls = []) => ({ release: async q => { calls.push(q); return crypto.createHash("sha256").update("space-key").digest(); }, credential: async q => "sk-live-" + q.name });
async function wc(store, o = {}) {
  const dir = o.dir || (await tmp());
  const timers = o.timers || manual();
  const lease = o.lease || (await store.acquire({ space: SPACE, session: "s1", device: o.device || "dev_alex", ttl_ms: 60_000 }));
  const w = await openWorkcopy({ dir, space: SPACE, session: "s1", device: o.device || "dev_alex", token: () => lease.token, fs: fsp, vault: o.vault || vault(), transport: store, timers });
  return { w, dir, timers, lease };
}

test("workcopy: files are encrypted on disk, names hidden, and the key comes from the vault, not from disk", async () => {
  const store = createSpaceStore(); const calls = [];
  const { w, dir } = await wc(store, { vault: vault(calls) });
  await w.write("notes/plan.md", "the client is Jane Doe");
  const names = await fsp.readdir(dir);
  assert.equal(names.length, 1); assert.ok(!names[0].includes("plan"));
  const raw = await fsp.readFile(path.join(dir, names[0]));
  assert.ok(!raw.includes("Jane") && !raw.toString("latin1").includes("plan.md"));
  assert.equal((await w.read("notes/plan.md")).toString(), "the client is Jane Doe");
  assert.deepEqual(calls.map(c => c.purpose), ["workcopy"]);
  // tampering is noticed
  raw[raw.length - 1] ^= 1; await fsp.writeFile(path.join(dir, names[0]), raw);
  await assert.rejects(() => w.read("notes/plan.md"));
  raw[raw.length - 1] ^= 1; await fsp.writeFile(path.join(dir, names[0]), raw);
  await w.close({ wipe: true });
  await assert.rejects(() => fsp.readdir(dir));
});
test("workcopy: paths are confined", async () => {
  const { w } = await wc(createSpaceStore());
  for (const p of ["../x", "/etc/passwd", "a/../../b", ""]) await assert.rejects(() => w.write(p, "x"), { code: "bad_input" });
});
test("workcopy: changes sync back after a debounce, one push per path however many writes", async () => {
  const real = createSpaceStore(); let pushes = 0; const store = { ...real, push: async r => { pushes++; return real.push(r); } };
  const { w, timers } = await wc(store);
  await w.write("a.txt", "1"); await w.write("a.txt", "2"); await w.write("b.txt", "x");
  assert.equal(pushes, 0); assert.equal(timers.q.length, 1, "one timer, restarted");
  await timers.fire(); await w.flush();
  assert.equal(pushes, 2);
  assert.equal((await store.pull({ space: SPACE, session: "s1", path: "a.txt" })).bytes.toString(), "2");
  await w.write("a.txt", "3"); await w.flush();
  const got = await store.pull({ space: SPACE, session: "s1", path: "a.txt" });
  assert.equal(got.version, 2); assert.equal(got.bytes.toString(), "3");
  await w.remove("b.txt"); await w.flush();
  assert.equal(await store.pull({ space: SPACE, session: "s1", path: "b.txt" }), null);
  assert.deepEqual(w.list(), ["a.txt"]);
});
test("workcopy: a clash keeps the Space's version at the path and our file as a sibling, never merged", async () => {
  const store = createSpaceStore(); const events = [];
  const a = await wc(store, { device: "dev_alex" });
  await a.w.write("a.txt", "from alex"); await a.w.flush();
  // another writer moves the Space's version on
  await store.push({ space: SPACE, session: "s1", path: "a.txt", base_version: 1, bytes: Buffer.from("from space"), device: "dev_x" });
  await a.w.write("a.txt", "alex edit"); await a.w.flush();
  assert.equal((await a.w.read("a.txt")).toString(), "from space", "the Space's version stands at the path");
  const man = await store.manifest({ space: SPACE, session: "s1" });
  const sib = man.find(f => f.path.startsWith("a.txt (conflict"));
  assert.ok(sib, "ours is kept as a sibling");
  assert.equal((await store.pull({ space: SPACE, session: "s1", path: sib.path })).bytes.toString(), "alex edit");
  assert.equal(man.find(f => f.path === "a.txt").version, 2);
});
test("workcopy: a machine that lost the lease cannot write", async () => {
  const store = createSpaceStore();
  const a = await wc(store, { device: "dev_alex" });
  await a.w.write("a.txt", "1"); await a.w.flush();
  await store.release({ space: SPACE, session: "s1", device: "dev_alex", token: a.lease.token });
  await store.acquire({ space: SPACE, session: "s1", device: "dev_bob", ttl_ms: 60_000 });
  await a.w.write("a.txt", "2");
  await assert.rejects(() => a.w.flush(), { code: "stale_lease" });
  assert.equal((await store.pull({ space: SPACE, session: "s1", path: "a.txt" })).bytes.toString(), "1");
});
test("workcopy: credentials come from the vault at use and are never written to the copy", async () => {
  const { w, dir } = await wc(createSpaceStore());
  const key = await w.credential("court-portal");
  assert.equal(key, "sk-live-court-portal");
  await assert.rejects(() => w.write(".env", `KEY=${key}`), { code: "credential_in_file" });
  await w.write("ok.txt", "no secrets");
  for (const f of await fsp.readdir(dir)) assert.ok(!(await fsp.readFile(path.join(dir, f))).includes(key));
});

// ---- checkpoints, lease and resume ----
test("checkpoint at every turn, resume on another machine, two machines never both active", async () => {
  const store = createSpaceStore(); const run = createRunner({ space: SPACE, store });
  const lease = await run.activate({ session: "s1", device: "dev_alex" });
  const { w } = await wc(store, { lease });
  await w.write("draft.md", "v1");
  const c1 = await run.turnDone({ session: "s1", token: lease.token, workcopy: w, transcript_delta: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], tasks: [{ id: "t1", state: "working" }], meta: { model: "sonnet" } });
  await w.write("draft.md", "v2");
  const c2 = await run.turnDone({ session: "s1", token: lease.token, workcopy: w, transcript_delta: [{ role: "user", content: "more" }] });
  assert.deepEqual([c1.seq, c2.seq], [1, 2]);
  assert.notEqual(c1.manifest_hash, c2.manifest_hash);

  // a second machine cannot take it while the first holds it
  const other = await wc(store, { device: "dev_bob", lease: { token: 0 }, dir: await tmp() });
  await assert.rejects(() => run.resume({ session: "s1", device: "dev_bob", workcopy: other.w }), { code: "lease_held" });

  // the first lets go; the second resumes with everything
  await lease.release();
  const r = await run.resume({ session: "s1", device: "dev_bob", workcopy: other.w });
  assert.equal(r.turn, 2); assert.equal(r.transcript.length, 3);
  assert.equal((await other.w.read("draft.md")).toString(), "v2");
  assert.ok(r.lease.token > lease.token, "a higher fencing token");
  // the old machine, if it wakes up, cannot checkpoint
  await assert.rejects(() => run.turnDone({ session: "s1", token: lease.token, workcopy: w, transcript_delta: [] }), { code: "stale_lease" });
});
test("resume refuses a tampered checkpoint or a copy that does not match, and gives the lease back", async () => {
  const store = createSpaceStore(); const run = createRunner({ space: SPACE, store });
  const lease = await run.activate({ session: "s1", device: "dev_alex" });
  const { w } = await wc(store, { lease });
  await w.write("a", "1");
  await run.turnDone({ session: "s1", token: lease.token, workcopy: w, transcript_delta: [{ role: "user", content: "x" }] });
  await lease.release();
  const bad = createRunner({ space: SPACE, store: { ...store, checkpoints: async q => (await store.checkpoints(q)).map(c => ({ ...c, transcript_delta: [{ role: "user", content: "evil" }] })) } });
  const o = await wc(store, { device: "dev_bob", lease: { token: 0 }, dir: await tmp() });
  await assert.rejects(() => bad.resume({ session: "s1", device: "dev_bob", workcopy: o.w }), { code: "integrity" });
  // lease was returned, so a clean resume works
  assert.equal((await run.resume({ session: "s1", device: "dev_bob", workcopy: o.w })).turn, 1);
  await assert.rejects(() => run.resume({ session: "nope", device: "dev_bob", workcopy: o.w }), { code: "not_found" });
});
test("lease expires so a dead machine does not hold a session forever", async () => {
  let t = 0; const store = createSpaceStore({ clock: () => t });
  assert.equal((await store.acquire({ space: SPACE, session: "s", device: "a", ttl_ms: 100 })).token, 1);
  assert.equal((await store.acquire({ space: SPACE, session: "s", device: "b", ttl_ms: 100 })).ok, false);
  t = 200;
  assert.equal((await store.acquire({ space: SPACE, session: "s", device: "b", ttl_ms: 100 })).token, 2);
  assert.equal((await store.renew({ space: SPACE, session: "s", device: "a", token: 1, ttl_ms: 100 })).ok, false);
});

// ---- continue in another space ----
function cont(over = {}) {
  const tasks = new Map(); let id = 0; const started = [];
  const session = { id: "ses1", space: SPACE, title: "Estate matter" };
  const ask = {
    request: async (c, spec) => { const t = { id: `task${++id}`, state: "ready", ...spec }; tasks.set(t.id, t); return t; },
    get: async (c, i) => tasks.get(i) || null,
    approved: (i, h) => tasks.get(i).approvedHash === h,
  };
  const c = createContinue({
    summarize: async () => "Client Jane Doe wants a trust. SSN 123-45-6789. Harlow fee schedule is 400 per hour. Next step: draft the trust.",
    sanitize: async q => q.text.replace(/\d{3}-\d{2}-\d{4}/g, "[ssn:ref]"),
    sourceOnly: async () => ["Harlow fee schedule is 400 per hour"],
    ask, readSession: async (ch, i) => (i === "ses1" ? session : null), readTranscript: async () => "...",
    startSession: async (ch, space, first) => { started.push({ space, first }); return { id: "new1", space }; },
    authorize: async () => ({ effect: "allow" }), ...over,
  });
  return { c, tasks, started, session };
}
test("continue: the summary is stripped, raised as a task, and only an approved one starts the new session", async () => {
  const { c, tasks, started, session } = cont(); const before = JSON.stringify(session);
  const p = await c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX });
  assert.ok(!p.summary.includes("123-45-6789") && !p.summary.includes("400 per hour"));
  assert.match(p.summary, /ssn:ref/); assert.match(p.summary, /left out/);
  const t = tasks.get(p.task);
  assert.equal(t.source, "continue_in_space"); assert.equal(t.output.kind, "decision");
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_approved" });
  t.state = "done"; t.outcome = "approved"; t.approvedHash = "something else";
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_approved" }, "approval bound to another payload");
  t.approvedHash = p.hash;
  const s = await c.deliver({ chain: chain(), task: p.task });
  assert.equal(s.space, OTHER); assert.equal(started[0].first.context, p.summary); assert.deepEqual(started[0].first.from, { space: SPACE, session: "ses1" });
  assert.equal(JSON.stringify(session), before, "the old session is untouched");
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_found" }, "delivered once");
});
test("continue: an edit changes the hash so an earlier approval does not carry over; rejected means nothing starts", async () => {
  const { c, tasks, started } = cont();
  const p = await c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX });
  const t = tasks.get(p.task); t.state = "done"; t.outcome = "approved"; t.approvedHash = p.hash;
  const e = await c.edit({ task: p.task, summary: "Short version. SSN 111-22-3333." });
  assert.notEqual(e.hash, p.hash);
  await assert.rejects(() => c.deliver({ chain: chain(), task: p.task }), { code: "not_approved" });
  const q = await c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX });
  const t2 = tasks.get(q.task); t2.state = "done"; t2.outcome = "rejected";
  await assert.rejects(() => c.deliver({ chain: chain(), task: q.task }), { code: "not_approved" });
  assert.equal(started.length, 0);
});
test("continue: another space's chain, the same space and a denied chain are refused", async () => {
  const { c } = cont();
  await assert.rejects(() => c.propose({ chain: chain(OTHER), session: "ses1", target_space: SPACE, person: ALEX }), { code: "not_found" });
  await assert.rejects(() => c.propose({ chain: chain(), session: "ses1", target_space: SPACE, person: ALEX }), { code: "bad_input" });
  await assert.rejects(() => c.propose({ chain: chain(), session: "nope", target_space: OTHER, person: ALEX }), { code: "not_found" });
  const d = cont({ authorize: async () => ({ effect: "deny" }) });
  await assert.rejects(() => d.c.propose({ chain: chain(), session: "ses1", target_space: OTHER, person: ALEX }), { code: "not_found" });
});
