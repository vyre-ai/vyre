// @ts-check
// Group chats on the stream: frames, routing, per-viewer rendering, presence, read markers, concurrent streams.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, frame, toEnvelope, whoAnswers, render, assertAskerCanRead, createPresence, presenceFor, createReadMarkers, settle, HOLDBACK, cutData, forViewer, isEncrypted } from "./index.js";
import { SessionLog } from "./log.js";
import { connect } from "./client.js";
import { prng, Sched, makeLink } from "./testkit.js";

const mk = (/** @type {string} */ kind, /** @type {any} */ data, /** @type {any} */ extra = {}) => frame(kind, data, { session: "s", cur: 1, ...extra });
const ok = (/** @type {any} */ f) => assert.deepEqual(validate(f), { ok: true });
const bad = (/** @type {any} */ f, /** @type {RegExp} */ re) => { const r = validate(f); assert.equal(r.ok, false); assert.match(/** @type {any} */ (r).error, re); };

test("old frames without author, acts_for or message stay valid; new fields validate", () => {
  ok(mk("text-delta", { message: "m", index: 0, text: "x" }));
  ok(mk("text-delta", { message: "m", index: 0, text: "x", parent: "m0" }, { author: "assistant:kit", acts_for: "person:chris", message: "m" }));
  bad(mk("text-delta", { message: "m", index: 0, text: "x" }, { author: "kit" }), /author/);
  bad(mk("text-delta", { message: "m", index: 0, text: "x" }, { author: "person:chris", acts_for: "person:alex" }), /acts_for/);
  bad(mk("text-delta", { message: "m", index: 0, text: "x" }, { author: "assistant:kit", acts_for: "kit" }), /acts_for/);
  bad(mk("user-message", { message: "m", text: "t", state: "sent", parent: "" }), /user-message/);
});

test("every new kind validates, and rejects a bad shape", () => {
  ok(mk("participant-joined", { who: "assistant:kit", role: "default" }));
  ok(mk("participant-left", { who: "person:alex" }));
  ok(mk("presence", { who: "assistant:kit", state: "doing", doing: "running the tests" }, { cur: 0 }));
  bad(mk("presence", { who: "assistant:kit", state: "sleeping" }, { cur: 0 }), /presence/);
  bad(mk("presence", { who: "assistant:kit", state: "typing" }, { cur: 4 }), /cur 0/);
  ok(mk("reaction", { message: "m", emoji: "👍", on: true }));
  bad(mk("reaction", { message: "m", emoji: "", on: true }), /reaction/);
  ok(mk("pin", { message: "m", on: false }));
  ok(mk("mention", { message: "m", who: ["assistant:kit", "person:chris"] }));
  bad(mk("mention", { message: "m", who: [] }), /mention/);
  ok(mk("read-marker", { upto: 12 }, { cur: 0, author: "person:alex" }));
  ok(mk("fanout", { group: "g", message: "q", members: [{ who: "model:a", message: "a1" }, { who: "model:b", message: "a2" }] }));
  bad(mk("fanout", { group: "g", message: "q", members: [{ who: "model:a", message: "a1" }] }), /fanout/);
  ok(mk("fanout-keep", { group: "g", keep: "a2" }));
  ok(mk("text-cut", cutData("m")));
  assert.equal(cutData("m").note, "stopped: a sealed value was about to be shown");
});

test("toEnvelope: author becomes actor, acts_for the first hop of the chain", () => {
  const f = mk("tool-finished", { tool_id: "t", ok: true, result: { block: "text", text: "x" } }, { author: "assistant:kit", acts_for: "person:chris" });
  const e = toEnvelope(f);
  assert.equal(e.actor, "assistant:kit");
  assert.deepEqual(e.chain, ["person:chris", "assistant:kit"]);
  assert.equal(toEnvelope(mk("pin", { message: "m", on: true }, { author: "person:alex" })).chain.length, 0);
  assert.equal(toEnvelope(mk("pin", { message: "m", on: true })).actor, "agent:session@local");
});

