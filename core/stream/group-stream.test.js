// @ts-check
// Task O: a group reply STREAMS and belongs to the room it was opened for (chat 0.3; ruling in team/0.3/DESIGN-chat.md "How the kernel holds a chat").
// The first delta opens the reply through the reply port, which stamps it with the chat's membership version; each delta goes, per viewer, only to
// people who were in the chat at that version; someone who joins mid-reply gets no frame of it and sees the chat from their own join; someone who leaves stops
// receiving. Run against both ports: the in-memory one that follows the ruling for kernel-2's chats.appendOpen (fake-reply-port.js) and the stand-in the stream
// uses until that lands (it stamps with the log's cursor and reads the kernel's list at open).
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Logs } from "./log.js";
import { createGroups } from "./group.js";
import { serve } from "./server.js";
import { connect } from "./client.js";
import { prng, Sched, makeLink } from "./testkit.js";
import { createFakeKernel } from "./fake-reply-port.js";

const PORTS = ["fake appendOpen port", "stand-in port"];

/** A group rig: a fake kernel, a stream log registry, the groups, and a thread per assistant that the test speaks for. @param {any} t @param {string} which @param {() => number} [now] */
function rig(t, which, now = () => Date.now(), extra = /** @type {any} */ ({})) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  let n = 0;
  /** @type {any[]} */ const started = [];
  const ctx = {
    log: () => {}, kernel: fk.kernel, ...(extra.config ? { config: extra.config } : {}),
    call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
      if (tool === "threads.start") { const id = `thr_${++n}`; started.push({ id, ...i }); return { data: { id } }; }
      if (tool === "threads.get") return { data: { events: [] } };
      return { data: {} };
    },
  };
  const groups = createGroups({ ctx, logs, db, now, ...(extra.timers ? { timers: extra.timers } : {}), ...(which === PORTS[0] ? { replyPort: extra.wrapPort ? extra.wrapPort(fk.port) : fk.port } : { standIn: true }) });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  let eid = 0;
  /** A call from `who` (a kernel person such as "bob"): the kernel's list is mirrored first, as stream.open and every stream tool do. @param {string} grp @param {string} who */
  const call = async (grp, who) => {
    const meta = {};
    const c = /** @type {any} */ (fk.chats.get(grp));
    await groups.mirror(grp, { people: c.people, assistants: c.assistants }, meta, `person:${who}`, { person: who });
    return meta;
  };
  const send = async (/** @type {string} */ grp, /** @type {string} */ who, /** @type {string} */ message, /** @type {string} */ text, /** @type {string[]} */ to) => {
    const meta = await call(grp, who);
    const r = await groups.send({ chat: grp, text, message, to, cwd: "/tmp" }, meta);
    await groups.idle();
    return r;
  };
  const threadOf = (/** @type {string} */ grp, /** @type {string} */ bot) => String(/** @type {any} */ (groups.member(grp, bot)).thread);
  /** One thing a thread says, the way the switchboard emits it. */
  /** Any switchboard event of a thread (thinking, a tool, a status). */
  const ev = (/** @type {string} */ thread, /** @type {string} */ type, /** @type {any} */ payload) => groups.onEvent({ id: ++eid, type, thread, payload });
  const say = (/** @type {string} */ thread, /** @type {string} */ message, /** @type {{ delta?: string, done?: boolean, kind?: string }} */ p) => groups.onEvent({ id: ++eid, type: p.kind || "thread.text", thread, payload: { message, block: 0, ...(p.delta !== undefined ? { delta: p.delta } : {}), ...(p.done ? { done: true } : {}) } });
  /** What a person's connection receives (direct serve, no transport). @param {string} grp @param {string} who @param {number} [from] */
  const watch = (grp, who, from = 0) => {
    /** @type {any[]} */ const frames = [];
    /** @type {(() => void)[]} */ const cs = [];
    const viewer = { id: `person:${who}`, roles: /** @type {string[]} */ ([]), ...groups.viewerFor(grp, `person:${who}`) };
    const s = serve(logs.get(grp), { send: f => frames.push(f), onClose: cb => cs.push(cb) }, { from, viewer });
    return { frames, close: () => s.close(), viewer };
  };
  return { fk, logs, groups, call, send, say, ev, threadOf, watch, started };
}
/** The text a viewer received per message id, and what else it saw of a message (any frame naming it). @param {any[]} frames */
const textsOf = frames => {
  /** @type {Record<string, string>} */ const out = {};
  for (const f of frames) if (f.type === "chat.text-delta" && !f.data.reasoning) out[f.data.message] = (out[f.data.message] || "") + f.data.text;
  return out;
};
const nonHidden = (/** @type {any[]} */ frames) => frames.filter(f => f.type !== "chat.hidden" && f.cur > 0);

