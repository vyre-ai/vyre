// @ts-check
// The stream on the sessions' kernel-session seam (chat 0.3 task S): on the daemon path the assistant's kernel session is vyred's, and the stream only asks for calls on a thread's
// session (`ks.forThread(thread)`: beginTurn, appendOpen), never a token and never a session of its own for an assistant. These tests stand in for lib/kernel-session.js with the
// same shape over the in-memory chat of fake-reply-port.js: the seam opens the thread's session from the person's send (the test's threads.start and threads.send), and the stream asks.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../config/index.js";
import { open } from "../store/index.js";
import { tempHome } from "../../test/helpers.js";
import { Logs } from "./log.js";
import { createGroups } from "./group.js";
import { serve } from "./server.js";
import { createFakeKernel } from "./fake-reply-port.js";

/** @param {any} t @param {{ begin?: "ok" | "unsupported" | "refused", resumeWaitSeconds?: number }} [o] */
function rig(t, o = {}) {
  const p = config.ensure(tempHome(t));
  const db = open(p.db);
  const fk = createFakeKernel();
  const logs = new Logs({ maxFrames: 100000, coalesce: false });
  /** every call the stream made on a session, in order @type {string[]} */ const calls = [];
  /** session opens for an assistant that came from the STREAM (the fake kernel's own surfaces, as ctx.kernel hands them) @type {any[]} */ const streamOpens = [];
  /** thread -> the kernel token vyred holds @type {Map<string, string>} */ const held = new Map();
  /** what reopenPending was asked @type {any} */ const reopen = { args: null, settle: null };
  let ids = 0, n = 0;
  const handles = new Map();
  const chats = {
    ...fk.kernel.chats,
    /** @param {string} token @param {any} m */
    appendOpen: async (token, m) => {
      const grp = tokenChat.get(token);
      const h = await fk.port.open({ grp: String(grp), token, message: "m" });
      handles.set(h.id, { grp, ver: h.ver });
      void m;
      return h;
    },
    mayReceive: (/** @type {any} */ chain, /** @type {string} */ kid) => { const h = handles.get(kid); return Boolean(h && fk.port.mayReceive(h.grp, chain.person, { kid, ver: h.ver, cur: 0 }, chain)); },
  };
  /** @type {Map<string, string>} */ const tokenChat = new Map();
  const ks = {
    forThread: (/** @type {string} */ thread) => {
      const tok = () => { const x = held.get(thread); if (!x) throw Object.assign(new Error("no open kernel session"), { code: "no_session" }); return x; };
      return {
        beginTurn: async () => { const x = tok(); calls.push("beginTurn"); if (o.begin === "unsupported") throw Object.assign(new Error("not yet"), { code: "unsupported" }); if (o.begin === "refused") throw Object.assign(new Error("no"), { code: "not_found" }); return { ver: 1, token: x === "" }; },
        appendOpen: async (/** @type {any} */ m) => { const x = tok(); calls.push("appendOpen"); return chats.appendOpen(x, m); },
        append: async (/** @type {any} */ m) => { const x = tok(); calls.push("append"); return fk.kernel.chats.append(x, m); },
      };
    },
    reopenPending: (/** @type {any} */ a) => { reopen.args = a; return new Promise(res => { reopen.settle = res; }); },
  };
  const ctx = {
    log: () => {}, config: { stream: { resumeWaitSeconds: o.resumeWaitSeconds ?? 60 } },
    // what the stream is handed of the kernel: the person's own calls, and the delivery question. Opening a session for an assistant from here is what the seam replaces.
    kernel: { ...fk.kernel, chats, for: () => ({ surfaces: { open: async (/** @type {any} */ chain, /** @type {any} */ oo) => { if (oo && oo.agent) streamOpens.push(oo); return fk.kernel.for().surfaces.open(chain, oo); } } }) },
    call: async (/** @type {string} */ tool, /** @type {any} */ i) => {
      if (tool === "threads.start" || tool === "threads.send") {
        const id = tool === "threads.start" ? `thr_${++n}` : String(i.thread);
        // vyred opens the thread's session from the person's own send (here: bob, in the chat of the room it was sent in), and the kernel begins the turn as the session opens (lib/kernel-session.js open): once per send, never from the stream
        calls.push("beginTurn");
        if (o.begin === "refused") return { error: { code: "not_found", message: "no" } };
        if (!held.has(id)) { const chat = String(i.chat || "c1"); const s = await fk.kernel.for().surfaces.open({ person: "bob" }, { chat, agent: "kit" }); held.set(id, s.token); tokenChat.set(s.token, chat); }
        return { data: { id } };
      }
      if (tool === "threads.get") return { data: { events: [] } };
      return { data: {} };
    },
  };
  const groups = createGroups({ ctx, logs, db, ks: /** @type {any} */ (ks) });
  t.after(() => { groups.stop(); logs.close(); db.close(); });
  let eid = 0;
  const call = async (/** @type {string} */ grp, /** @type {string} */ who) => {
    const meta = {};
    const c = /** @type {any} */ (fk.chats.get(grp));
    await groups.mirror(grp, { people: c.people, assistants: c.assistants }, meta, `person:${who}`, { person: who });
    return meta;
  };
  const send = async (/** @type {string} */ grp, /** @type {string} */ who, /** @type {string} */ message, /** @type {string} */ text) => {
    const meta = await call(grp, who);
    const r = await groups.send({ session: grp, text, message, to: ["assistant:kit"], cwd: "/tmp" }, meta);
    await groups.idle();
    return r;
  };
  const kit = (/** @type {string} */ grp) => String(/** @type {any} */ (groups.member(grp, "assistant:kit")).thread);
  const say = (/** @type {string} */ thread, /** @type {string} */ message, /** @type {{ delta?: string, done?: boolean }} */ p) => groups.onEvent({ id: ++eid, type: "thread.text", thread, payload: { message, block: 0, ...(p.delta !== undefined ? { delta: p.delta } : {}), ...(p.done ? { done: true } : {}) } });
  const watch = (/** @type {string} */ grp, /** @type {string} */ who) => {
    /** @type {any[]} */ const frames = [];
    const viewer = { id: `person:${who}`, roles: /** @type {string[]} */ ([]), ...groups.viewerFor(grp, `person:${who}`, { person: who }) };
    const s = serve(logs.get(grp), { send: f => frames.push(f), onClose: () => {} }, { from: 0, viewer });
    return { frames, close: () => s.close() };
  };
  void ids;
  return { fk, groups, logs, call, send, kit, say, watch, calls, streamOpens, held, reopen, ctx };
}
const texts = (/** @type {any[]} */ frames) => frames.filter(f => f.type === "session.text-delta" && !f.data.reasoning).map(f => f.data.text).join("");