test("the log carries author, acts_for and message; two assistants never merge", () => {
  const log = new SessionLog("s", { mergeChars: 1000 });
  const A = { author: "assistant:kit", acts_for: "person:chris", message: "m1" };
  const B = { author: "assistant:juno", acts_for: "person:chris", message: "m2" };
  log.append("text-delta", { message: "m1", index: 0, text: "a" }, A);
  log.append("text-delta", { message: "m2", index: 0, text: "b" }, B);
  log.append("text-delta", { message: "m1", index: 0, text: "c" }, A);
  log.append("text-delta", { message: "m1", index: 0, text: "d" }, A);
  const fs = log.read(0);
  assert.equal(fs.length, 3, "only the adjacent deltas of the same message merged");
  assert.deepEqual(fs.map(f => [f.author, f.data.text]), [["assistant:kit", "a"], ["assistant:juno", "b"], ["assistant:kit", "cd"]]);
  assert.equal(fs[2].message, "m1");
  assert.throws(() => log.emit("text-delta", {}), /ephemeral/);
});

// ---- routing -----------------------------------------------------------------------------------

const P = [{ id: "person:alex" }, { id: "person:chris" }, { id: "assistant:kit", name: "kit" }, { id: "assistant:juno", name: "juno" }];
const solo = [{ id: "person:alex" }, { id: "assistant:kit", name: "kit" }];

test("routing: a mentioned assistant answers, by list or by @name; several can", () => {
  assert.deepEqual(whoAnswers({ participants: P, defaultAssistant: "assistant:kit", text: "hi", mentions: ["assistant:juno"], author: "person:alex", previous: "person:chris" }), ["assistant:juno"]);
  assert.deepEqual(whoAnswers({ participants: P, text: "@juno and @kit compare these", author: "person:alex", previous: "person:chris" }), ["assistant:juno", "assistant:kit"]);
  assert.deepEqual(whoAnswers({ participants: P, text: "mail me at alex@kit.com", author: "person:alex", previous: "assistant:kit" }), [], "an address is not a mention");
});

test("routing: the assigned assistant answers, with or without a mention", () => {
  assert.deepEqual(whoAnswers({ participants: P, text: "go", assigned: "assistant:juno", author: "person:alex", previous: "person:chris" }), ["assistant:juno"]);
  assert.deepEqual(whoAnswers({ participants: P, text: "@kit go", assigned: "juno", author: "person:alex" }), ["assistant:kit", "assistant:juno"]);
});

test("routing: the default assistant answers an unmentioned message when no person is talking to a person", () => {
  assert.deepEqual(whoAnswers({ participants: solo, defaultAssistant: "assistant:kit", text: "what is due?", author: "person:alex" }), ["assistant:kit"]);
  assert.deepEqual(whoAnswers({ participants: P, defaultAssistant: "assistant:kit", text: "and the fee?", author: "person:alex", previous: "assistant:kit" }), ["assistant:kit"], "the last speaker was an assistant");
  assert.deepEqual(whoAnswers({ participants: P, defaultAssistant: "assistant:kit", text: "and the fee?", author: "person:alex", previous: "person:alex" }), ["assistant:kit"], "the person's own follow-up");
});

test("routing: never jumps in between people", () => {
  assert.deepEqual(whoAnswers({ participants: P, defaultAssistant: "assistant:kit", text: "lunch?", author: "person:alex", previous: "person:chris" }), []);
  assert.deepEqual(whoAnswers({ participants: P, defaultAssistant: "assistant:kit", text: "lunch?", author: "person:alex" }), [], "two people and no history: stay out");
  assert.deepEqual(whoAnswers({ participants: P, defaultAssistant: "assistant:kit", text: "@chris lunch?", author: "person:alex", previous: "assistant:kit" }), [], "addressed to a person");
});