for (const which of PORTS) {
  test(`[${which}] someone who joins mid-reply gets no frame of that reply, sees the chat from their join, and gets the next message in full`, async t => {
    const r = rig(t, which);
    r.fk.create("c1", ["bob", "carol"], ["kit"]);
    const bob = (await r.call("c1", "bob"), r.watch("c1", "bob"));
    await r.send("c1", "bob", "q1", "what is the fee?", ["assistant:kit"]);
    const kit = r.threadOf("c1", "assistant:kit");
    r.say(kit, "m1", { delta: "SECRET-ONE streaming " });
    await r.groups.idle();
    // dave joins the chat while kit is mid-reply
    r.fk.change("c1", { add: ["dave"] });
    await r.call("c1", "dave");
    const dave = r.watch("c1", "dave");
    r.say(kit, "m1", { delta: "SECRET-TWO the rest" });
    r.say(kit, "m1", { done: true });
    await r.groups.idle();
    await r.send("c1", "bob", "q2", "and the retainer?", ["assistant:kit"]);
    r.say(kit, "m2", { delta: "Second " });
    r.say(kit, "m2", { delta: "reply." });
    r.say(kit, "m2", { done: true });
    await r.groups.idle();

    const first = textsOf(bob.frames);
    assert.equal(first["m1"] ?? first["q1.kit"] ?? Object.values(first)[0], "SECRET-ONE streaming SECRET-TWO the rest", "bob, who was there, got the whole first reply as it streamed");
    assert.ok(bob.frames.filter(f => f.type === "chat.text-delta").length >= 3, "it streamed delta by delta, not as one held message");
    const seen = JSON.stringify(dave.frames);
    assert.ok(!seen.includes("SECRET"), "dave gets nothing of the reply that streamed while he joined, not even the later deltas");
    assert.ok(!seen.includes("what is the fee"), "and nothing said before he joined");
    const mine = nonHidden(dave.frames);
    assert.ok(mine.some(f => f.type === "chat.participant-joined" && f.data.who === "person:dave" && !f.data.quiet), "his own join is the marker");
    assert.ok(mine.filter(f => f.type === "chat.participant-joined" && f.data.who !== "person:dave").every(f => f.data.quiet), "who was there before him is roster only");
    const tail = Object.values(textsOf(dave.frames));
    assert.deepEqual(tail, ["Second reply."], "he sees the next message in full");
    assert.ok(mine.some(f => f.type === "chat.user-message" && f.data.text === "and the retainer?"));
    // cursors stay gapless for him: every cursor from 1 to head is accounted for once
    const cover = dave.frames.filter(f => f.cur > 0).flatMap(f => { const n = f.span || 1; return Array.from({ length: n }, (_, i) => f.cur - n + 1 + i); });
    assert.deepEqual(cover, Array.from({ length: r.logs.get("c1").head }, (_, i) => i + 1));
    // replay after a reconnect delivers what a live viewer got
    const again = r.watch("c1", "dave");
    assert.deepEqual(nonHidden(again.frames), nonHidden(dave.frames));
    assert.deepEqual(r.watch("c1", "bob").frames.filter(f => f.cur > 0), bob.frames.filter(f => f.cur > 0));
  });

  test(`[${which}] someone who leaves mid-reply stops receiving it`, async t => {
    let clock = 1000;
    const r = rig(t, which, () => clock);
    r.fk.create("c2", ["bob", "carol"], ["kit"]);
    await r.call("c2", "carol");
    const carol = r.watch("c2", "carol");
    const bob = r.watch("c2", "bob");
    await r.send("c2", "bob", "q1", "go", ["assistant:kit"]);
    const kit = r.threadOf("c2", "assistant:kit");
    r.say(kit, "m1", { delta: "one " });
    await r.groups.idle();
    r.fk.change("c2", { remove: ["carol"] });
    clock += 2000; // the stand-in reads the kernel's list again after this long
    r.say(kit, "m1", { delta: "two " });
    r.say(kit, "m1", { delta: "three" });
    r.say(kit, "m1", { done: true });
    await r.groups.idle();
    assert.equal(Object.values(textsOf(bob.frames))[0], "one two three");
    assert.equal(Object.values(textsOf(carol.frames))[0], "one ", "carol had the words before she left and none after");
    assert.ok(!carol.frames.some(f => f.type === "chat.text-done"));
  });
}

