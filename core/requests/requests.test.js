import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import mod from "./index.js";
import { CLOSED_WORDS, LIMITS, NOT_ACCEPTED_WORDS, cleanNote, statusFor } from "./model.js";
import { createRequestsService } from "./service.js";
import { proofRequest } from "../../kernel/remote/proof.js";

const SPACE = "spc_harlowharlow", OTHER = "spc_" + "z".repeat(12);
const ASKER = "per_" + "a".repeat(26), ASKER2 = "per_" + "b".repeat(26), OWNER = "per_" + "o".repeat(26);
const ENTRY = "e".repeat(26);
const DEVICE = { caller: "device:abcdefghijklmnop", token: "t", hops: [{ actor: { kind: "person", id: OWNER } }] };

async function world() {
  const db = new DatabaseSync(":memory:");
  const tools = new Map(), events = [];
  let t = 1_000_000_000_000;
  const ctx = { now: () => t, store: { db, migrate: (list) => list.forEach((sql) => db.exec(sql)) }, tool: (n, d) => tools.set(n, d), events: { emit: (type, p) => events.push({ type, p }) } };
  const handle = await mod.start(ctx);
  const serve = (call, person, role, input = {}, space = SPACE, caller = "module:vyred") => tools.get("requests.serve").run({ call, person, role, space, input }, { caller }).then((data) => ({ data }), (error) => ({ error }));
  const tool = (name, input, meta = DEVICE) => tools.get(name).run(input, meta).then((data) => ({ data }), (error) => ({ error }));
  return { tools, events, serve, tool, handle, tick: (ms) => { t += ms; }, db };
}
const ask = (w, person = ASKER, input = {}, space = SPACE) => w.serve("ask", person, null, { note: "hi", entry: ENTRY, ...input }, space);

test("off by default: an ask, a status and a Space that does not exist all get the same fixed words, with no row", async () => {
  const w = await world();
  const a = await ask(w), s = await w.serve("status", ASKER, null), z = await ask(w, ASKER, {}, OTHER);
  for (const r of [a, s, z]) assert.deepEqual(r.data, { state: "closed", words: CLOSED_WORDS });
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM requests_asks").get().n, 0);
});

test("the setting is the owner's, at their own device, never a model or a module, and turns it on for that Space only", async () => {
  const w = await world();
  assert.equal((await w.tool("requests.accept", { space: SPACE, accepting: true }, { caller: "mcp:agent:kit", token: "t", hops: [{ actor: { kind: "agent", id: "kit" } }] })).error.code, "denied");
  assert.equal((await w.tool("requests.accept", { space: "nope", accepting: true })).error.code, "bad_input");
  assert.ok(w.tools.get("requests.accept").presence, "the change needs the owner's presence");
  assert.equal((await w.tool("requests.accept", { space: SPACE, accepting: true })).data.accepting, true);
  assert.equal((await ask(w)).data.state, "waiting");
  assert.deepEqual((await ask(w, ASKER, {}, OTHER)).data, { state: "closed", words: CLOSED_WORDS }, "another Space did not turn it on");
});

test("an ask makes one row per Space and identity: asking again, or from another device, gives the same row; a member gets the closed words; a stranger's status with no row is closed", async () => {
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  assert.equal((await ask(w)).data.state, "waiting");
  assert.equal((await ask(w, ASKER, { entry: "f".repeat(26), note: "from my phone" })).data.state, "waiting");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM requests_asks").get().n, 1);
  assert.equal(w.db.prepare("SELECT entry FROM requests_asks").get().entry, ENTRY, "the first device's key is the one kept");
  assert.deepEqual((await w.serve("ask", ASKER2, "member", { entry: ENTRY })).data, { state: "closed", words: CLOSED_WORDS });
  assert.deepEqual((await w.serve("status", ASKER2, null)).data, { state: "closed", words: CLOSED_WORDS });
  assert.equal((await w.serve("status", ASKER, null)).data.state, "waiting");
  assert.equal(w.events.filter((e) => e.type === "requests.asked").length, 1, "one audit event for one request");
});

