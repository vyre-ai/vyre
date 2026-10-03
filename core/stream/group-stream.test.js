// @ts-check
// Task O: a group reply STREAMS and belongs to the room it was opened for (chat 0.3; ruling in team/0.3/DESIGN-chat.md "How the kernel holds a chat").
// The first delta opens the reply through the reply port, which stamps it with the chat's membership version; each delta goes, per viewer, only to
// people who were in the chat at that version; someone who joins mid-reply gets no frame of it and sees the chat from their own join; someone who leaves stops
// receiving. Run against both ports: the in-memory one that follows the ruling for kernel-2's chats.appendOpen (fake-reply-port.js) and the stand-in the stream
// uses until that lands (it stamps with the log's cursor and reads the kernel's list at open).
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
function rig(t, which, now = () => Date.now()) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  let n = 0;
  /** @type {any[]} */ const started = [];
  const ctx = {
    log: () => {}, kernel: fk.kernel,
    call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
      if (tool === "threads.start") { const id = `thr_${++n}`; started.push({ id, ...i }); return { data: { id } }; }
      if (tool === "threads.get") return { data: { events: [] } };
      return { data: {} };
    },
  };
  const groups = createGroups({ ctx, logs, db, now, ...(which === PORTS[0] ? { replyPort: fk.port } : {}) });
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
    const r = await groups.send({ session: grp, text, message, to, cwd: "/tmp" }, meta);
    await groups.idle();
    return r;
  };
  const threadOf = (/** @type {string} */ grp, /** @type {string} */ bot) => String(/** @type {any} */ (groups.member(grp, bot)).thread);
  /** One thing a thread says, the way the switchboard emits it. */
  const say = (/** @type {string} */ thread, /** @type {string} */ message, /** @type {{ delta?: string, done?: boolean, kind?: string }} */ p) => groups.onEvent({ id: ++eid, type: p.kind || "thread.text", thread, payload: { message, block: 0, ...(p.delta !== undefined ? { delta: p.delta } : {}), ...(p.done ? { done: true } : {}) } });
  /** What a person's connection receives (direct serve, no transport). @param {string} grp @param {string} who @param {number} [from] */
  const watch = (grp, who, from = 0) => {
    /** @type {any[]} */ const frames = [];
    /** @type {(() => void)[]} */ const cs = [];
    const viewer = { id: `person:${who}`, roles: /** @type {string[]} */ ([]), ...groups.viewerFor(grp, `person:${who}`) };
    const s = serve(logs.get(grp), { send: f => frames.push(f), onClose: cb => cs.push(cb) }, { from, viewer });
    return { frames, close: () => s.close(), viewer };
  };
  return { fk, logs, groups, call, send, say, threadOf, watch, started };
}
/** The text a viewer received per message id, and what else it saw of a message (any frame naming it). @param {any[]} frames */
const textsOf = frames => {
  /** @type {Record<string, string>} */ const out = {};
  for (const f of frames) if (f.type === "session.text-delta" && !f.data.reasoning) out[f.data.message] = (out[f.data.message] || "") + f.data.text;
  return out;
};
const nonHidden = (/** @type {any[]} */ frames) => frames.filter(f => f.type !== "session.hidden" && f.cur > 0);

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
    assert.ok(bob.frames.filter(f => f.type === "session.text-delta").length >= 3, "it streamed delta by delta, not as one held message");
    const seen = JSON.stringify(dave.frames);
    assert.ok(!seen.includes("SECRET"), "dave gets nothing of the reply that streamed while he joined, not even the later deltas");
    assert.ok(!seen.includes("what is the fee"), "and nothing said before he joined");
    const mine = nonHidden(dave.frames);
    assert.ok(mine.some(f => f.type === "session.participant-joined" && f.data.who === "person:dave" && !f.data.quiet), "his own join is the marker");
    assert.ok(mine.filter(f => f.type === "session.participant-joined" && f.data.who !== "person:dave").every(f => f.data.quiet), "who was there before him is roster only");
    const tail = Object.values(textsOf(dave.frames));
    assert.deepEqual(tail, ["Second reply."], "he sees the next message in full");
    assert.ok(mine.some(f => f.type === "session.user-message" && f.data.text === "and the retainer?"));
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
    assert.ok(!carol.frames.some(f => f.type === "session.text-done"));
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
  assert.ok(types.includes("session.text-cut"), "taken back mid-reply: the people who had it see it cut");
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
          onFrame: f => { state.seen.push(f.cur); if (f.type === "session.text-delta" && !f.data.reasoning) state.text[f.data.message] = (state.text[f.data.message] || "") + f.data.text; else if (f.type === "session.user-message") state.nonText.push(f.data.message); },
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