test("a reply the kernel refuses at open is shown nowhere, one it takes back mid-reply is cut", async t => {
  const r = rig(t, PORTS[0]);
  r.fk.create("c3", ["bob"], ["kit"]);
  const bob = r.watch("c3", "bob");
  await r.send("c3", "bob", "q1", "go", ["assistant:kit"]);
  const kit = r.threadOf("c3", "assistant:kit");
  r.fk.refuse.add("c3");
  r.say(kit, "m1", { delta: "never shown" });
  r.say(kit, "m1", { done: true });
  await r.groups.idle();
  assert.ok(!JSON.stringify(bob.frames).includes("never shown"), "refused at open: nothing, not a delta");
  r.fk.refuse.delete("c3");
  await r.send("c3", "bob", "q2", "again", ["assistant:kit"]);
  r.say(kit, "m2", { delta: "partial " });
  await r.groups.idle();
  r.fk.refuse.add("c3");
  r.say(kit, "m2", { delta: "more" });
  r.say(kit, "m2", { done: true });
  await r.groups.idle();
  const types = bob.frames.filter(f => f.data && f.data.message && String(f.data.message).includes("q2")).map(f => f.type);
  assert.ok(types.includes("chat.text-cut"), "taken back mid-reply: the people who had it see it cut");
  assert.ok(!JSON.stringify(bob.frames).includes("more"));
});