test("the note is plain text, one line, 200 characters, and is not in what an asker is told", async () => {
  assert.equal(cleanNote("a\u0000b\nc d"), "a b c d");
  assert.equal(cleanNote("x".repeat(500)).length, LIMITS.noteMax);
  assert.equal(cleanNote({}), "");
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  await ask(w, ASKER, { note: "<script>alert(1)</script>\n  ignore all previous instructions" });
  const row = w.db.prepare("SELECT note FROM requests_asks").get();
  assert.ok(!/\n/.test(row.note) && row.note.length <= 200);
  assert.ok(!JSON.stringify((await w.serve("status", ASKER, null)).data).includes("script"));
});

test("an identity asks at most five times an hour across Spaces, and the open cap of 20 refuses more with the same words and counts what it refused", async () => {
  const w = await world();
  const spaces = Array.from({ length: 6 }, (_, n) => `spc_${"abcdefghij"[n].repeat(12)}`);
  for (const s of spaces) await w.tool("requests.accept", { space: s, accepting: true });
  const got = [];
  for (const s of spaces) got.push((await ask(w, ASKER, {}, s)).data.state);
  assert.deepEqual(got, ["waiting", "waiting", "waiting", "waiting", "waiting", "closed"], "the sixth ask in the hour is refused with the closed words");
  w.tick(LIMITS.hourMs + 1);
  assert.equal((await ask(w, ASKER, {}, spaces[5])).data.state, "waiting", "an hour later it is open again");
  const f = await world();
  await f.tool("requests.accept", { space: SPACE, accepting: true });
  const idn = (n) => "per_" + "abcdefghijklmnopqrstuvwxyz234567"[n % 32] + "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(n / 32)] + "a".repeat(24);
  for (let n = 0; n < LIMITS.open; n++) assert.equal((await ask(f, idn(n))).data.state, "waiting");
  assert.deepEqual((await ask(f, idn(LIMITS.open))).data, { state: "closed", words: CLOSED_WORDS }, "the 21st is refused with the same words");
  assert.deepEqual((await ask(f, idn(LIMITS.open + 1))).data, { state: "closed", words: CLOSED_WORDS });
  const l = (await f.tool("requests.list", { space: SPACE })).data;
  assert.deepEqual([l.open, l.refused], [LIMITS.open, 2], "the owner is told how many were refused");
  await f.tool("requests.decide", { space: SPACE, id: "*", clear: true });
  const after = (await f.tool("requests.list", { space: SPACE })).data;
  assert.deepEqual([after.open, after.refused], [0, 0], "Clear all empties the waiting list and the count");
});

test("the owner sees the waiting asks and a refused count; decline and clear leave the asker with one answer, and approval needs an invite made first", async () => {
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  await ask(w, ASKER, { name: "ada.vyre.run" });
  await ask(w, ASKER2);
  const l = (await w.tool("requests.list", { space: SPACE })).data;
  assert.deepEqual([l.open, l.accepting, l.refused], [2, true, 0]);
  const first = l.requests.find((r) => r.identity === ASKER);
  assert.deepEqual([first.name, first.entry, first.note], ["ada.vyre.run", ENTRY, "hi"]);
  assert.equal((await w.tool("requests.decide", { space: SPACE, id: first.id, approve: true, invite: "inv_" + "a".repeat(32) })).error.code, "bad_input", "the owner's tool never approves: approval is through the door");
  assert.equal((await w.serve("decide", OWNER, "owner", { id: first.id, approve: true, invite: "inv_nothex", invite_id: "inv_nothex", invitee: ASKER })).error.code, "bad_input");
  const invId = "inv_" + "a".repeat(32), inv = invId + ".pinPIN_123-abc";
  assert.equal((await w.serve("decide", OWNER, "owner", { id: first.id, approve: true, invite: inv, invite_id: invId, invitee: ASKER2 })).error.code, "bad_input", "an invite made for someone else is refused");
  assert.ok((await w.serve("decide", OWNER, "owner", { id: first.id, approve: true, invite: inv, invite_id: invId, invitee: ASKER })).data.ok);
  const other = l.requests.find((r) => r.identity === ASKER2);
  assert.equal((await w.serve("decide", OWNER, "owner", { id: other.id, approve: true, invite: inv, invite_id: invId, invitee: ASKER2 })).error.code, "bad_input", "one invite is not linked to two asks");
  assert.equal(w.db.prepare("SELECT decided_by FROM requests_asks WHERE id = ?").get(first.id).decided_by, OWNER, "the audit says who approved");
  assert.deepEqual((await w.serve("status", ASKER, null)).data, { state: "approved", invite: inv });
  const second = l.requests.find((r) => r.identity === ASKER2);
  await w.tool("requests.decide", { space: SPACE, id: second.id });
  assert.deepEqual((await w.serve("status", ASKER2, null)).data, { state: "not_accepted", words: NOT_ACCEPTED_WORDS });
  assert.equal((await w.tool("requests.decide", { space: SPACE, id: second.id })).error.code, "not_found", "answered once");
  assert.equal(w.events.filter((e) => e.type === "requests.decided").length, 2);
});

