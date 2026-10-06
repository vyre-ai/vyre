// @ts-check
// Chat 0.3 task B: steer, stop, edit and retry, branch. End to end on a real vyred in a temp home
// with the fake claude (testing/fake-claude.js), the way a surface calls the tools.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import * as config from "../config/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, boot, FAKE } from "../sessions/testing/boot.js";
import { reduce, toUserMessage } from "../../lib/queue-state.js";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "runner.js");

/** An SSE client on vyred's socket: every event with the time it arrived here. */
function sse(root) {
  const got = [];
  let raw = "";
  const req = http.request({ socketPath: config.paths(root).socket, path: "/v1/events/stream?type=*" }, res => {
    res.setEncoding("utf8");
    res.on("data", c => {
      raw += c;
      let i;
      while ((i = raw.indexOf("\n\n")) >= 0) {
        const frame = raw.slice(0, i); raw = raw.slice(i + 2);
        const data = frame.split("\n").find(l => l.startsWith("data: "));
        if (data) got.push({ ...JSON.parse(data.slice(6)), seen: Date.now() });
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return { got, close: () => req.destroy() };
}

/** A vyred that can be stopped and started again over the same home (a restart mid-queue). */
async function restartable(t) {
  let daemon = null;
  const root = tempHome(t, { stop: () => daemon && daemon.stop() });
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false } }));
  daemon = await start({ root, presence: present, log: () => {} });
  asOwner(daemon, root); // calls from cli/deck arrive as the owner's device, as on the real socket (chat gate)
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  // through the registry as the owner's device (asOwner): over ssh the socket's "cli" is no person (its ancestry is not measured), and the chat gate refuses it
  const tool = (name, input, caller = "cli") => daemon.registry.call(name, input, caller);
  return { root, work, tool, get d() { return daemon; }, restart: async () => { await daemon.stop(); daemon = await start({ root, presence: present, log: () => {} }); asOwner(daemon, root); return daemon; } };
}

const ofType = (events, thread, type) => events.filter(e => e.thread === thread && e.type === type);
const said = events => events.filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => e.payload.text);

// Open the Edit ask of the "demo" turn: the turn is busy and blocked, so anything sent now steers or queues.
async function busyDemo(w) {
  const id = (await w.tool("threads.start", { cwd: w.work, prompt: "demo", surface: "deck" })).data.id;
  const edit = await until(async () => (await w.tool("threads.asks", { thread: id })).data.find(a => a.tool === "Edit"), "the Edit ask");
  return { id, edit };
}