test("the stream opens no session of its own for an assistant: the reply opens through the seam, after the turn begins, and a mid-reply joiner never receives it", async t => {
  const r = rig(t);
  r.fk.create("c1", ["bob", "carol"], ["kit"]);
  const bob = (await r.call("c1", "bob"), r.watch("c1", "bob"));
  await r.send("c1", "bob", "q1", "what is the fee?");
  const kit = r.kit("c1");
  assert.ok(r.calls.includes("beginTurn") && !r.calls.includes("appendOpen"), "the turn began when the session opened; no reply is open yet");
  r.say(kit, "m1", { delta: "SECRET one " });
  await r.groups.idle();
  r.fk.change("c1", { add: ["dave"] });
  await r.call("c1", "dave");
  const dave = r.watch("c1", "dave");
  r.say(kit, "m1", { delta: "SECRET two" });
  r.say(kit, "m1", { done: true });
  await r.groups.idle();
  assert.equal(texts(bob.frames), "SECRET one SECRET two", "bob, who was there, got it streaming");
  assert.ok(!JSON.stringify(dave.frames).includes("SECRET"), "dave, who joined mid-reply, got none of it");
  assert.ok(r.calls.indexOf("beginTurn") < r.calls.indexOf("appendOpen"), "beginTurn came before the reply was opened");
  assert.deepEqual(r.streamOpens, [], "the stream opened no kernel session for the assistant");
});

test("beginTurn is once per turn and runs again for the next turn", async t => {
  const r = rig(t);
  r.fk.create("c1", ["bob"], ["kit"]);
  await r.send("c1", "bob", "q1", "one");
  r.say(r.kit("c1"), "m1", { delta: "a" }); r.say(r.kit("c1"), "m1", { done: true });
  await r.groups.idle();
  await r.send("c1", "bob", "q2", "two");
  r.say(r.kit("c1"), "m2", { delta: "b" }); r.say(r.kit("c1"), "m2", { done: true });
  await r.groups.idle();
  assert.equal(r.calls.filter(c => c === "beginTurn").length, 2);
  assert.equal(r.calls.filter(c => c === "appendOpen").length, 2);
});