test("routing: an assistant never wakes the default assistant or itself; no default, no answer", () => {
  assert.deepEqual(whoAnswers({ participants: solo, defaultAssistant: "assistant:kit", text: "done", author: "assistant:kit" }), []);
  assert.deepEqual(whoAnswers({ participants: P, text: "@kit again", author: "assistant:kit" }), []);
  assert.deepEqual(whoAnswers({ participants: P, text: "@kit hi", author: "assistant:juno" }), ["assistant:kit"], "assistants can ask each other");
  assert.deepEqual(whoAnswers({ participants: solo, text: "hello", author: "person:alex" }), []);
});

// ---- per viewer --------------------------------------------------------------------------------

const record = () => ({ block: "record", urn: "urn:vyre:rec:1", type: "matter", title: "Harlow v. Northwind", fields: [
  { name: "title", label: "Title", kind: "text", value: "Harlow v. Northwind" },
  { name: "fee", label: "Fee", kind: "money", value: { amount: 4200, currency: "USD" }, read_roles: ["owner", "admin"] },
  { name: "ssn", label: "SSN", kind: "sealed", value: { sealed: "ssn", ref: "seal:abc", present: true, valid_format: true, set_at: 1 }, seal: { level: "human", class: "ssn", reveal_roles: ["owner"] } },
] });
const V = { owner: { id: "person:alex", roles: ["owner"] }, admin: { id: "person:chris", roles: ["admin"] }, member: { id: "person:sam", roles: ["member"] } };

test("per viewer: three roles see different placeholders from one frame, and the frame is not mutated", () => {
  const f = mk("tool-finished", { tool_id: "t", ok: true, result: record() }, { author: "assistant:kit", acts_for: "person:alex" });
  const before = JSON.stringify(f);
  const o = render(f, V.owner), a = render(f, V.admin), m = render(f, V.member);
  assert.equal(JSON.stringify(f), before, "the shared frame is untouched");
  const by = (/** @type {any} */ x, /** @type {string} */ n) => x.data.result.fields.find((/** @type {any} */ y) => y.name === n);
  assert.deepEqual(by(o, "fee").value, { amount: 4200, currency: "USD" });
  assert.deepEqual(by(a, "fee").value, { amount: 4200, currency: "USD" });
  assert.deepEqual(by(m, "fee").value, { hidden: "role", kind: "money", present: true });
  assert.deepEqual(by(o, "ssn").value, { sealed: "ssn", present: true, valid_format: true, can_reveal: true });
  assert.deepEqual(by(a, "ssn").value, { sealed: "ssn", present: true, valid_format: true, can_reveal: false });
  assert.deepEqual(by(m, "ssn").value, by(a, "ssn").value);
  for (const x of [o, a, m]) { assert.ok(!JSON.stringify(x).includes("seal:abc"), "no ref leaves the log"); assert.equal(by(x, "title").value, "Harlow v. Northwind"); }
  assert.notDeepEqual(o, m);
  assert.equal(render(mk("text-delta", { message: "m", index: 0, text: "x" }), V.member).data.text, "x");
  // a draft and an answer are drawn the same way
  const d = render(mk("tool-finished", { tool_id: "t", ok: true, result: { block: "draft", fields: record().fields } }), V.member);
  assert.equal(d.data.result.fields[1].placeholder, true);
});