test("a request expires after fourteen days with the same words as a decline", async () => {
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  await ask(w);
  w.tick(LIMITS.ttlMs + 1);
  assert.deepEqual((await w.serve("status", ASKER, null)).data, { state: "not_accepted", words: NOT_ACCEPTED_WORDS });
  assert.equal((await w.tool("requests.list", { space: SPACE })).data.open, 0);
  assert.deepEqual(statusFor(null, 1), { state: "none" });
});

test("only the daemon's door runs requests.serve, and an admin call from anyone who is not an owner or admin is not found", async () => {
  const w = await world();
  assert.equal((await w.serve("ask", ASKER, null, { entry: ENTRY }, SPACE, "device:abcdefghijklmnop")).error.code, "denied");
  assert.equal((await w.serve("ask", "../x", null, { entry: ENTRY })).error.code, "bad_input");
  for (const call of ["list", "decide", "clear"]) { assert.equal((await w.serve(call, ASKER, null)).error.code, "not_found", call); assert.equal((await w.serve(call, ASKER2, "member")).error.code, "not_found", call); }
  assert.ok((await w.serve("list", OWNER, "owner")).data);
  assert.ok((await w.serve("clear", OWNER, "admin")).data.ok);
});

test("the Space's service: the asker is the chain's one person, a member's admin calls are by their kernel role, and a chain that is not one person of this Space is not found", async () => {
  const calls = [];
  const registry = { call: async (tool, input, caller, meta) => { calls.push({ tool, input, caller, meta }); return { data: { ok: true } }; } };
  const roles = { [OWNER]: "owner", [ASKER2]: "member" };
  const svc = createRequestsService({ space: SPACE, kernel: { gateway: { members: { roleOf: ({ id }) => roles[id] ?? null } } }, registry });
  const chain = (id, o = {}) => ({ space: SPACE, hops: [{ actor: { kind: "person", id } }], ...o });
  await svc.ask(chain(ASKER), { note: "n", entry: ENTRY, name: "ada.vyre.run", person: OWNER, role: "owner" });
  assert.deepEqual([calls[0].input.person, calls[0].input.role, calls[0].caller], [ASKER, null, "module:vyred"], "who and role come from the chain and the kernel, not the input");
  await svc.status(chain(ASKER));
  await assert.rejects(() => svc.list(chain(ASKER)), (e) => e.code === "not_found");
  await assert.rejects(() => svc.decide(chain(ASKER2), { id: "x" }), (e) => e.code === "not_found");
  await svc.decide(chain(OWNER), { id: "req_1", approve: false });
  for (const bad of [chain(ASKER, { space: OTHER }), chain(ASKER, { viewer: true }), chain(ASKER, { delegated: true }), { space: SPACE, hops: [] }, { space: SPACE, hops: [{ actor: { kind: "agent", id: "kit" } }] }]) await assert.rejects(() => svc.ask(bad, {}), (e) => e.code === "not_found");
});

