import "../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKernel } from "../kernel/index.js";
import { canonical, sha256 } from "../kernel/core/canonical.js";
import { createKernelSessions } from "./kernel-session.js";
import { openThreadSocket } from "../core/daemon/threadsock.js";

const KERNEL_SESSION_HEADER = "x-vyre-kernel-session";

let NOW = Date.now();
const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner", BOB = "per_bob", CAROL = "per_carol";
const proof = (action, input, resource) => ({ op: `grant.${action.split(".")[1]}`, fields: { resource, input_hash: sha256(canonical({ action, input })) }, n: Math.random() });
const used = new Set();
const presence = { check: async ({ chain, op, fields, proof: p }) => (chain && p && p.op === op && canonical(p.fields) === canonical(fields) && !used.has(p.n) && (used.add(p.n), true) ? null : "wrong_proof") };
const SCRATCH = process.env.SCRATCH || os.tmpdir();

/** A real in-memory kernel, and a stand-in for vyred that does exactly what core/daemon/index.js does with the header: verify it with the kernel's door, hand it to the call, and answer the room question. */
async function rig(t) {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 9), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  for (const p of [BOB, CAROL]) { const r = { person: p, role: "member" }; await k.gateway.grants.setRole(owner, r, { presence: proof("grants.role", r, `vyre://${SPACE}/member/${p}`) }); }
  for (const a of ["assistant", "kit"]) { const act = { kind: "agent", id: a, space: SPACE }; await k.gateway.grants.addActor(owner, act, { presence: proof("grants.role", { actor: act }, `vyre://${SPACE}/member/${a}`) }); }
  const bob = k.chains.fromFacts({ kind: "device", device_key_id: "d-b", person: BOB, path: "direct" });
  const group = await k.gateway.grants.chats.create(bob, { people: [CAROL] });
  const solo = await k.gateway.grants.chats.create(bob, {});
  const dir = fs.mkdtempSync(path.join(SCRATCH, "ks-"));
  const seen = [];
  const stream = k.kernelFor({ name: "stream", needs: { kernel: { actions: [] } } });
  // vyred's handler for a session socket: what core/daemon/index.js does with the header it finds on the request.
  const handler = async (req, res) => {
    const h = String(req.headers[KERNEL_SESSION_HEADER] || "");
    let token; try { await k.surfaces.verify(h); token = h; } catch { token = undefined; }
    seen.push({ header: h || null, token: token || null });
    k.bindCalls(() => (token ? { token } : null));
    let out;
    try { const room = await stream.audienceFor({}); out = { data: { group: room.group } }; } catch (e) { out = { error: { code: e.code } }; }
    k.bindCalls(() => null);
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(out));
  };
  // The main socket (no session binding, so no stamping) and the sockets of sessions, as vyred opens them.
  const daemon = http.createServer(handler);
  const dsock = path.join(dir, "vyred.sock");
  await new Promise(r => daemon.listen(dsock, r));
  const ks = createKernelSessions({ kernel: k });
  const socks = [];
  const sessionSocket = async (s, thread = "t1") => { const o = await openThreadSocket({ handler: () => handler, thread, pids: async () => ({ pids: [process.pid] }), dir: path.join(dir, "ses"), mode: 0o600, kernelToken: ks.tokenFor(s.id) }); socks.push(o); return o.path; };
  t.after(async () => { await ks.closeAll(); for (const o of socks) await o.close(); daemon.close(); daemon.closeAllConnections?.(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { k, bob, group, solo, ks, seen, dsock, dir, sessionSocket };
}
const get = (socketPath, headers = {}, urlPath = "/call") => new Promise((resolve, reject) => {
  const r = http.request({ socketPath, path: urlPath, method: "POST", headers, agent: false }, res => { let b = ""; res.on("data", c => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({ raw: b, status: res.statusCode }); } }); });
  r.on("error", reject); r.end("{}");
});

test("a session's calls arrive with its own token, and the harness only ever gets a socket path", async t => {
  const { k, bob, group, ks, seen, sessionSocket } = await rig(t);
  const s = await ks.open({ chain: bob, chat: group.id });
  assert.deepEqual(Object.keys(s).sort(), ["expires", "id"], "no token in what opening a session returns");
  const sock = await sessionSocket(s);
  const r = await get(sock);
  assert.deepEqual(r, { data: { group: true } }, "the session's own chat is the room");
  const t1 = await k.surfaces.verify(seen.at(-1).header);
  assert.equal(t1.session, s.id, "the header the daemon saw is this session's token");
  assert.equal(t1.chat, group.id, "with its chat written in by the kernel");
  assert.ok(!JSON.stringify([s, sock]).includes(seen.at(-1).header), "the token is not in anything the harness holds");
  assert.deepEqual(fs.readdirSync(path.dirname(sock)).filter(f => !f.endsWith(".sock")), [], "nothing but sockets in the session folder, no token file");
});