test("steer: queued while the turn works, picked-up at the next step with its words, time and step; the stream data follows", async t => {
  const w = await boot(t);
  const { id, edit } = await busyDemo(w);
  const before = Date.now();
  const steer = (await w.tool("threads.send", { thread: id, text: "use the rye price too", surface: "deck" }, "deck")).data;
  assert.equal(steer.steered, true);
  const queued = (await w.tool("threads.send", { thread: id, text: "then check the hours", surface: "deck", mode: "queue" }, "deck")).data;
  assert.equal(queued.queued, true);
  let log = (await w.tool("threads.get", { thread: id, since: 0 })).data.events;
  const sent = log.find(e => e.type === "thread.sent" && e.payload.via === "steer");
  assert.equal(sent.payload.uuid, steer.uuid);
  assert.ok(sent.payload.queued_at >= before && Number.isInteger(sent.payload.step), "the steer says when and at which step it was typed");
  const q = log.find(e => e.type === "thread.queued");
  assert.ok(q.payload.queued_at >= before && Number.isInteger(q.payload.step) && q.payload.uuid === queued.uuid && q.payload.text === "then check the hours");
  const now = reduce(log);
  assert.deepEqual([steer.uuid, queued.uuid].map(u => now.get(u)?.state), ["queued", "queued"], "both wait while the ask is open");
  assert.equal(log.some(e => e.type === "thread.steered"), false, "never taken in while the turn is blocked");
  assert.deepEqual(toUserMessage(sent), { message: steer.uuid, text: "use the rye price too", state: "queued", queued_at: sent.payload.queued_at, step: sent.payload.step });

  await w.tool("threads.answer", { ask: edit.id, decision: "allow", surface: "deck" });
  const bash = await until(async () => (await w.tool("threads.asks", { thread: id })).data.find(a => a.tool === "Bash"), "the Bash ask");
  await w.tool("threads.answer", { ask: bash.id, decision: "allow", surface: "deck" });
  await until(async () => said((await w.tool("threads.get", { thread: id, limit: 500 })).data.events).some(x => /echo: then check the hours/.test(x)), "the queued turn's reply");
  log = (await w.tool("threads.get", { thread: id, limit: 500 })).data.events;
  const taken = ofType(log.map(e => ({ ...e, thread: id })), id, "thread.steered")[0];
  assert.equal(taken.payload.uuid, steer.uuid);
  assert.equal(taken.payload.text, "use the rye price too");
  assert.equal(taken.payload.queued_at, sent.payload.queued_at, "the time it was typed travels to picked-up");
  assert.ok(taken.payload.step >= 1, "taken in after a tool call finished, never mid-tool");
  const states = reduce(log);
  assert.equal(states.get(steer.uuid)?.state, "picked-up");
  assert.equal(states.get(queued.uuid)?.state, "picked-up");
  assert.deepEqual((await w.tool("threads.queue", { thread: id }, "deck")).data.queued, []);
});

test("stop: thread.status says stopping within 100 ms, steered and queued words are kept, and the next resume picks both up", async t => {
  const w = await boot(t);
  const s = sse(w.root);
  t.after(() => s.close());
  const { id } = await busyDemo(w);
  const steer = (await w.tool("threads.send", { thread: id, text: "steer survives", surface: "deck" }, "deck")).data;
  const queued = (await w.tool("threads.send", { thread: id, text: "queue survives", surface: "deck", mode: "queue" }, "deck")).data;
  const t0 = Date.now();
  const stopping = w.tool("threads.stop", { thread: id });
  const flag = await until(() => s.got.find(e => e.thread === id && e.type === "thread.status" && e.payload.stopping === true), "the stopping status", 2000);
  // The status is emitted in the call's own tick, before the process is closed: on an idle machine it is
  // seen within 100 ms (measured 5 to 20 ms); the bound here is loose so a loaded shared box does not flake.
  assert.ok(flag.seen - t0 < 500, `stopping took ${flag.seen - t0} ms`);
  console.log(`# stopping status seen ${flag.seen - t0} ms after the call`);
  assert.equal((await stopping).data.stopped, true);
  const stoppedEv = await until(() => s.got.find(e => e.thread === id && e.type === "thread.stopped"), "thread.stopped");
  assert.ok(s.got.indexOf(flag) < s.got.indexOf(stoppedEv), "stopping is said before stopped");
  await until(async () => (await w.tool("threads.get", { thread: id })).data.thread.status === "stopped", "stopped");
  // Nothing was handed over by the stop, nothing cancelled: both still wait.
  assert.deepEqual((await w.tool("threads.queue", { thread: id }, "deck")).data.queued.map(r => r.uuid), [queued.uuid]);
  const log = (await w.tool("threads.get", { thread: id, limit: 500 })).data.events;
  assert.equal(log.some(e => e.type === "thread.unqueued"), false);
  assert.equal(reduce(log).get(steer.uuid)?.state, "queued");
  // The next message resumes the thread: the steered words first, then the queued ones.
  await w.tool("threads.send", { thread: id, text: "carry on", surface: "deck" }, "deck");
  await until(async () => said((await w.tool("threads.get", { thread: id, limit: 500 })).data.events).some(x => /queue survives/.test(x)), "the queued words answered");
  const after = (await w.tool("threads.get", { thread: id, limit: 500 })).data.events;
  assert.equal(reduce(after).get(steer.uuid)?.state, "picked-up");
  assert.equal(reduce(after).get(queued.uuid)?.state, "picked-up");
  assert.deepEqual((await w.tool("threads.queue", { thread: id }, "deck")).data.queued, []);
});