test("requests.attention lists what waits and what was refused, never the note", async () => {
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  await ask(w, ASKER, { name: "ada.vyre.run", note: "SECRET-NOTE" });
  const a = await w.tools.get("requests.attention").run({}, { caller: "module:approvals" });
  assert.equal(a.requests.length, 1);
  assert.deepEqual([a.requests[0].name, a.requests[0].entry, a.requests[0].space], ["ada.vyre.run", ENTRY, SPACE]);
  assert.ok(!JSON.stringify(a).includes("SECRET-NOTE"));
  assert.deepEqual(a.refusing, []);
});

test("approve is checked through the Space's door under the approver's own chain: it must exist, be theirs, be unused and unexpired, and give a role they may give", async () => {
  const calls = [];
  const registry = { call: async (tool, input) => { calls.push(input); return { data: { ok: true } }; } };
  const ADMIN = "per_" + "d".repeat(26), invId = "inv_" + "b".repeat(32), token = invId + ".pin";
  const listed = [{ id: invId, role: "member", status: "pending", invitee: ASKER, issued_by: ADMIN }];
  const mk = (list, role = "admin") => createRequestsService({ space: SPACE, kernel: { gateway: { members: { roleOf: ({ id }) => (id === ADMIN ? role : null) }, grants: { invites: { list: async (chain) => { assert.equal(chain.hops[0].actor.id, ADMIN, "read under the approver's chain"); return list; } } } } }, registry });
  const chain = { space: SPACE, hops: [{ actor: { kind: "person", id: ADMIN } }] };
  const go = (svc, extra = {}) => svc.decide(chain, { id: "req_1", approve: true, invite: token, ...extra }).then(() => "ok", (e) => `${e.code}:${e.message}`);
  assert.equal(await go(mk(listed)), "ok");
  assert.deepEqual([calls[0].input.invite, calls[0].input.invite_id, calls[0].input.invitee], [token, invId, ASKER]);
  for (const [why, list] of [["not found", []], ["made by someone else", [{ ...listed[0], issued_by: OWNER }]], ["already used", [{ ...listed[0], status: "used" }]], ["expired", [{ ...listed[0], status: "expired" }]], ["a role above the approver's", [{ ...listed[0], role: "owner" }]], ["no invitee", [{ ...listed[0], invitee: null }]]]) {
    const n = calls.length;
    assert.match(await go(mk(list)), /^bad_input:Approve by creating the invite first/, why);
    assert.equal(calls.length, n, `${why}: nothing reached the module`);
  }
  assert.match(await go(mk(listed), { invite: "inv_zz" }), /^bad_input/);
  const bad = createRequestsService({ space: SPACE, kernel: { gateway: { members: { roleOf: () => "admin" }, grants: { invites: { list: async () => { throw new Error("down"); } } } } }, registry });
  assert.match(await go(bad), /^bad_input/, "a gateway that cannot be read approves nothing");
  assert.equal(await mk(listed).decide(chain, { id: "req_1", approve: false }).then(() => "ok"), "ok", "declining needs no invite");
});

test("a declined or expired ask may be made again after a day: the same row is reopened under the same caps; sooner it gets the same answer", async () => {
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  await ask(w);
  const id = w.db.prepare("SELECT id FROM requests_asks").get().id;
  await w.tool("requests.decide", { space: SPACE, id, approve: false });
  assert.equal((await ask(w)).data.state, "not_accepted", "right after a decline: the same answer, no second row");
  w.tick(LIMITS.askAgainMs - 1000);
  assert.equal((await ask(w)).data.state, "not_accepted");
  w.tick(2000);
  assert.equal((await ask(w)).data.state, "waiting", "after a day it asks again");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM requests_asks").get().n, 1, "still one row");
  assert.equal(w.db.prepare("SELECT id FROM requests_asks").get().id, id);
});