test("a header the client sends is dropped: another session's token through this session's socket still arrives as this session's", async t => {
  const { k, bob, group, solo, ks, seen, sessionSocket } = await rig(t);
  const a = await ks.open({ chain: bob, chat: group.id }), other = await ks.open({ chain: bob, chat: solo.id });
  const sa = await sessionSocket(a, "ta"), so = await sessionSocket(other, "to");
  await get(so);
  const otherToken = seen.at(-1).header;
  assert.deepEqual(await get(sa, { [KERNEL_SESSION_HEADER]: otherToken }), { data: { group: true } });
  assert.equal((await k.surfaces.verify(seen.at(-1).header)).session, a.id);
  assert.notEqual(seen.at(-1).header, otherToken);
});

test("no header, or a session that is not in the group, gets no_audience", async t => {
  const { k, bob, ks, dsock, solo, sessionSocket } = await rig(t);
  assert.deepEqual(await get(dsock), { error: { code: "no_audience" } }, "no header");
  assert.deepEqual(await get(dsock, { [KERNEL_SESSION_HEADER]: "x.y" }), { error: { code: "no_audience" } }, "a malformed header");
  const noChat = await k.surfaces.open(bob);
  assert.deepEqual(await get(dsock, { [KERNEL_SESSION_HEADER]: noChat.token }), { error: { code: "no_audience" } }, "another session, one with no chat, is not a chat session");
  const s = await ks.open({ chain: bob, chat: solo.id });
  assert.deepEqual(await get(await sessionSocket(s)), { data: { group: false } }, "a one-to-one chat is not a group");
});

test("a token cannot be reused after the turn ends", async t => {
  const { bob, group, ks, seen, dsock, sessionSocket } = await rig(t);
  let sock;
  await ks.turn({ chain: bob, chat: group.id }, async s => { sock = await sessionSocket({ id: s.id }); assert.equal((await get(sock)).data.group, true); });
  const token = seen.at(-1).header;
  assert.deepEqual(await get(dsock, { [KERNEL_SESSION_HEADER]: token }), { error: { code: "no_audience" } }, "the token no longer verifies");
  assert.equal((await get(sock)).error.code, "no_session", "the session's socket refuses the call once the token is gone: never unstamped");
  assert.deepEqual(ks.list(), []);
  await assert.rejects(() => ks.turn({ chain: bob, chat: group.id }, async () => { throw new Error("turn failed"); }), /turn failed/);
  assert.deepEqual(ks.list(), [], "a failed turn ends its session too");
});

test("a chat the person is not in, and a chain that is not exactly one person, cannot open a session", async t => {
  const { k, bob, ks } = await rig(t);
  const carol = k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  const mine = await k.gateway.grants.chats.create(bob, {});
  await assert.rejects(() => ks.open({ chain: carol, chat: mine.id }), { code: "not_found" });
  const viewer = k.chains.fromFacts({ kind: "viewer", person: BOB, vouched: true });
  await assert.rejects(() => ks.open({ chain: viewer }), { code: "chain_not_person" });
  assert.deepEqual(ks.list(), []);
});

test("KS-1: no session token yields a one-person chain: an unnamed thread runs as the default assistant, which holds nothing the person holds", async t => {
  const { k, bob, ks } = await rig(t);
  const contact = { name: "contact", label: "Contact", fields: [{ name: "name", kind: "text", label: "Name" }] };
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  await k.gateway.records.define(owner, { add_types: [contact] }, { presence: proof("records.define", { add_types: [contact] }, `vyre://${SPACE}/definition/types`) }).catch(() => {});
  for (const q of [{ chain: bob }, { chain: bob, thread: "t9" }, { chain: bob, agent: "kit" }]) {
    const s = await ks.open(q);
    const tok = await ks.tokenFor(s.id)();
    const chain = await k.surfaces.chainFor(tok);
    assert.ok(chain.hops.length >= 2 && chain.hops.some(h => h.actor.kind === "agent"), `a model hop is always there (${JSON.stringify(chain.hops.map(h => h.actor.kind))})`);
    assert.equal(chain.hops[0].actor.id, BOB);
  }
});