test("interrupt then stop on a thread with no turn: stop closes it, no stopping flag is faked, a second stop says not running", async t => {
  const w = await boot(t);
  const id = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data.id;
  await w.finished(id);
  assert.equal((await w.tool("threads.stop", { thread: id })).data.stopped, true);
  assert.equal((await w.tool("threads.stop", { thread: id })).data.stopped, false);
  assert.equal((await w.tool("threads.interrupt", { thread: id })).data.interrupted, false);
});

test("a restart mid-queue loses nothing: the queued and steered words are still there and run on the first message after it", async t => {
  const w = await restartable(t);
  const { id } = await busyDemo(w);
  const steer = (await w.tool("threads.send", { thread: id, text: "steer across restart", surface: "deck" }, "deck")).data;
  const queued = (await w.tool("threads.send", { thread: id, text: "queue across restart", surface: "deck", mode: "queue" }, "deck")).data;
  await w.restart();
  assert.equal((await w.tool("threads.get", { thread: id })).data.thread.status, "stopped");
  assert.deepEqual((await w.tool("threads.queue", { thread: id }, "deck")).data.queued.map(r => r.uuid), [queued.uuid], "the queue is on disk");
  await w.tool("threads.send", { thread: id, text: "back", surface: "deck" }, "deck");
  await until(async () => said((await w.tool("threads.get", { thread: id, limit: 500 })).data.events).some(x => /queue across restart/.test(x)), "the queued words answered after the restart");
  const log = (await w.tool("threads.get", { thread: id, limit: 500 })).data.events;
  assert.equal(reduce(log).get(steer.uuid)?.state, "picked-up");
  assert.equal(reduce(log).get(queued.uuid)?.state, "picked-up");
  assert.ok(said(log).some(x => /steer across restart/.test(x)), "the steered words reached Claude");
});

test("unqueue and edit still apply while queued, and a cancelled message is final", async t => {
  const w = await boot(t);
  const { id } = await busyDemo(w);
  const a = (await w.tool("threads.send", { thread: id, text: "keep", surface: "deck", mode: "queue" }, "deck")).data;
  const b = (await w.tool("threads.send", { thread: id, text: "drop", surface: "deck", mode: "queue" }, "deck")).data;
  assert.equal((await w.tool("threads.edit", { thread: id, queued: a.queued_id, text: "keep, edited" }, "deck")).data.edited, true);
  assert.deepEqual((await w.tool("threads.unqueue", { thread: id, queued: b.queued_id }, "deck")).data.unqueued, [b.queued_id]);
  const states = reduce((await w.tool("threads.get", { thread: id, limit: 500 })).data.events);
  assert.equal(states.get(a.uuid)?.state, "edited");
  assert.equal(states.get(a.uuid)?.text, "keep, edited");
  assert.equal(states.get(b.uuid)?.state, "cancelled");
});

/** A thread with three typed turns, and each turn's message uuid and the transcript. */
async function threeTurns(w) {
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "one", surface: "deck" })).data;
  await w.finished(th.id);
  for (const [n, text] of [[2, "two"], [3, "three"]]) { await w.tool("threads.send", { thread: th.id, text, surface: "deck" }); await w.finished(th.id, n); }
  const turns = (await w.events(th.id)).filter(e => e.type === "thread.turn").map(e => e.payload);
  const file = path.join(w.transcripts, w.work.replace(/[^A-Za-z0-9]/g, "-"), `${th.id}.jsonl`);
  const lines = () => fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  return { th, turns, lines };
}