for (const which of PORTS) {
  test(`[${which}] two assistants stream at once, links die at random, someone joins mid-stream: x100, each viewer reassembles exactly what they were entitled to`, async t => {
    const sched = new Sched();
    const r = rig(t, which, () => sched.t);
    let shut = 0, whole = 0;
    for (let it = 0; it < 100; it++) {
      const rnd = prng(7000 + it);
      const grp = `c${it}`;
      r.fk.create(grp, ["bob", "carol"], ["kit", "juno"]);
      /** @type {Record<string, { text: string, last: number, seen: number[] }>} */ const who = {};
      /** @param {string} p */
      const start = p => {
        const state = { text: /** @type {Record<string, string>} */ ({}), last: 0, seen: /** @type {number[]} */ ([]), nonText: /** @type {string[]} */ ([]) };
        const stats = { opens: 0, kills: 0, silent: 0, bytes: 0 };
        const viewer = { id: `person:${p}`, roles: /** @type {string[]} */ ([]), ...r.groups.viewerFor(grp, `person:${p}`) };
        const client = connect({
          open: makeLink({ log: r.logs.get(grp), sched, rnd, relay: it % 2 === 0, stats, serveOpts: { viewer } }), timers: sched, random: rnd,
          snapshot: () => ({ cur: r.logs.get(grp).head }),
          onFrame: f => { state.seen.push(f.cur); if (f.type === "chat.text-delta" && !f.data.reasoning) state.text[f.data.message] = (state.text[f.data.message] || "") + f.data.text; else if (f.type === "chat.user-message") state.nonText.push(f.data.message); },
        });
        return { state, client };
      };
      await r.call(grp, "bob"); await r.call(grp, "carol");
      const views = { bob: start("bob"), carol: start("carol"), /** @type {any} */ ada: null };
      await r.send(grp, "bob", `q1-${it}`, "ask one", ["assistant:kit"]);
      await r.send(grp, "carol", `q2-${it}`, "ask two", ["assistant:juno"]);
      const kit = r.threadOf(grp, "assistant:kit"), juno = r.threadOf(grp, "assistant:juno");
      const words = ["alpha ", "béta ", "漢字 ", "gamma\n", "😀 ", "delta, ", "x"];
      /** @type {{ bot: string, thread: string, message: string, delta?: string, done?: boolean }[]} */ const steps = [];
      /** @type {Record<string, string>} */ const emitted = {};
      const lanes = [{ thread: kit, message: `k-${it}` }, { thread: juno, message: `j-${it}` }];
      /** @type {{ thread: string, message: string, left: number }[]} */ const live = lanes.map(l => ({ ...l, left: 4 + Math.floor(rnd() * 10) }));
      while (live.length) {
        const i = Math.floor(rnd() * live.length), l = live[i];
        if (l.left === 0) { steps.push({ bot: "", thread: l.thread, message: l.message, done: true }); live.splice(i, 1); continue; }
        const w = words[Math.floor(rnd() * words.length)];
        emitted[l.message] = (emitted[l.message] || "") + w;
        steps.push({ bot: "", thread: l.thread, message: l.message, delta: w });
        l.left--;
      }
      const joinAt = Math.floor(rnd() * (steps.length + 1));
      /** @type {Record<string, boolean>} */ const openedAfterJoin = {};
      let joined = false;
      for (let i = 0; i <= steps.length; i++) {
        if (i === joinAt) {
          r.fk.change(grp, { add: ["ada"] });
          await r.call(grp, "ada");
          views.ada = start("ada");
          joined = true;
        }
        const s = steps[i];
        if (!s) break;
        if (s.delta !== undefined && !(s.message in openedAfterJoin)) openedAfterJoin[s.message] = joined;
        r.say(s.thread, s.message, s.delta !== undefined ? { delta: s.delta } : { done: true });
        await r.groups.idle();
        const t0 = sched.t, span = 1 + Math.floor(rnd() * 60);
        await sched.run(() => sched.t >= t0 + span);
      }
      // after she has joined, ada is asked about too: the next message is hers in full
      await r.send(grp, "bob", `q3-${it}`, "ask three", ["assistant:kit"]);
      for (const w of ["last ", "words"]) { r.say(kit, `k3-${it}`, { delta: w }); await r.groups.idle(); }
      r.say(kit, `k3-${it}`, { done: true });
      await r.groups.idle();
      emitted[`k3-${it}`] = "last words";
      await sched.run(() => Object.values(views).every(v => v && v.client.last === r.logs.get(grp).head), 400_000);

      const answerId = (/** @type {string} */ m) => Object.keys(views.bob.state.text).find(k => k.includes(m.slice(0, 1)) && k.endsWith(m.slice(2))) || m;
      void answerId;
      // message ids in the group are the asker's answer ids, so match by the text emitted
      const byText = (/** @type {Record<string, string>} */ got) => Object.values(got).sort();
      const all = Object.values(emitted).sort();
      assert.deepEqual(byText(views.bob.state.text), all, `seed ${it}: bob has every reply exactly`);
      assert.deepEqual(byText(views.carol.state.text), all, `seed ${it}: carol has every reply exactly`);
      const entitled = Object.entries(emitted).filter(([m]) => m === `k3-${it}` || openedAfterJoin[m]).map(([, v]) => v).sort();
      if (entitled.length < all.length) shut++; else whole++;
      assert.deepEqual(byText(views.ada.state.text), entitled, `seed ${it}: ada has exactly the replies opened after she joined (join at step ${joinAt} of ${steps.length}), whole, and nothing of the others`);
      assert.ok(!views.ada.state.nonText.some((/** @type {string} */ m) => m === `q1-${it}` || m === `q2-${it}`), `seed ${it}: nothing said before she joined`);
      assert.ok(views.ada.state.nonText.includes(`q3-${it}`), `seed ${it}: what is said after she joined`);
      for (const [n, v] of Object.entries(views)) {
        for (let i = 1; i < v.state.seen.length; i++) assert.ok(v.state.seen[i] > v.state.seen[i - 1], `seed ${it}: ${n}'s cursors in order and once`);
        assert.equal(v.client.last, r.logs.get(grp).head, `seed ${it}: ${n} caught up`);
        v.client.close();
      }
      // replay equals live: a fresh connection from 0 delivers what the live one held
      for (const p of ["bob", "carol", "ada"]) {
        const fresh = r.watch(grp, p), live = /** @type {any} */ (views)[p].state;
        assert.deepEqual(byText(textsOf(fresh.frames)), byText(live.text), `seed ${it}: ${p}'s replay equals what they received live`);
        fresh.close();
      }
    }
    assert.ok(shut >= 20 && whole >= 1, `the join landed mid-stream often enough to mean something (${shut} iterations kept replies from her, ${whole} did not)`);
  });
}