test("a kernel with no turn-begin yet (unsupported) still opens the reply, before the first read, as before", async t => {
  const r = rig(t, { begin: "unsupported" });
  r.fk.create("c1", ["bob"], ["kit"]);
  const bob = (await r.call("c1", "bob"), r.watch("c1", "bob"));
  await r.send("c1", "bob", "q1", "hi");
  r.say(r.kit("c1"), "m1", { delta: "hello" }); r.say(r.kit("c1"), "m1", { done: true });
  await r.groups.idle();
  assert.equal(texts(bob.frames), "hello");
  assert.ok(r.calls.includes("appendOpen"));
});

test("any other beginTurn failure is a refused turn: nothing is shown and no reply is opened", async t => {
  const r = rig(t, { begin: "refused" });
  r.fk.create("c1", ["bob"], ["kit"]);
  const bob = (await r.call("c1", "bob"), r.watch("c1", "bob"));
  await r.send("c1", "bob", "q1", "hi");
  r.say(r.kit("c1"), "m1", { delta: "should not appear" }); r.say(r.kit("c1"), "m1", { done: true });
  await r.groups.idle();
  assert.ok(!r.calls.includes("appendOpen"), "no reply was opened");
  assert.ok(!JSON.stringify(bob.frames).includes("should not appear"));
  assert.equal(r.calls.filter(c => c === "beginTurn").length, 1, "the refusal stands for the turn; it is not retried per delta");
});

test("restart: the stream asks the seam to reopen the open turns within stream.resumeWaitSeconds", async t => {
  const r = rig(t, { resumeWaitSeconds: 7 });
  r.fk.create("c1", ["bob"], ["kit"]);
  void r.groups.start();
  await new Promise(x => setTimeout(x, 20));
  assert.equal(r.reopen.args.timeoutMs, 7000);
  assert.equal(typeof r.reopen.args.onGiveUp, "function");
});

test("restart: a turn the seam gives up shows 'couldn't resume, ask again' and its pending reply is dropped", async t => {
  const r = rig(t);
  r.fk.create("c1", ["bob"], ["kit"]);
  const bob = (await r.call("c1", "bob"), r.watch("c1", "bob"));
  await r.send("c1", "bob", "q1", "go");
  const kit = r.kit("c1");
  r.held.delete(kit); // the restart forgot the session
  void r.groups.start();
  await new Promise(x => setTimeout(x, 20));
  r.say(kit, "m1", { delta: "never shown" });
  await new Promise(x => setTimeout(x, 20)); // the reply waits for the reopening
  r.reopen.args.onGiveUp(kit, "timeout");
  r.reopen.settle({ resumed: [], gaveUp: [kit] });
  await new Promise(x => setTimeout(x, 20));
  await r.groups.idle();
  r.say(kit, "m1", { delta: "still not" }); r.say(kit, "m1", { done: true });
  await r.groups.idle();
  const seen = JSON.stringify(bob.frames);
  assert.ok(!seen.includes("never shown") && !seen.includes("still not"), "the dropped reply is never shown");
  assert.ok(bob.frames.some(f => f.type === "session.status" && f.data.state === "failed" && /couldn't resume/.test(String(f.data.note))), "the room is told once, without content");
  assert.equal(bob.frames.filter(f => f.type === "session.status" && f.data.state === "failed").length, 1);
});

test("restart: a turn the seam reopened streams as if nothing happened", async t => {
  const r = rig(t);
  r.fk.create("c1", ["bob"], ["kit"]);
  const bob = (await r.call("c1", "bob"), r.watch("c1", "bob"));
  await r.send("c1", "bob", "q1", "go");
  const kit = r.kit("c1");
  const token = /** @type {string} */ (r.held.get(kit));
  r.held.delete(kit);
  void r.groups.start();
  await new Promise(x => setTimeout(x, 20));
  r.say(kit, "m1", { delta: "after the restart" }); r.say(kit, "m1", { done: true });
  await new Promise(x => setTimeout(x, 20));
  r.held.set(kit, token); // reopened
  r.reopen.settle({ resumed: [kit], gaveUp: [] });
  await new Promise(x => setTimeout(x, 30));
  await r.groups.idle();
  assert.equal(texts(bob.frames), "after the restart");
});