test("edit-retry: back to before the message, the new words sent, one idempotent call; retry resends the same words", async t => {
  const w = await boot(t);
  const { th, turns, lines } = await threeTurns(w);
  const two = lines().find(l => l.type === "user" && l.uuid === turns[1].uuid);
  const call1 = () => w.d.registry.call("threads.edit-retry", { thread: th.id, message: turns[1].uuid, text: "two, shorter", surface: "deck" }, "deck", { idempotencyKey: "retry-key-1" });
  const r = (await call1()).data;
  assert.equal(r.retried, true);
  assert.equal(r.sent, true);
  assert.equal(r.text, "two, shorter");
  await w.finished(th.id, 4);
  const again = lines().find(l => l.type === "user" && l.message.content === "two, shorter");
  assert.equal(again.parentUuid, two.parentUuid, "the new message hangs where the old one did");
  assert.ok(w.launches().some(l => l.argv && l.argv.includes("--resume-session-at")));
  // The same key again: nothing rewinds, nothing is sent twice.
  const turnsBefore = (await w.events(th.id)).filter(e => e.type === "thread.turn").length;
  const rewindsBefore = (await w.events(th.id)).filter(e => e.type === "thread.rewound").length;
  assert.deepEqual((await call1()).data, r, "the same key gets the first answer back");
  assert.equal((await w.events(th.id)).filter(e => e.type === "thread.turn").length, turnsBefore);
  assert.equal((await w.events(th.id)).filter(e => e.type === "thread.rewound").length, rewindsBefore);
  assert.deepEqual(await w.said(th.id), ["echo: one", "echo: two", "echo: three", "echo: two, shorter"]);
  // retry: the last typed message, same words.
  const rt = (await w.d.registry.call("threads.retry", { thread: th.id, surface: "deck" }, "deck", { idempotencyKey: "retry-key-2" })).data;
  assert.equal(rt.text, "two, shorter");
  await w.finished(th.id, 5);
  assert.equal((await w.said(th.id)).at(-1), "echo: two, shorter");
  assert.equal(lines().filter(l => l.type === "user" && l.message.content === "two, shorter").length, 2);
});

test("edit-retry: the first message, an unknown one and a model caller are refused in plain words", async t => {
  const w = await boot(t);
  const { th, turns } = await threeTurns(w);
  assert.equal((await w.tool("threads.edit-retry", { thread: th.id, message: turns[0].uuid, text: "x" }, "deck")).error.code, "bad_input");
  assert.equal((await w.tool("threads.edit-retry", { thread: th.id, message: "no-such-uuid", text: "x" }, "deck")).error.code, "bad_input");
  assert.equal((await w.tool("threads.edit-retry", { thread: th.id, message: turns[1].uuid, text: "x" }, "mcp")).error.code, "denied");
  assert.equal((await w.tool("threads.retry", { thread: th.id }, "mcp")).error.code, "denied");
  assert.equal((await w.tool("threads.branch", { thread: th.id, at: turns[1].uuid }, "mcp")).error.code, "denied");
  assert.deepEqual(await w.said(th.id), ["echo: one", "echo: two", "echo: three"], "nothing was sent");
});