// ---- task Q: everything an assistant puts into a room goes through the reply handle ----------------------------------

/** The frames an assistant wrote into a room, in order, as [type, rid?, message?]. @param {any[]} frames */
const shape = frames => frames.filter(f => f.author === "assistant:kit").map(f => [f.type.replace("chat.", ""), f.data.rid || null, f.data.state || f.data.text || f.data.note || null]);

test("a reasoning-only turn in a two-person room writes nothing to it (no frame, no handle, no kernel message); thinking that goes with a reply is written through the handle, stamped, to the people entitled at its version", async t => {
  const r = rig(t, PORTS[0]);
  r.fk.create("q1", ["bob", "ada", "dan"], ["kit"]);
  const bob = r.watch("q1", "bob"), ada = r.watch("q1", "ada"), dan = r.watch("q1", "dan");
  const base = bob.frames.length;
  await r.send("q1", "bob", "m1", "think about it", ["assistant:kit"]);
  const kit = r.threadOf("q1", "assistant:kit");
  const before = r.fk.appended.length;
  r.ev(kit, "thread.status", { status: "working", turn: "t1" });
  r.ev(kit, "thread.thinking", { message: "mr", delta: "weighing the fee " });
  r.ev(kit, "thread.thinking", { message: "mr", delta: "and the date" });
  r.ev(kit, "thread.thinking", { message: "mr", done: true });
  r.ev(kit, "thread.status", { status: "idle", turn: "t1" });
  await r.groups.idle();
  for (const v of [bob, ada, dan]) assert.deepEqual(shape(v.frames), [], "no frame by the assistant, not even a state word");
  assert.equal(r.fk.replies.length, 0, "no handle was opened");
  assert.equal(r.fk.appended.length, before, "and the kernel took no message");
  assert.ok(!JSON.stringify(bob.frames.slice(base)).includes("weighing"), "the thinking is nowhere in what a viewer received");
  const buffered = /** @type {any} */ (r.groups.member("q1", "assistant:kit")).buf;
  assert.equal(buffered.size, 0, "and nothing is left waiting");
  // thinking that goes with a reply
  r.ev(kit, "thread.thinking", { message: "m2", delta: "weighing " });
  r.say(kit, "m2", { delta: "The fee is set." });
  await r.groups.idle();
  r.fk.change("q1", { remove: ["dan"] }); // leaves while the reply streams
  r.say(kit, "m2", { delta: " Done." });
  r.say(kit, "m2", { done: true });
  await r.groups.idle();
  assert.equal(r.fk.replies.length, 1);
  assert.deepEqual(r.fk.replies[0].deltas, ["weighing ", "The fee is set.", " Done."], "the thinking reached the room only by being written to the handle, first");
  const got = shape(bob.frames);
  const rid = got[0][1];
  assert.ok(rid);
  assert.deepEqual(got, [["text-delta", rid, "weighing "], ["text-delta", rid, "The fee is set."], ["text-delta", rid, " Done."], ["text-done", rid, null]]);
  assert.ok(bob.frames.filter(f => f.data && f.data.reasoning).every(f => f.data.rid === rid && f.data.ver === 1), "stamped with the room's version at the handle's open");
  assert.deepEqual(shape(ada.frames), got, "ada, in the room at that version, has the same");
  assert.deepEqual(shape(dan.frames), [["text-delta", rid, "weighing "], ["text-delta", rid, "The fee is set."]], "dan left mid-reply: what he had stays, nothing after the leave reaches him");
  r.fk.change("q1", { add: ["eve"] });
  await r.call("q1", "eve");
  const eve = r.watch("q1", "eve");
  assert.ok(!eve.frames.some(f => f.data && f.data.rid), "someone who joins afterwards never receives any of it");
});