test("per viewer: an assistant reply built under the asker never holds a field the asker cannot read", () => {
  const rnd = prng(77);
  const roles = ["owner", "admin", "member", "temp"];
  for (let i = 0; i < 200; i++) {
    const asker = { id: "person:x", roles: [roles[Math.floor(rnd() * roles.length)]] };
    const fields = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, k) => {
      const sealed = rnd() < 0.3, rr = rnd() < 0.5 ? roles.filter(() => rnd() < 0.5) : undefined;
      return { name: `f${k}`, label: `F${k}`, kind: sealed ? "sealed" : "text", value: sealed ? { sealed: "c", ref: "r" + k, present: true, valid_format: true, set_at: 1 } : `secret-${i}-${k}`, ...(rr ? { read_roles: rr } : {}) };
    });
    const raw = mk("tool-finished", { tool_id: "t", ok: true, result: { block: "record", fields } });
    const mustFail = fields.some(f => f.kind === "sealed" || (f.read_roles && f.read_roles.length && !f.read_roles.includes(asker.roles[0])));
    if (mustFail) assert.throws(() => assertAskerCanRead(raw, asker), (/** @type {any} */ e) => e.code === "asker-cannot-read");
    else assertAskerCanRead(raw, asker);
    // the safe way to build the reply: draw it for the asker; that is always accepted
    const drawn = render(raw, asker);
    assertAskerCanRead(drawn, asker);
    for (const f of fields) if (f.kind !== "sealed") assert.ok(JSON.stringify(drawn).includes(`secret-${i}-${f.name.slice(1)}`) === (!f.read_roles || !f.read_roles.length || f.read_roles.includes(asker.roles[0])));
  }
});

test("per viewer: the log refuses an assistant reply the asker could not read", () => {
  const log = new SessionLog("s");
  const asker = V.member;
  assert.throws(() => log.append("tool-finished", { tool_id: "t", ok: true, result: record() }, { author: "assistant:kit", acts_for: asker.id, asker }), /cannot read/);
  assert.equal(log.head, 0, "nothing was appended");
  log.append("tool-finished", { tool_id: "t", ok: true, result: render(mk("tool-finished", { tool_id: "t", ok: true, result: record() }), asker).data.result }, { author: "assistant:kit", acts_for: asker.id, asker });
  assert.equal(log.head, 1);
});

test("door holdback: the last 40 characters are provisional until done", () => {
  assert.equal(HOLDBACK, 40);
  assert.deepEqual(settle("short", false), { stable: "", provisional: "short" });
  const t = "x".repeat(100);
  assert.deepEqual(settle(t, false), { stable: "x".repeat(60), provisional: "x".repeat(40) });
  assert.deepEqual(settle(t, true), { stable: t, provisional: "" });
});

// ---- presence, read markers --------------------------------------------------------------------

test("presence: one per author per 3 s, ephemeral, never logged or replayed", () => {
  let t = 1000;
  const p = createPresence({ session: "s", now: () => t });
  const a = p.set("assistant:kit", "doing", "running the tests");
  assert.ok(a && a.cur === 0 && validate(a).ok);
  assert.equal(p.set("assistant:kit", "doing", "still running"), null);
  t += 2999; assert.equal(p.set("assistant:kit", "typing"), null);
  assert.ok(p.set("person:alex", "typing"), "another author is independent");
  t += 1; assert.ok(p.set("assistant:kit", "doing", "writing the diff"), "3 s later it goes out");
  p.clear("person:alex"); assert.ok(p.set("person:alex", "typing"), "cleared, so it goes out at once");

  const log = new SessionLog("s", { now: () => t });
  const heard = /** @type {any[]} */ ([]);
  log.subscribe(f => heard.push(f));
  const pf = presenceFor(log, () => t);
  assert.ok(pf.set("assistant:kit", "doing", "running the tests"));
  assert.equal(pf.set("assistant:kit", "doing", "x"), null);
  assert.equal(heard.length, 1);
  assert.equal(heard[0].cur, 0);
  assert.equal(log.head, 0, "no cursor was spent");
  assert.deepEqual(log.read(0), [], "nothing to replay");
});