test("branch: a new thread from a message or a turn, named (branch), the original untouched; no at branches from the end", async t => {
  const w = await boot(t);
  const { th, turns } = await threeTurns(w);
  const name = (await w.tool("threads.get", { thread: th.id })).data.thread.name || th.id.slice(0, 8);
  const b = (await w.tool("threads.branch", { thread: th.id, at: turns[1].uuid, prompt: "two, branched", surface: "deck" }, "deck")).data;
  assert.ok(b.id && b.id !== th.id);
  const rec = (await w.tool("threads.get", { thread: b.id })).data.thread;
  assert.equal(rec.name, `${name} (branch)`);
  const argv = (await until(() => w.launches().find(l => l.argv && l.argv.includes("--fork-session") && l.argv.includes("--resume-session-at")), "the branch launch")).argv;
  assert.ok(argv.includes("--fork-session"));
  await w.finished(b.id);
  assert.deepEqual(await w.said(b.id), ["echo: two, branched"]);
  assert.deepEqual(await w.said(th.id), ["echo: one", "echo: two", "echo: three"], "the original never sees it");
  assert.equal((await w.events(b.id)).find(e => e.type === "thread.started").payload.forked_from, th.id);
  // By turn id (thread.turn's turn).
  const byTurn = (await w.tool("threads.branch", { thread: th.id, at: turns[2].turn }, "deck")).data;
  assert.equal((await w.tool("threads.get", { thread: byTurn.id })).data.thread.name, `${name} (branch)`);
  // From the live end.
  const end = (await w.tool("threads.branch", { thread: th.id }, "deck")).data;
  assert.ok(end.id);
  // Unknown points and the first message are said, not faked.
  assert.equal((await w.tool("threads.branch", { thread: th.id, at: "no-such-uuid" }, "deck")).error.code, "bad_input");
  assert.equal((await w.tool("threads.branch", { thread: th.id, at: `${th.id}:99` }, "deck")).error.code, "bad_input");
  assert.equal((await w.tool("threads.branch", { thread: th.id, at: turns[0].uuid }, "deck")).error.code, "bad_input");
});