test("KS-3: a thread that outlives its token gets a fresh one before the call goes out, and the old one is revoked", async t => {
  const { k, bob, group, ks: _ks } = await rig(t);
  const ks = createKernelSessions({ kernel: k, ttlMs: 10 * 60_000, renewBeforeMs: 5 * 60_000, clock: () => NOW });
  const s = await ks.open({ chain: bob, chat: group.id });
  const first = await ks.tokenFor(s.id)();
  assert.equal((await k.surfaces.verify(first)).chat, group.id);
  assert.equal(await ks.tokenFor(s.id)(), first, "far from expiry: the same token");
  NOW += 6 * 60_000;
  const second = await ks.tokenFor(s.id)();
  assert.notEqual(second, first);
  assert.equal((await k.surfaces.verify(second)).chat, group.id, "same chat");
  await assert.rejects(() => k.surfaces.verify(first), { code: "not_a_member" }, "the old token is revoked");
  await ks.end(s.id);
  await assert.rejects(() => k.surfaces.verify(second), { code: "not_a_member" });
});

test("KS-1: person-only tools are refused on an unnamed thread's socket, and the handler is never reached", async t => {
  const { bob, ks, seen, sessionSocket } = await rig(t);
  const s = await ks.open({ chain: bob, thread: "t-unnamed" });
  const sock = await sessionSocket(s);
  const before = seen.length;
  for (const tool of ["computers.member.add", "computers.egress.set", "vault.reveal"]) {
    const r = await get(sock, {}, `/v1/tools/${tool}`);
    assert.equal(r.error.code, "denied", tool);
  }
  assert.equal(seen.length, before, "none of them reached vyred's handler");
});

test("KS-4: when renewal fails and the old token has run out, the socket's function answers nothing, so the call is refused", async t => {
  const { k, bob, group } = await rig(t);
  let T = Date.now();
  const failing = { surfaces: { open: (...a) => (T > 0 && failing.down ? Promise.reject(new Error("kernel down")) : k.surfaces.open(...a)), revoke: s => k.surfaces.revoke(s) } };
  const ks = createKernelSessions({ kernel: failing, ttlMs: 10 * 60_000, renewBeforeMs: 5 * 60_000, clock: () => T });
  const s = await ks.open({ chain: bob, chat: group.id });
  const tok = ks.tokenFor(s.id);
  assert.ok(await tok());
  failing.down = true;
  T += 6 * 60_000;
  assert.ok(await tok(), "renewal failed but the old token still has life: it is kept");
  T += 5 * 60_000;
  assert.equal(await tok(), undefined, "past its life with no renewal: nothing");
});

test("a brand-new Space needs no setup: an unnamed thread runs as a plain session (nobody's assistant, the 4 Oct ruling) with no record reach of its own", async () => {
  const k = await createKernel({ space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 4), presence });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const T = { name: "note", label: "Note", fields: [{ name: "title", kind: "text", label: "Title" }] };
  await k.gateway.records.define(owner, { add_types: [T] }, { presence: proof("records.define", { add_types: [T] }, `vyre://${SPACE}/definition/types`) });
  const rec = await k.gateway.records.create(owner, "note", { title: "hello" });
  const ks = createKernelSessions({ kernel: k });
  const s = await ks.open({ chain: owner, thread: "t-new" });
  const chain = await k.surfaces.chainFor(await ks.tokenFor(s.id)());
  assert.deepEqual(chain.hops.map(h => `${h.actor.kind}:${h.actor.id}`), [`person:${OWNER}`, "agent:session"], "a thread no agent was named for is a plain session, never the assistant");
  // a plain session is nobody's assistant: it holds none of the assistant's grants, so the person's record is not read through it until the person gives that session an agent's grant
  assert.equal(await k.gateway.records.get(chain, "note", rec.id), null, "a plain session reads nothing of its person's records by default");
  await ks.end(s.id);
});