test("presence reaches a connected client without touching its cursor", async () => {
  const sched = new Sched(), rnd = prng(5);
  const log = new SessionLog("s", { now: () => sched.t });
  const got = /** @type {any[]} */ ([]);
  const client = connect({ open: makeLink({ log, sched, rnd, faultRate: 0 }), timers: sched, random: rnd, onFrame: f => got.push(f) });
  log.append("text-delta", { message: "m", index: 0, text: "hi" }, { author: "assistant:kit", message: "m" });
  await sched.run(() => got.length === 1);
  log.emit("presence", { who: "person:alex", state: "typing" }, { author: "person:alex" });
  log.emit("presence", { who: "person:alex", state: "typing" });
  await sched.run(() => got.length >= 3);
  assert.deepEqual(got.map(f => f.type), ["session.text-delta", "session.presence", "session.presence"]);
  assert.equal(client.last, 1, "presence has no cursor");
  client.close();
});

test("read marker: per person across that person's devices, forward only, nobody else hears it", () => {
  const r = createReadMarkers();
  const phone = /** @type {any[]} */ ([]), laptop = /** @type {any[]} */ ([]), other = /** @type {any[]} */ ([]);
  r.subscribe("person:alex", f => phone.push(f)); r.subscribe("person:alex", f => laptop.push(f)); r.subscribe("person:chris", f => other.push(f));
  const f = r.set("person:alex", "s1", 10);
  assert.ok(f && validate(f).ok && f.cur === 0 && f.author === "person:alex");
  assert.equal(phone.length, 1); assert.equal(laptop.length, 1); assert.equal(other.length, 0);
  assert.equal(r.set("person:alex", "s1", 7), null, "never moves back");
  assert.equal(r.get("person:alex", "s1"), 10);
  assert.equal(r.get("person:chris", "s1"), 0, "per person, not per session");
  r.set("person:chris", "s1", 4);
  assert.equal(r.unread("person:alex", "s1", 15), 5);
  assert.equal(r.unread("person:chris", "s1", 15), 11);
  const r2 = createReadMarkers(); r2.load(JSON.parse(JSON.stringify(r.toJSON())));
  assert.equal(r2.get("person:alex", "s1"), 10);
  assert.throws(() => r.set("assistant:kit", "s1", 1), /person/);
});

// ---- concurrent streams ------------------------------------------------------------------------

const WORDS = ["alpha ", "béta ", "漢字 ", "gamma\n", "😀 ", "delta, ", "x", "epsilon "];

test("two or three assistants streaming at once, random interleavings and kills (seeded x200): each message reassembles exactly", async () => {
  let kills = 0;
  for (let it = 0; it < 200; it++) {
    const rnd = prng(31000 + it), sched = new Sched();
    const log = new SessionLog("s", { maxFrames: it % 3 === 0 ? 6 : 4000, coalesce: it % 2 === 0, mergeChars: 120, now: () => sched.t });
    const stats = { opens: 0, kills: 0, silent: 0, bytes: 0 };
    const n = 2 + (it % 2);
    const who = Array.from({ length: n }, (_, k) => ({ id: `assistant:a${k}`, msg: `m${k}`, text: "", left: 20 + Math.floor(rnd() * 60) }));
    /** @type {Record<string, string>} */ const got = {};
    /** @type {Record<string, string>} */ const authors = {};
    let snaps = 0, done = 0;
    const client = connect({
      open: makeLink({ log, sched, rnd, relay: it % 2 === 1, stats }), timers: sched, random: rnd,
      snapshot: () => { snaps++; for (const w of who) got[w.msg] = w.text; return { cur: log.head }; },
      onFrame: f => {
        if (f.type !== "session.text-delta") return;
        got[f.message] = (got[f.message] || "") + f.data.text;
        assert.equal(f.data.message, f.message);
        authors[f.message] = authors[f.message] ?? f.author;
        assert.equal(authors[f.message], f.author, "a message never changes author");
      },
    });
    // each tick one random assistant with words left emits a delta
    let at = 1;
    const total = who.reduce((s, w) => s + w.left, 0);
    for (let i = 0; i < total; i++) {
      at += Math.floor(rnd() * 20);
      sched.setTimeout(() => {
        const live = who.filter(w => w.left > 0);
        const w = live[Math.floor(rnd() * live.length)];
        const word = WORDS[Math.floor(rnd() * WORDS.length)];
        w.text += word; w.left--;
        log.append("text-delta", { message: w.msg, index: 0, text: word }, { turn: "1", author: w.id, acts_for: "person:chris", message: w.msg });
        if (w.left === 0) { log.append("text-done", { message: w.msg }, { turn: "1", author: w.id, acts_for: "person:chris", message: w.msg }); done++; }
      }, at);
    }
    await sched.run(() => done === n && client.last === log.head);
    kills += stats.kills;
    assert.equal(done, n, `iteration ${it}: producers finished`);
    for (const w of who) assert.equal(got[w.msg], w.text, `iteration ${it}: ${w.msg} reassembles exactly`);
    if (it % 3 !== 0) assert.equal(snaps, 0);
    client.close(); log.close();
  }
  assert.ok(kills > 100, `the faults really happened (${kills})`);
  console.log(JSON.stringify({ test: "concurrent-streams", iterations: 200, kills }));
});