test("branch and edit-retry: a provider that cannot fork or go back says unsupported, and changes nothing", async t => {
  const w = await boot(t, { modules: [{ name: "echo-provider", manifest: { does: { providers: ["echo"] } }, source: `
    import { argsFor, run } from ${JSON.stringify(RUNNER)};
    export default { async start(ctx) {
      ctx.provider("echo", { id: "echo", capabilities: { streaming: true }, run: o => run({ ...o, bin: ${JSON.stringify(FAKE)}, args: argsFor(o) }) });
      return { async stop() {} };
    } };` }] });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck", provider: "echo" })).data;
  await w.finished(th.id);
  for (const [tool, input] of [["threads.branch", { thread: th.id }], ["threads.branch", { thread: th.id, at: "x" }], ["threads.edit-retry", { thread: th.id, message: "x", text: "y" }], ["threads.retry", { thread: th.id }]]) {
    const r = await w.tool(tool, input, "deck");
    assert.equal(r.error && r.error.code, "unsupported", `${tool}: ${JSON.stringify(r)}`);
    assert.match(r.error.message, /can't .* yet: nothing was changed/);
  }
  assert.deepEqual(await w.said(th.id), ["echo: hello"]);
  assert.equal((await w.tool("threads.list", {})).data.length, 1, "no thread was made");
});

// ---- reviewer gate chat-03: C-5 (edit and retry check first, and are the author's) and the stop as a clean checkpoint ------------

test("C-5: edit-retry whose send would be refused (the keyboard is held elsewhere) rewinds nothing and says so first", async t => {
  const w = await boot(t);
  const { th, turns, lines } = await threeTurns(w);
  const before = lines().length;
  const held = (await w.tool("threads.lease", { thread: th.id, surface: `cli:${process.pid}` })).data;
  assert.ok(held, "another surface takes the keyboard");
  for (const [tool, input] of [["threads.edit-retry", { thread: th.id, message: turns[1].uuid, text: "two, shorter", surface: "deck" }], ["threads.retry", { thread: th.id, message: turns[1].uuid, surface: "deck" }]]) {
    const r = await w.d.registry.call(tool, input, "deck", { idempotencyKey: `k-${tool}` });
    assert.equal(r.error && r.error.code, "lease_held", `${tool}: ${JSON.stringify(r)}`);
    assert.match(r.error.message, /Nothing was changed/);
  }
  assert.equal((await w.events(th.id)).filter(e => e.type === "thread.rewound").length, 0, "nothing was rewound");
  assert.equal(lines().length, before, "the transcript is as it was");
  assert.deepEqual(await w.said(th.id), ["echo: one", "echo: two", "echo: three"]);
});

test("C-5: a message records its author, and only its author (or an admin) can edit and retry it", async t => {
  const w = await boot(t);
  const reg = w.d.registry;
  const as = (login) => (tool, input) => reg.call(tool, input, "deck", { ...(login ? { peer: { login, stableId: `n_${login}` } } : {}) });
  const th = (await w.tool("threads.start", { cwd: w.work, prompt: "one", surface: "deck" })).data;
  await w.finished(th.id);
  const sent = await as("carol@example.com")("threads.send", { thread: th.id, text: "carol says two", surface: "deck" });
  assert.ok(!sent.error, JSON.stringify(sent.error));
  await w.finished(th.id, 2);
  const ev = (await w.events(th.id)).find(e => e.type === "thread.sent" && e.payload.text === "carol says two");
  assert.equal(ev.payload.author, "person:carol@example.com", "the author is recorded on the message");
  const turn = (await w.events(th.id)).filter(e => e.type === "thread.turn").map(e => e.payload).find(p => p.text === "carol says two");
  const dave = await as("dave@example.com")("threads.edit-retry", { thread: th.id, message: turn.uuid, text: "dave rewrites", surface: "deck" });
  assert.equal(dave.error && dave.error.code, "denied", JSON.stringify(dave));
  assert.equal((await w.events(th.id)).filter(e => e.type === "thread.rewound").length, 0);
  const carol = await as("carol@example.com")("threads.edit-retry", { thread: th.id, message: turn.uuid, text: "carol says two, again", surface: "deck" });
  assert.ok(!carol.error && carol.data.retried, JSON.stringify(carol));
  await w.finished(th.id, 3);
  // an admin (the owner's own surface, no peer) may edit anyone's
  const t2 = (await w.events(th.id)).filter(e => e.type === "thread.turn").map(e => e.payload).find(p => p.text === "carol says two, again");
  const admin = await as(null)("threads.edit-retry", { thread: th.id, message: t2.uuid, text: "the owner's edit", surface: "deck" });
  assert.ok(!admin.error && admin.data.retried, JSON.stringify(admin));
});

test("stop is a clean checkpoint: stopped mid-tool, then a new message resumes the session with the transcript intact and no open ask", async t => {
  const w = await boot(t);
  const { id } = await busyDemo(w); // the turn is blocked on a tool's permission ask
  const file = path.join(w.transcripts, w.work.replace(/[^A-Za-z0-9]/g, "-"), `${id}.jsonl`);
  const read = () => fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
  const prior = read().map(l => l.uuid).filter(Boolean);
  assert.ok(prior.length >= 1);
  assert.equal((await w.tool("threads.stop", { thread: id })).data.stopped, true);
  await until(async () => (await w.tool("threads.get", { thread: id })).data.thread.status === "stopped", "stopped");
  assert.deepEqual((await w.tool("threads.asks", { thread: id })).data, [], "no ask is left hanging");
  const launches = w.launches().length;
  const r = (await w.tool("threads.send", { thread: id, text: "after the stop", surface: "deck" }, "deck")).data;
  assert.equal(r.sent, true);
  await until(async () => (await w.said(id)).some(x => /after the stop/.test(x)), "the reply after the stop");
  assert.ok(w.launches().length > launches, "the session was resumed");
  assert.ok(w.launches().at(-1).argv.includes("--resume") || w.launches().at(-1).argv.some(a => /resume/.test(a)), "resumed, not restarted");
  const now = read();
  assert.deepEqual(now.map(l => l.uuid).filter(Boolean).slice(0, prior.length), prior, "every earlier line is still there, in order");
  assert.ok(now.some(l => l.type === "user" && l.message && l.message.content === "after the stop"));
  const log = (await w.tool("threads.get", { thread: id, limit: 500 })).data.events;
  assert.ok(log.findIndex(e => e.type === "thread.stopped") < log.findIndex(e => e.type === "thread.sent" && e.payload.text === "after the stop"));
});