test("a field value in what an assistant thinks, runs or says is dropped in a room of more than one person, whichever kind of frame carries it", async t => {
  const r = rig(t, PORTS[0]);
  r.fk.create("q2", ["bob", "ada"], ["kit"]);
  const ada = r.watch("q2", "ada");
  await r.send("q2", "bob", "m1", "go", ["assistant:kit"]);
  const kitM = /** @type {any} */ (r.groups.member("q2", "assistant:kit"));
  const FEE = { block: "field", label: "Fee", kind: "money", value: "4200" };
  kitM.ad = { event: () => [
    { kind: "text-delta", data: { message: "mr", text: "the fee is 4200", reasoning: true, ...FEE } },
    { kind: "tool-finished", data: { tool_id: "c1", ok: true, result: FEE } },
    { kind: "tool-progress", data: { tool_id: "c1", text: "ok" } },
  ] };
  r.say(r.threadOf("q2", "assistant:kit"), "x", { delta: "x" });
  await r.groups.idle();
  assert.ok(!JSON.stringify(ada.frames).includes("4200"));
  assert.ok(!JSON.stringify(r.fk.replies).includes("4200"), "and it never reached the handle");
  assert.ok(JSON.stringify(ada.frames).includes("progress") || ada.frames.some(f => f.type === "chat.tool-progress"), "the rest of the turn is shown");
});

test("no frame of a kernel group chat reaches the log by any path but the reply handle (a content-free status aside)", async t => {
  /** @type {{ ev: string, rid?: string }[]} */ const seq = [];
  /** @type {any} */ let port0;
  const wrapPort = (/** @type {any} */ p) => { port0 = p; return { ...p, open: async (/** @type {any} */ o) => { const h = await p.open(o); return { ...h, write: async (/** @type {any} */ d) => { seq.push({ ev: "write", rid: h.id }); return h.write(d); }, close: async (/** @type {any} */ f) => { seq.push({ ev: "close", rid: h.id }); return h.close(f); } }; } }; };
  const r = rig(t, PORTS[0], undefined, { wrapPort });
  r.fk.create("q3", ["bob", "ada"], ["kit"]);
  const log = r.logs.get("q3");
  const real = log.append.bind(log);
  /** @type {any[]} */ const bypass = [];
  /** @type {any[]} */ const all = [];
  log.append = (/** @type {string} */ kind, /** @type {any} */ data, /** @type {any} */ o) => {
    if (o && typeof o.author === "string" && o.author.startsWith("assistant:")) {
      all.push(kind);
      const last = seq[seq.length - 1];
      const plainStatus = kind === "status" && !Object.keys(data).some(k => !["state", "turn", "stopping"].includes(k));
      // a step's closing summary is derived from tool frames that already went through the handle and holds only counts and plain words for what kind of step it was
      const stepCounts = kind === "step-summary" && !Object.keys(data).some(k => !["step", "count", "kinds", "summary", "ok"].includes(k));
      const viaHandle = last && data.rid === last.rid && (kind === "text-done" ? last.ev === "close" : last.ev === "write");
      if (!plainStatus && !stepCounts && !viaHandle) bypass.push({ kind, data });
    }
    return real(kind, data, o);
  };
  await r.send("q3", "bob", "m1", "run it", ["assistant:kit"]);
  const kit = r.threadOf("q3", "assistant:kit");
  r.ev(kit, "thread.status", { status: "working", turn: "t1" });
  r.ev(kit, "thread.thinking", { message: "m1a", delta: "hm" });
  r.ev(kit, "thread.tool", { call: "c1", tool: "Bash", input: { command: "ls" }, text: "listing" });
  r.ev(kit, "thread.tool", { call: "c1", tool: "Bash", input: { command: "ls" }, phase: "done", output: "a\nb" });
  r.ev(kit, "thread.tool", { call: "c2", tool: "Edit", input: { file_path: "/tmp/x", old_string: "a", new_string: "b" }, phase: "done", output: "ok" });
  r.ev(kit, "ask.raised", { ask: "a1", kind: "permission", tool: "Bash", summary: "run it" });
  r.say(kit, "m1a", { delta: "Done " });
  r.say(kit, "m1a", { delta: "now." });
  r.say(kit, "m1a", { done: true });
  r.ev(kit, "thread.status", { status: "idle", turn: "t1" });
  await r.groups.idle();
  assert.deepEqual(bypass, [], "every assistant frame was written to a handle first");
  for (const k of ["text-delta", "tool-started", "tool-progress", "tool-finished", "ask", "file-changed", "text-done"]) assert.ok(all.includes(k), `the turn produced a ${k} frame`);
  assert.ok(port0 && r.fk.replies.length >= 2, "a reply handle for the message and one for the turn's own tools");
  assert.ok(r.fk.replies.every(x => x.final), "and both were closed");
});