test("forThread: a thread's current turn is used as calls, the token is never returned, and a thread with no session is no_session", async t => {
  const { k, bob, group } = await rig(t);
  const got = [];
  const chats = { appendOpen: async (token, m) => { got.push(["open", token, m]); return { id: "m1", chat: (await k.surfaces.verify(token)).chat }; }, append: async (token, m) => { got.push(["append", token, m]); return { id: "m2" }; } };
  const ks = createKernelSessions({ kernel: k, chats });
  const s = await ks.open({ chain: bob, chat: group.id, thread: "th-1", agent: "kit" });
  const turn = ks.forThread("th-1");
  assert.deepEqual(Object.keys(turn).sort(), ["append", "appendOpen", "beginTurn", "roomFor"], "calls only");
  const r = await turn.appendOpen({ kind: "text" });
  assert.equal(r.chat, group.id, "the kernel's own token for this thread's chat");
  assert.equal((await k.surfaces.verify(got[0][1])).session, s.id);
  assert.ok(!JSON.stringify([s, r, Object.keys(turn)]).includes(got[0][1]), "the token is in nothing the caller holds");
  await assert.rejects(() => turn.roomFor(), { code: "unsupported" });
  await assert.rejects(() => ks.forThread("th-none").append({ body: "x" }), { code: "no_session" });
  await ks.end(s.id);
  await assert.rejects(() => turn.append({ body: "x" }), { code: "no_session" }, "after the turn there is nothing to use");
});

