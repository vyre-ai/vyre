// @ts-check
// Group chats end to end (ADR 0052): a real vyred with the fake claude. A group of two people and two
// assistants; a mention routes to one assistant, two people talking route to none, a fan-out to two
// assistants gives two answer blocks, keep marks one, a stop and start in the middle of a fan-out
// loses nothing and repeats nothing, a person's read marker reaches that person's other connection only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import fs from "node:fs";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { until, FAKE } from "../sessions/testing/boot.js";
import { connect, wsDuplex } from "./client.js";

/** The box's stream route on a local port, the way the daemon's upgrade handler serves it. */
async function serve(t, w) {
  /** @type {Set<import("node:net").Socket>} */ const sockets = new Set();
  const s = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  s.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", "http://vyred");
    const m = /^\/v1\/streams\/([a-z-]+)\/([a-z-]+)$/.exec(url.pathname);
    const u = m && w.d.registry.upgrades.get(`${m[1]}/${m[2]}`);
    if (!u) { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    u.handler(req, socket, head, { caller: "deck", url });
  });
  await new Promise(r => s.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {any} */ (s.address()).port;
  t.after(() => { for (const k of sockets) k.destroy(); s.closeAllConnections(); s.close(); });
  return { port, kill: () => { for (const k of sockets) k.destroy(); }, count: () => sockets.size };
}

/** A resumable client over the box: a fresh ticket per attempt, from its own cursor. */
function client(t, w, port, session, person) {
  /** @type {any[]} */ const frames = [];
  const c = connect({
    open: async ({ from }) => {
      // open as a person in the chat: the stream is read by its participants only
      const o = (await w.tool("stream.open", { session, from, ...(person ? { as: person } : {}) }, "deck")).data;
      return wsDuplex(`ws://127.0.0.1:${port}${o.path}`);
    },
    onFrame: f => frames.push(f),
    backoff: { base: 5, cap: 40 },
  });
  t.after(() => c.close());
  return { c, frames };
}

/** A vyred over a temp home with the fake claude, restartable, with the work folder allowed to the files guard (term opens there). */
async function own(t) {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false }, files: { roots: [work] }, term: { shell: "/bin/sh" } }));
  daemon = await start({ root, presence: present, log: () => {} });
  const tool = (name, input, caller = "cli") => call(name, input, { root, caller, timeout: 20_000 });
  const finished = id => until(async () => (await tool("threads.get", { thread: id, limit: 500 })).data.events.some(e => e.type === "thread.finished"), "the turn to finish");
  return { root, work, tool, finished, get d() { return daemon; }, restart: async () => { await daemon.stop(); daemon = await start({ root, presence: present, log: () => {} }); } };
}


const ALEX = "person:alex", CHRIS = "person:chris", KIT = "assistant:kit", JUNO = "assistant:juno";
const GROUP = "grp-harlow";

/** What a group shows, from its frames: answers by message id, with their author and who they act for. */
function answers(frames) {
  const m = new Map();
  for (const f of frames) {
    if (f.type !== "session.text-delta" || f.data.reasoning || !f.author) continue;
    const a = m.get(f.data.message) || { author: f.author, acts_for: f.acts_for, text: "" };
    a.text += f.data.text; m.set(f.data.message, a);
  }
  return m;
}
const done = frames => new Set(frames.filter(f => f.type === "session.text-done").map(f => f.data.message));

async function world(t) {
  const w = await own(t);
  const { port, kill } = await serve(t, w);
  const as = (person) => (tool, input) => w.tool(tool, { session: GROUP, ...input, as: person }, "deck");
  const view = client(t, w, port, GROUP, ALEX);
  const say = (person, text, extra = {}) => as(person)("stream.send", { text, ...extra });
  return { w, port, view, as, say, kill };
}
const members = (w) => ({ assistants: [{ id: KIT, cwd: w.work }, { id: JUNO, cwd: w.work }], people: [CHRIS], default: KIT });

test("group: a mention routes to one assistant; its reply is authored by it and acts for the asker", async t => {
  const { w, view, say } = await world(t);
  const r = (await say(ALEX, "@juno what is the rye price", members(w))).data;
  assert.deepEqual(r.routed, [JUNO]);
  assert.equal(r.group, undefined, "one answer is not a fan-out");
  await until(() => done(view.frames).has(r.answers[0].message), "juno's reply", 15000);
  const a = answers(view.frames);
  assert.equal(a.size, 1, "kit stayed quiet");
  const mine = a.get(r.answers[0].message);
  assert.equal(mine.author, JUNO);
  assert.equal(mine.acts_for, ALEX);
  assert.match(mine.text, /rye price/);
  const first = view.frames.find(f => f.type === "session.user-message");
  assert.equal(first.author, ALEX);
  assert.ok(view.frames.some(f => f.type === "session.mention" && f.data.who.includes(JUNO)));
  assert.deepEqual(view.frames.map(f => f.cur), view.frames.map((_, i) => i + 1));
});

test("group: two people talking route to no assistant; naming an assistant brings it in", async t => {
  const { w, view, say } = await world(t);
  const hello = (await say(ALEX, "chris, lunch at noon?", { ...members(w) })).data;
  assert.deepEqual(hello.routed, [], "alex to chris, nobody else is asked");
  const reply = (await say(CHRIS, "yes, the bakery?")).data;
  assert.deepEqual(reply.routed, []);
  const then = (await say(ALEX, "@kit book it")).data;
  assert.deepEqual(then.routed, [KIT]);
  await until(() => done(view.frames).has(then.answers[0].message), "kit's reply", 15000);
  assert.equal(answers(view.frames).size, 1);
  assert.equal([...answers(view.frames).values()][0].author, KIT);
});