test("the room says its blocks are public: a terminal, diff or files block in a room of more than one person carries the note, in a chat of one it never does", async t => {
  const r = rig(t, PORTS[0]);
  r.fk.create("n2", ["bob", "ada"], ["kit"]);
  r.fk.create("n1", ["bob"], ["kit"]);
  const ada = r.watch("n2", "ada"), solo = r.watch("n1", "bob");
  for (const grp of ["n2", "n1"]) {
    await r.send(grp, "bob", `m-${grp}`, "go", ["assistant:kit"]);
    const kit = r.threadOf(grp, "assistant:kit");
    r.ev(kit, "thread.tool", { call: "c1", tool: "Bash", input: { command: "ls" }, phase: "done", output: "a" });
    r.ev(kit, "thread.tool", { call: "c2", tool: "Glob", input: { pattern: "*.md" }, phase: "done", output: "a.md\nb.md" });
    r.ev(kit, "thread.tool", { call: "c3", tool: "Edit", input: { file_path: "/tmp/x", old_string: "a", new_string: "b" }, phase: "done", output: "ok" });
    await r.groups.idle();
  }
  const results = (/** @type {any[]} */ fs) => fs.filter(f => f.type === "chat.tool-finished").map(f => f.data.result);
  const room = results(ada.frames);
  assert.deepEqual(room.map(b => b.block), ["terminal", "files", "diff"]);
  assert.ok(room.every(b => b.note === "visible to everyone in this chat"), "every one carries the line, as the viewer receives it");
  assert.equal(room[1].detail, "2 found for *.md", "a files block's own note moved to detail");
  const one = results(solo.frames);
  assert.equal(one.length, 3);
  assert.ok(one.every(b => b.note !== "visible to everyone in this chat"), "a chat of one never says it");
});

test("no assistant session within the deadline: the pending reply is dropped, the room gets a plain failed status, nothing waits forever, a late session does not bring the reply back", async t => {
  /** @type {{ fn: () => void, ms: number, live: boolean }[]} */ const timers = [];
  const fake = { set: (/** @type {() => void} */ fn, /** @type {number} */ ms) => { const x = { fn, ms, live: true }; timers.push(x); return x; }, clear: (/** @type {any} */ x) => { x.live = false; } };
  const r = rig(t, PORTS[0], undefined, { timers: fake });
  r.fk.create("d1", ["bob", "ada"], ["kit"]);
  const ada = r.watch("d1", "ada");
  await r.send("d1", "bob", "m1", "go", ["assistant:kit"]);
  const kit = r.threadOf("d1", "assistant:kit");
  /** @type {any} */ (r.groups.member("d1", "assistant:kit")).tokens = new Map(); // what a restart forgets
  r.say(kit, "ma", { delta: "late words" });
  r.say(kit, "ma", { done: true });
  await new Promise(x => setTimeout(x, 40));
  const wait = timers.filter(x => x.live);
  assert.equal(wait.length, 1, "one wait is pending");
  assert.equal(wait[0].ms, 60_000, "60 seconds by default");
  assert.ok(!ada.frames.some(f => f.author === "assistant:kit"), "nothing is shown while it waits");
  wait[0].fn(); // the deadline passes
  await r.groups.idle(); // would hang if anything still waited
  const mine = shape(ada.frames);
  assert.deepEqual(mine, [["status", null, "failed"]]);
  assert.equal(ada.frames.find(f => f.type === "chat.status").data.note, "couldn't resume, ask again");
  assert.equal(r.fk.replies.length, 0, "no handle was opened");
  // the asker acts: a session arrives, late. The dropped reply stays dropped.
  await r.call("d1", "bob");
  r.say(kit, "ma", { delta: "more late words" });
  r.say(kit, "ma", { done: true });
  await r.groups.idle();
  assert.deepEqual(shape(ada.frames), mine);
  assert.equal(r.fk.replies.length, 0);
  // and a new question gets a new answer
  await r.send("d1", "bob", "m2", "again", ["assistant:kit"]);
  r.say(kit, "mb", { delta: "fresh" });
  r.say(kit, "mb", { done: true });
  await r.groups.idle();
  assert.ok(ada.frames.some(f => f.type === "chat.text-done" && f.author === "assistant:kit"));
});