test("a replaced chat-turn session is released when its reply closes, never cut while it streams: not by the next asker opening, not by minutes passing; with no reply open it goes at once", async t => {
  const { k, bob, group } = await rig(t);
  const carol = k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  const bound = [];
  const chats = { appendOpen: async (token, m) => { bound.push(token); return { id: "m1", write: async () => { await k.surfaces.verify(token); }, close: async () => { await k.surfaces.verify(token); } }; }, append: async () => ({ id: "m2" }) };
  const ks = createKernelSessions({ kernel: k, chats });
  const first = await ks.open({ chain: bob, chat: group.id, thread: "th-r", agent: "kit" });
  const reply = await ks.forThread("th-r").appendOpen({ kind: "text" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // the next asker's turn opens while the first reply is still streaming
  const second = await ks.open({ chain: carol, chat: group.id, thread: "th-r", agent: "kit" });
  assert.notEqual(second.id, first.id);
  assert.deepEqual(ks.list(), [second.id], "the released one is not counted as open");
  t.mock.timers.tick(10 * 60_000);
  await reply.write("still streaming ten minutes later");
  await reply.close();
  await assert.rejects(() => k.surfaces.verify(bound[0]), "the first session is revoked the moment its reply closed");
  assert.ok(await k.surfaces.verify(await ks.tokenFor(second.id)()), "the current session is untouched");
  // a replaced session whose reply the stream has not asked for yet is held for it (idle limit), then goes
  const third = await ks.open({ chain: bob, chat: group.id, thread: "th-r", agent: "kit" });
  assert.ok(await k.surfaces.verify(await ks.tokenFor(second.id)()), "carol's session is held for her reply");
  assert.deepEqual(ks.list(), [third.id]);
  t.mock.timers.tick(3 * 60_000);
  await assert.rejects(() => k.surfaces.verify(bound[0]));
  assert.equal(await ks.tokenFor(second.id)(), undefined, "and goes when it has waited too long for one");
  t.mock.timers.reset();
});

test("a reply is written under the session of the person whose turn it is, even when the next asker's turn has opened first; a person with no session on the thread gets none", async t => {
  const { k, bob, group } = await rig(t);
  const carol = k.chains.fromFacts({ kind: "device", device_key_id: "d-c", person: CAROL, path: "direct" });
  const who = [];
  const chats = { appendOpen: async (token, m) => { who.push([(await k.surfaces.verify(token)).person, m]); return { id: "m1", write: async () => {}, close: async () => {} }; }, append: async () => ({ id: "m2" }) };
  const ks = createKernelSessions({ kernel: k, chats });
  await ks.open({ chain: bob, chat: group.id, thread: "th-x", agent: "kit" });
  await ks.open({ chain: carol, chat: group.id, thread: "th-x", agent: "kit" }); // turn N+1 is open before turn N's reply was asked for
  const turn = ks.forThread("th-x");
  const r1 = await turn.appendOpen({ kind: "text", asker: BOB });
  assert.equal(who[0][0], BOB, "the reply of bob's turn runs as bob, not as the newest asker");
  assert.equal("asker" in who[0][1], false, "the stream's word for whose turn it is does not reach the kernel");
  await r1.close();
  await turn.appendOpen({ kind: "text", asker: CAROL });
  assert.equal(who[1][0], CAROL);
  await assert.rejects(() => turn.appendOpen({ kind: "text", asker: "per_nobody" }), { code: "no_session" });
  assert.equal(who.length, 2, "and nothing was written for them");
});

test("restart: an open turn is reopened from the stored turn with no new call from the asker; one that cannot be reopened in time is given up and forgotten", async t => {
  const { k, bob, group } = await rig(t);
  const store = new Map();
  const turns = { get: x => store.get(x), set: (x, r) => store.set(x, r), delete: x => store.delete(x), all: () => [...store] };
  const before = createKernelSessions({ kernel: k, turns });
  await before.open({ chain: bob, chat: group.id, thread: "th-a" });
  await before.open({ chain: bob, chat: group.id, thread: "th-b" });
  assert.deepEqual([...store.keys()].sort(), ["th-a", "th-b"]);
  assert.ok(!JSON.stringify([...store]).includes("."), "no token is stored, only who, which chat, which assistant");
  // a restart: a new process, the same store, nothing in memory
  const chats = { append: async (token, m) => ({ chat: (await k.surfaces.verify(token)).chat }) };
  const after = createKernelSessions({ kernel: k, turns, chats });
  const gave = [];
  const out = await after.reopenPending({ personChainFor: async p => (p === BOB ? bob : new Promise(() => {})), timeoutMs: 50, onGiveUp: (th, why) => gave.push([th, why]) });
  assert.deepEqual(out, { resumed: ["th-a", "th-b"], gaveUp: [] });
  assert.equal((await after.forThread("th-a").append({ body: "continuing" })).chat, group.id, "the reply resumes in its own chat");
  store.set("th-c", { person: "per_ghost", chat: group.id, agent: null, at: 1 });
  const out2 = await after.reopenPending({ personChainFor: async p => (p === BOB ? bob : new Promise(() => {})), timeoutMs: 50, onGiveUp: (th, why) => gave.push([th, why]) });
  assert.deepEqual(out2, { resumed: [], gaveUp: ["th-c"] });
  assert.deepEqual(gave, [["th-c", "timeout"]]);
  assert.equal(store.has("th-c"), false, "forgotten once given up");
  await after.closeAll();
});

test("a chat turn begins at the kernel the moment its session opens, before anything else; a session with no chat does not", async t => {
  const { k, bob, group, solo } = await rig(t);
  const began = [];
  const chats = { beginTurn: async token => { began.push((await k.surfaces.verify(token)).chat); return { chat: began.at(-1), ver: 1 }; } };
  const ks = createKernelSessions({ kernel: k, chats });
  await ks.open({ chain: bob, chat: group.id, thread: "t-a" });
  await ks.open({ chain: bob, thread: "t-b" });
  assert.deepEqual(began, [group.id], "only the chat session began a turn, and it did so at open");
  const failing = createKernelSessions({ kernel: k, chats: { beginTurn: async () => { throw Object.assign(new Error("no"), { code: "no_audience" }); } } });
  await assert.rejects(() => failing.open({ chain: bob, chat: solo.id, thread: "t-c" }), { code: "no_audience" });
  assert.deepEqual(failing.list(), [], "a turn that cannot begin leaves no session open");
});

test("a graceful stop keeps the open turns: closeAll revokes the tokens, and the next start reopens the turn for its person; end forgets one", async t => {
  const { k, bob, group } = await rig(t);
  const store = new Map();
  const turns = { get: x => store.get(x), set: (x, r) => store.set(x, r), delete: x => store.delete(x), all: () => [...store] };
  const before = createKernelSessions({ kernel: k, turns });
  const a = await before.open({ chain: bob, chat: group.id, thread: "th-a" });
  const b = await before.open({ chain: bob, chat: group.id, thread: "th-b" });
  const tokenA = await before.tokenFor(a.id)();
  await before.end(b.id);
  assert.deepEqual([...store.keys()], ["th-a"], "end: the turn is over, forgotten");
  await before.closeAll(); // the daemon is stopping
  await assert.rejects(() => k.surfaces.verify(tokenA), { code: "not_a_member" }, "the token no longer works");
  assert.deepEqual([...store.keys()], ["th-a"], "the open turn survived the stop");
  const after = createKernelSessions({ kernel: k, turns });
  const out = await after.reopenPending({ personChainFor: async () => bob, timeoutMs: 100 });
  assert.deepEqual(out, { resumed: ["th-a"], gaveUp: [] }, "the next start resumes it");
  await after.closeAll();
});