test("requests.status is limited per identity (thirty a minute), requests.attention is for the approvals list and the box owner only, and decided_by is the person", async () => {
  const w = await world();
  await w.tool("requests.accept", { space: SPACE, accepting: true });
  await ask(w);
  const out = [];
  for (let n = 0; n < 32; n++) out.push((await w.serve("status", ASKER, null)).data.state);
  assert.deepEqual([out[0], out[29], out[30]], ["waiting", "waiting", "closed"], "the 31st read in a minute gets the closed words");
  assert.equal((await w.tools.get("requests.attention").run({}, { caller: "module:mail" }).catch((e) => e)).code, "denied", "another module is refused");
  assert.ok((await w.tools.get("requests.attention").run({}, { caller: "module:approvals" })).requests);
});

test("the owner turns asking on or off through the Space's door with one presence proof over the new value: none, a proof for the other value, a reused or an expired one change nothing; an admin is not found", async () => {
  const w = await world();
  const used = new Set();
  const svc = createRequestsService({ space: SPACE, registry: { call: async (tool, input) => ({ data: await w.tools.get("requests.serve").run(input, { caller: "module:vyred" }) }) },
    kernel: { gateway: { members: { roleOf: ({ id }) => (id === OWNER ? "owner" : id === ASKER2 ? "admin" : null) } }, presence: { check: async (i) => {
      const p = i.proof || {};
      if (p.expires_at <= 1000) return "expired";
      if (used.has(p.nonce)) return "replayed";
      const want = proofRequest(SPACE, "requestsSetting", { accepting: true });
      if (i.op !== want.op || JSON.stringify(i.fields) !== JSON.stringify(want.fields)) return "wrong_payload";
      used.add(p.nonce); return null;
    } } } });
  const chain = (id) => ({ space: SPACE, hops: [{ actor: { kind: "person", id } }] });
  const go = (c, input, proof) => svc.setting(c, input, proof ? { presence: proof } : undefined).then(() => "ok", (e) => e.code);
  assert.equal(await go(chain(OWNER), { accepting: true }), "needs_presence", "no proof");
  assert.equal(await go(chain(OWNER), { accepting: false }, { nonce: "a", expires_at: 5000 }), "needs_presence", "a proof for the other value");
  assert.equal(await go(chain(OWNER), { accepting: true }, { nonce: "b", expires_at: 500 }), "needs_presence", "expired");
  assert.equal((await w.tool("requests.accepting", { space: SPACE })).data.accepting, false, "nothing changed");
  assert.equal(await go(chain(ASKER2), { accepting: true }, { nonce: "c", expires_at: 5000 }), "not_found", "an admin does not switch it");
  assert.equal(await go(chain(OWNER), { accepting: true }, { nonce: "c", expires_at: 5000 }), "ok");
  assert.equal((await w.tool("requests.accepting", { space: SPACE })).data.accepting, true);
  assert.equal(await go(chain(OWNER), { accepting: true }, { nonce: "c", expires_at: 5000 }), "needs_presence", "a proof is used once");
});

test("turning requests on or off: with no counted presence device the home's answer lets the owner's own call through with no proof; without it the proof is asked; a member never", async () => {
  const calls = [];
  const registry = { call: async (tool, input) => { calls.push({ tool, input }); return { data: { ok: true } }; } };
  const roles = { [OWNER]: "owner", [ASKER2]: "member" };
  const mk = (free) => createRequestsService({ space: SPACE, kernel: { gateway: { members: { roleOf: ({ id }) => roles[id] ?? null } }, presence: { check: async () => "no_proof" }, ...(free ? { presenceNotNeeded: ({ action }) => action === "requests.setting" } : {}) }, registry });
  const chain = (id) => ({ space: SPACE, hops: [{ actor: { kind: "person", id } }] });
  await mk(true).setting(chain(OWNER), { accepting: true });
  assert.equal(calls.at(-1).input.call, "setting", "the owner's call ran with no proof");
  await assert.rejects(() => mk(false).setting(chain(OWNER), { accepting: true }), (e) => e.code === "needs_presence");
  await assert.rejects(() => mk(true).setting(chain(ASKER2), { accepting: true }), (e) => e.code === "not_found");
});