test("the wait for an assistant session is stream.resumeWaitSeconds", async t => {
  /** @type {number[]} */ const ms = [];
  const fake = { set: (/** @type {() => void} */ _fn, /** @type {number} */ m) => { ms.push(m); return {}; }, clear: () => {} };
  const r = rig(t, PORTS[0], undefined, { timers: fake, config: { stream: { resumeWaitSeconds: 7 } } });
  r.fk.create("d2", ["bob"], ["kit"]);
  await r.send("d2", "bob", "m1", "go", ["assistant:kit"]);
  /** @type {any} */ (r.groups.member("d2", "assistant:kit")).tokens = new Map();
  r.say(r.threadOf("d2", "assistant:kit"), "ma", { delta: "x" });
  await new Promise(x => setTimeout(x, 40));
  assert.deepEqual(ms, [7000]);
});

test("a kernel whose chats cannot stream or gate a reply refuses (unavailable) and never falls back to the stand-in", async t => {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const chats = { ...fk.kernel.chats };
  delete chats.appendOpen;
  const logs = new Logs({ maxFrames: 1000, coalesce: false });
  const groups = createGroups({ ctx: { log: () => {}, kernel: { ...fk.kernel, chats }, call: async () => ({ data: {} }) }, logs, db });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  const port = /** @type {any} */ (groups).port;
  assert.ok(port, "the groups expose the port it chose");
  await assert.rejects(() => port.open({ grp: "g", token: "t" }), /** @param {any} e */ e => e.code === "unavailable");
  assert.equal(port.mayReceive("g", "alex", { kid: "x", ver: 0, cur: 1 }, {}), false);
});

test("ask another model on an answer: one short line from the person, and the other assistant is given the question, the answer and the earlier turns from the chat's own log", async t => {
  const r = rig(t, PORTS[0]);
  r.fk.create("c9", ["bob"], ["kit", "juno"]);
  await r.send("c9", "bob", "q0", "we are talking about the Harlow retainer", ["assistant:kit"]);
  const kit = r.threadOf("c9", "assistant:kit");
  r.say(kit, "m0", { delta: "Understood." }); r.say(kit, "m0", { done: true });
  await r.send("c9", "bob", "q1", "what is the fee for the estate plan?", ["assistant:kit"]);
  r.say(kit, "m1", { delta: "The fee is $4,200 flat, " }); r.say(kit, "m1", { delta: "paid in two parts." }); r.say(kit, "m1", { done: true });
  await r.groups.idle();
  const answerId = Object.keys(textsOf(r.logs.get("c9").read(0))).find(k => textsOf(r.logs.get("c9").read(0))[k].includes("$4,200"));
  assert.ok(answerId, "kit's answer is in the log");
  const before = r.started.length;
  const meta = await r.call("c9", "bob");
  const res = await r.groups.secondOpinion({ chat: "c9", message: answerId, to: "assistant:juno" }, meta);
  await r.groups.idle();
  assert.deepEqual(res.routed, ["assistant:juno"]);
  // what the chat shows is one short line from bob, a reply to kit's answer
  const um = r.logs.get("c9").read(0).filter(f => f.type === "chat.user-message").pop();
  assert.equal(um.data.text, "What does juno make of kit's answer?");
  assert.equal(um.data.reply_to, answerId);
  // what juno is given carries the question, the whole answer and the turn before
  const given = r.started.slice(before).find(s => /juno/.test(JSON.stringify(s)) || true);
  const prompt = String(given.prompt || given.text || JSON.stringify(given));
  assert.match(prompt, /The question \(.*\):\s*what is the fee for the estate plan\?/);
  assert.match(prompt, /kit's answer:\s*The fee is \$4,200 flat, paid in two parts\./);
  assert.match(prompt, /Earlier in this chat:[\s\S]*Harlow retainer/);
  assert.match(prompt, /Give your own answer to the question from scratch/);
  // nothing else: the same assistant, a non-assistant, an unknown answer and a person's message are refused
  await assert.rejects(() => r.groups.secondOpinion({ chat: "c9", message: answerId, to: "assistant:kit" }, meta), /different assistant/);
  await assert.rejects(() => r.groups.secondOpinion({ chat: "c9", message: answerId, to: "person:bob" }, meta), /not an assistant/);
  await assert.rejects(() => r.groups.secondOpinion({ chat: "c9", message: "nope", to: "assistant:juno" }, meta), /not in this chat/);
  await assert.rejects(() => r.groups.secondOpinion({ chat: "c9", message: "q1", to: "assistant:juno" }, meta), /assistant's answer/);
});