test("group: a fan-out to two assistants returns two answer blocks, and keep marks one", async t => {
  const { w, view, say, as } = await world(t);
  const r = (await say(ALEX, "compare the bakery menus", { ...members(w), to: [KIT, JUNO] })).data;
  assert.equal(r.answers.length, 2);
  assert.ok(r.group);
  await until(() => view.frames.some(f => f.type === "session.fanout"), "the fan-out frame");
  const fo = view.frames.find(f => f.type === "session.fanout");
  assert.deepEqual(fo.data.members.map(m => m.who), [KIT, JUNO]);
  await until(() => r.answers.every(a => done(view.frames).has(a.message)), "both answers", 20000);
  const a = answers(view.frames);
  assert.deepEqual([...a.keys()].sort(), r.answers.map(x => x.message).sort());
  assert.deepEqual(r.answers.map(x => a.get(x.message).author), [KIT, JUNO]);
  for (const x of r.answers) { assert.equal(a.get(x.message).acts_for, ALEX); assert.match(a.get(x.message).text, /bakery menus/); }
  const kept = (await as(ALEX)("stream.keep", { group: r.group, keep: r.answers[1].message })).data;
  assert.equal(kept.keep, r.answers[1].message);
  await until(() => view.frames.some(f => f.type === "session.fanout-keep"), "the keep frame");
  assert.equal(view.frames.find(f => f.type === "session.fanout-keep").data.keep, r.answers[1].message);
  const bad = await as(ALEX)("stream.keep", { group: r.group, keep: "nope" });
  assert.equal(bad.error.code, "bad_input");
  // react and pin go through as the caller
  await as(CHRIS)("stream.react", { message: r.answers[0].message, emoji: "👍" });
  await as(CHRIS)("stream.pin", { message: r.answers[0].message });
  await until(() => view.frames.some(f => f.type === "session.pin"), "the pin");
  const re = view.frames.find(f => f.type === "session.reaction");
  assert.deepEqual([re.author, re.data.on], [CHRIS, true]);
});

test("group: a stop and start in the middle of a fan-out loses nothing and repeats nothing", async t => {
  const { w, view, say, port } = await world(t);
  // juno's delivery waits (a test hold): the stop lands with kit answered and juno's words only in the outbox.
  process.env.VYRE_STREAM_TEST_HOLD = JUNO;
  t.after(() => { delete process.env.VYRE_STREAM_TEST_HOLD; });
  const r = (await say(ALEX, "list the pastries", { ...members(w), to: [KIT, JUNO] })).data;
  const [kit, juno] = r.answers;
  await until(() => done(view.frames).has(kit.message), "kit's reply", 15000);
  assert.ok(!done(view.frames).has(juno.message), "juno has not been handed the words");
  const kitText = answers(view.frames).get(kit.message).text;
  const seen = view.frames.length;
  view.c.close();
  delete process.env.VYRE_STREAM_TEST_HOLD;
  await w.restart();
  const { port: p2 } = await serve(t, w);
  const again = client(t, w, p2, GROUP, ALEX);
  await until(() => done(again.frames).has(juno.message), "juno's reply after the restart", 20000);
  const a = answers(again.frames);
  assert.equal(a.size, 2, "two answers, none extra");
  assert.equal(a.get(kit.message).text, kitText, "kit's words are not repeated");
  assert.match(a.get(juno.message).text, /list the pastries/);
  assert.equal(a.get(juno.message).text.match(/list the pastries/g).length, 1, "juno was handed the words once");
  assert.ok(seen > 0);
  let next = 1;
  for (const f of again.frames) { assert.equal(f.cur - (f.span || 1) + 1, next, "gapless"); next = f.cur + 1; }
  // saying it again with the same message id changes nothing
  const dup = (await w.tool("stream.send", { session: GROUP, text: "list the pastries", message: r.message, as: ALEX }, "deck")).data;
  assert.equal(dup.duplicate, true);
  await w.tool("stream.send", { session: GROUP, text: "ping", as: CHRIS, to: [KIT] }, "deck");
  assert.equal(answers(again.frames).size >= 2, true);
  void port;
});

test("group: a read marker reaches the same person's other connection and nobody else's", async t => {
  const { w, port, as } = await world(t);
  // the chat exists, with alex and chris in it, before anyone opens it: only its participants may
  await as(ALEX)("stream.send", { text: "hi chris", people: [CHRIS] });
  const open = async person => {
    const frames = []; let live = false;
    const c = connect({ onState: st => { if (st === "live") live = true; }, open: async ({ from }) => { const o = (await w.tool("stream.open", { session: GROUP, from, as: person }, "deck")).data; return wsDuplex(`ws://127.0.0.1:${port}${o.path}`); }, onFrame: f => frames.push(f), backoff: { base: 5, cap: 40 } });
    t.after(() => c.close());
    await until(() => live, "connected");
    return frames;
  };
  const phone = await open(ALEX), laptop = await open(ALEX), chris = await open(CHRIS);
  const r = (await as(ALEX)("stream.mark-read", { upto: 7 })).data;
  assert.deepEqual([r.upto, r.moved], [7, true]);
  await until(() => phone.some(f => f.type === "session.read-marker") && laptop.some(f => f.type === "session.read-marker"), "both of alex's connections");
  assert.equal(laptop.find(f => f.type === "session.read-marker").data.upto, 7);
  assert.equal(chris.some(f => f.type === "session.read-marker"), false, "chris never hears alex's marker");
  assert.equal((await as(ALEX)("stream.mark-read", { upto: 3 })).data.moved, false, "a marker only moves forward");
});