// ---- private mode: the room for an opaque encrypted message (DESIGN-chat, "Who can read a chat, and private mode") ------------------

const ENC = { alg: "mls-x", kid: "dev:alex#7", ct: "q83vEjRWeJq83vEjRWeJ" };

test("private: user-message { enc } validates, text and enc are exclusive, and a malformed enc is refused", () => {
  const f = mk("user-message", { message: "p1", enc: ENC, state: "sent" }, { author: "person:alex" });
  assert.deepEqual(validate(f), { ok: true });
  assert.equal(isEncrypted(f), true);
  assert.equal(isEncrypted(mk("user-message", { message: "p2", text: "hi", state: "sent" })), false);
  assert.equal(validate({ ...f, data: { ...f.data, text: "hello" } }).ok, false, "the home never holds the words beside the ciphertext");
  assert.equal(validate({ ...f, data: { message: "p1", enc: { ...ENC, ct: "" }, state: "sent" } }).ok, false);
  assert.equal(validate({ ...f, data: { message: "p1", enc: { ...ENC, extra: 1 }, state: "sent" } }).ok, false);
  assert.equal(validate({ ...f, data: { message: "p1", state: "sent" } }).ok, false, "neither text nor enc");
});

test("private: viewer.render and forViewer pass an encrypted message through untouched, for any viewer", () => {
  const f = mk("user-message", { message: "p1", enc: ENC, state: "sent" }, { author: "person:alex" });
  for (const v of [V.owner, V.admin, V.member]) { assert.equal(render(f, v), f, "render returns the very frame"); assert.equal(forViewer(f, v), f); }
});

test("private: routing never wakes an assistant for an encrypted message, whoever it mentions", () => {
  const participants = [{ id: "person:alex" }, { id: "assistant:kit", name: "kit" }];
  assert.deepEqual(whoAnswers({ participants, defaultAssistant: "assistant:kit", author: "person:alex", text: "hi" }), ["assistant:kit"], "control: a plain message wakes the default");
  for (const extra of [{}, { text: "@kit do it" }, { mentions: ["assistant:kit"] }, { assigned: "assistant:kit" }]) {
    assert.deepEqual(whoAnswers({ participants, defaultAssistant: "assistant:kit", author: "person:alex", enc: ENC, ...extra }), [], JSON.stringify(extra));
  }
});

test("private: toEnvelope records that a private message passed, never what it said", () => {
  const f = mk("user-message", { message: "p1", enc: ENC, state: "sent" }, { author: "person:alex" });
  const env = toEnvelope(f, { space: "sp" });
  assert.deepEqual(env.data, { message: "p1", state: "sent", enc: true });
  assert.ok(!JSON.stringify(env).includes(ENC.ct) && !JSON.stringify(env).includes(ENC.kid));
});
