// @ts-check
// Vyre-owned sessions (ADR 0030), end to end - continued from sessions.test.js (split
// 2026-09-28: one file of ~80 real subprocess-spawning tests across both drivers sat right at
// the edge of the full suite's 90s file timeout under concurrency-4 contention; two files
// parallelize instead of raising the ceiling). Same fake `claude`
// (core/switchboard/testing/fake-claude.js), same shared boot()/until()/terminalSession()
// (testing/boot.js). The tests marked "sdk" need the pinned SDK installed somewhere
// (VYRE_SESSIONS_SDK_DIR, as on testbox) and are skipped without it.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { call } from "../daemon/client.js";
import { noSdk, until, boot, terminalSession } from "./testing/boot.js";
// A model caller (mcp) on a person's chat is refused by the chat gate before the tool's own check: it is told the thread is not there (not_found), never that it exists and is refused.

// ------------------------------------------------------------ on either driver

for (const driver of ["cli", "sdk"]) {
  const skip = driver === "sdk" ? noSdk : false;

  test(`${driver}: a session a terminal started, by an older Claude Code, is resumed through Vyre on the first message, once in the list`, { skip }, async t => {
    const w = await boot(t, { driver });
    const old = terminalSession(w.transcripts, w.work);
    const r = (await w.tool("threads.send", { thread: old.id, text: "carry on", surface: "deck" })).data;
    assert.deepEqual(r, { sent: true, thread: old.id });
    await w.finished(old.id);
    const rec = (await w.tool("threads.get", { thread: old.id })).data.thread;
    assert.deepEqual([rec.driver, rec.cwd], [driver, w.work], "resumed by Vyre, in the transcript's own folder");
    const argv = w.launches().at(-1).argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], old.id);
    assert.deepEqual(await w.said(old.id), ["echo: carry on"]);
    const lines = fs.readFileSync(old.file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.equal(lines[0].type, "summary", "the old lines are kept as they were");
    assert.ok(lines.some(l => l.type === "user" && l.message.content === "carry on"), "the new turn is in the same transcript");
    // One row per session, and the live text keys to the transcript's own message id.
    assert.equal((await w.tool("threads.list", {})).data.filter(x => x.id === old.id).length, 1);
    const live = (await w.events(old.id)).find(e => e.type === "thread.text" && e.payload.done).payload.message;
    assert.ok(lines.some(l => l.type === "assistant" && l.message.id === live), "live and history share the message id");
  });

  test(`${driver}: a session live in a terminal is queued, never typed into, and a fork carries on as a copy`, { skip }, async t => {
    const w = await boot(t, { driver });
    const busy = terminalSession(w.transcripts, w.work, { ageMs: 0 });
    const before = fs.readFileSync(busy.file, "utf8");
    const q = (await w.tool("threads.send", { thread: busy.id, text: "add the autumn specials", surface: "deck" })).data;
    assert.equal(q.queued, true);
    assert.equal(q.busy, "terminal");
    assert.ok(!w.launches().some(l => l.argv && l.argv.includes(busy.id)), "no second writer was started");
    const f = (await w.tool("threads.fork", { thread: busy.id, prompt: "from here", surface: "deck" })).data;
    assert.notEqual(f.id, busy.id);
    // .id is canonical; .thread is kept as an alias for one release (native-core's naming
    // footgun: threads.rewind's answer already echoed .thread, fork/launch silently did not).
    assert.equal(f.thread, f.id);
    await w.finished(f.id);
    const argv = w.launches().at(-1).argv;
    assert.equal(argv[argv.indexOf("--resume") + 1], busy.id);
    assert.ok(argv.includes("--fork-session"));
    assert.equal(argv[argv.indexOf("--session-id") + 1], f.id);
    assert.equal((await w.events(f.id)).find(e => e.type === "thread.started").payload.forked_from, busy.id);
    assert.deepEqual(await w.said(f.id), ["echo: from here"]);
    assert.equal(fs.readFileSync(busy.file, "utf8"), before, "the original transcript is untouched");
    const copy = fs.readFileSync(path.join(path.dirname(busy.file), `${f.id}.jsonl`), "utf8");
    assert.match(copy, /start the menu for Northwind Bakery/, "the fork starts with the conversation so far");
  });

  test(`${driver}: a turn's cost is its own, from Claude Code's running total`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "spend 0.5", surface: "deck" })).data;
    await w.finished(th.id);
    await w.tool("threads.send", { thread: th.id, text: "spend 0.35", surface: "deck" });
    await w.finished(th.id, 2);
    const done = (await w.events(th.id)).filter(e => e.type === "thread.finished").map(e => [e.payload.cost_usd, e.payload.total_cost_usd]);
    assert.deepEqual(done, [[0.5, 0.5], [0.35, 0.85]]);
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.cost_usd, 0.85);
  });

  test(`${driver}: a message sent while working steers the running turn at its next step`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test", surface: "deck" })).data;
    const ask = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    const r = (await w.tool("threads.send", { thread: th.id, text: "use pnpm instead", surface: "deck" })).data;
    assert.equal(r.steered, true);
    assert.equal(r.turn, `${th.id}:1`, "it joins the running turn");
    await w.tool("threads.answer", { ask: ask.id, decision: "allow", surface: "deck" });
    await w.finished(th.id);
    const ev = await w.events(th.id);
    assert.ok(ev.some(e => e.type === "thread.sent" && e.payload.via === "steer" && e.payload.uuid === r.uuid));
    const steered = ev.find(e => e.type === "thread.steered");
    assert.equal(steered && steered.payload.uuid, r.uuid, "Claude took it in at a step");
    assert.equal(steered.payload.step, 1, "after the one tool call it had finished");
    const raised = ev.find(e => e.type === "ask.raised");
    assert.equal(raised.payload.tool_use_id, ev.find(e => e.type === "thread.tool").payload.call, "the ask names its tool row");
    assert.match((await w.said(th.id)).at(-1), /took in: use pnpm instead/);
    assert.equal(ev.filter(e => e.type === "thread.turn").length, 1, "no turn of its own");
    assert.equal(ev.filter(e => e.type === "thread.finished").length, 1);
    // Every event of the turn says which turn; the state and usage are said.
    assert.ok(ev.filter(e => /^(thread\.(text|tool|finished|sent)|ask\.)/.test(e.type)).every(e => e.payload.turn === `${th.id}:1`));
    assert.deepEqual(ev.filter(e => e.type === "thread.state").map(e => e.payload.state), ["starting", "running", "waiting", "running", "idle"]);
    // thread.status: the same five changes, in the one canonical vocabulary a person reads
    // (lib/thread-status.js) - internal "waiting" (an ask is open) is "asking", "idle" is "waiting".
    assert.deepEqual(ev.filter(e => e.type === "thread.status").map(e => e.payload.status),
      ["starting", "working", "asking", "working", "waiting"]);
    assert.ok(ev.some(e => e.type === "thread.usage" && typeof e.payload.cost_usd === "number"));
    const text = ev.filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice);
    assert.ok(text.every(e => typeof e.payload.block === "number"), "done text carries its block");
    assert.ok(ev.filter(e => e.type === "thread.text").every(e => typeof e.payload.t === "number" && Math.abs(e.payload.t - e.at) < 5000), "text carries the server's time");
  });

  test(`${driver}: queued for after the turn: edited, taken back, sent now, or handed over as one turn`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test", surface: "deck" })).data;
    const ask = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    const a = (await w.tool("threads.send", { thread: th.id, text: "then the menu", surface: "deck", mode: "queue" })).data;
    assert.equal(a.queued, true);
    assert.match(a.note, /is working on something/);
    assert.doesNotMatch(a.note, /terminal/);
    const b = (await w.tool("threads.send", { thread: th.id, text: "and the prices", surface: "deck", mode: "queue" })).data;
    const c = (await w.tool("threads.send", { thread: th.id, text: "never mind this", surface: "deck", mode: "queue" })).data;
    assert.deepEqual((await w.tool("threads.edit", { thread: th.id, queued: b.queued_id, text: "and the autumn prices" })).data, { edited: true, queued: b.queued_id });
    assert.deepEqual((await w.tool("threads.unqueue", { thread: th.id, queued: c.queued_id })).data, { unqueued: [c.queued_id] });
    assert.equal((await w.tool("threads.unqueue", { thread: th.id, queued: c.queued_id }, "mcp")).error.code, "not_found", "a model never takes a person's words back");
    await w.tool("threads.answer", { ask: ask.id, decision: "allow", surface: "deck" });
    await w.finished(th.id, 2);
    const ev = await w.events(th.id);
    const handed = ev.filter(e => e.type === "thread.sent" && e.payload.via === "turn");
    assert.deepEqual(handed.map(e => e.payload.queued), [a.queued_id, b.queued_id], "one thread.sent per row, in order");
    const second = ev.filter(e => e.type === "thread.turn")[1];
    assert.ok(handed.every(e => e.id < second.id), "announced before the turn that answers them");
    assert.equal((await w.said(th.id)).at(-1), "echo: then the menu\n\nand the autumn prices");
    assert.ok(ev.some(e => e.type === "thread.unqueued" && e.payload.queued === c.queued_id));
    assert.equal((await w.tool("threads.unqueue", { thread: th.id, queued: a.queued_id })).data.unqueued.length, 0, "handed over words stay Claude's");

    // Send now: a queued row joins the running turn instead of waiting.
    await w.tool("threads.send", { thread: th.id, text: "bash npm run build", surface: "deck" });
    const ask2 = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the second ask");
    const d = (await w.tool("threads.send", { thread: th.id, text: "skip the lint", surface: "deck", mode: "queue" })).data;
    const now = (await w.tool("threads.send-now", { thread: th.id, queued: d.queued_id })).data;
    assert.equal(now.sent, true);
    await w.tool("threads.answer", { ask: ask2.id, decision: "allow", surface: "deck" });
    await w.finished(th.id, 3);
    assert.match((await w.said(th.id)).at(-1), /took in: skip the lint/);
    assert.ok((await w.events(th.id)).some(e => e.type === "thread.sent" && e.payload.via === "now" && e.payload.queued === d.queued_id));
  });

  test(`${driver}: a queued message keeps its images, and a steer a stop cut off comes back first on resume`, { skip }, async t => {
    const w = await boot(t, { driver });
    const png = { media_type: "image/png", data: Buffer.from("fake png of the Northwind menu").toString("base64") };
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test", surface: "deck" })).data;
    const ask = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    const q = (await w.tool("threads.send", { thread: th.id, text: "then look at this", surface: "deck", mode: "queue", images: [png] })).data;
    assert.equal(q.queued, true);
    assert.ok((await w.events(th.id)).some(e => e.type === "thread.queued" && e.payload.images === 1));
    await w.tool("threads.answer", { ask: ask.id, decision: "allow", surface: "deck" });
    await w.finished(th.id, 2);
    assert.equal((await w.said(th.id)).at(-1), "echo: then look at this (+1 images)", "the images went with the words");

    // A steer sent while a question waits, then a stop before Claude took it in.
    await w.tool("threads.send", { thread: th.id, text: "bash npm run build", surface: "deck" });
    await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the second ask");
    const st = (await w.tool("threads.send", { thread: th.id, text: "and check this one", surface: "deck", images: [png] })).data;
    assert.equal(st.steered, true);
    await w.tool("threads.stop", { thread: th.id });
    await until(async () => (await w.tool("threads.get", { thread: th.id })).data.thread.status === "stopped", "the stop");
    // The next message resumes it: the cut-off steer runs first, with its image.
    await w.tool("threads.send", { thread: th.id, text: "hello", surface: "deck" });
    await until(async () => (await w.said(th.id)).includes("echo: and check this one (+1 images)"), "the restored steer to run");
    const ev = await w.events(th.id);
    assert.ok(ev.some(e => e.type === "thread.sent" && e.payload.via === "restored" && e.payload.uuid === st.uuid));
  });

  test(`${driver}: effort, as /effort: at start, live, kept over a resume, and with a send; a person's only`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck", effort: "high" })).data;
    await w.finished(th.id);
    let argv = w.launches().filter(x => x.argv).at(-1).argv;
    assert.equal(argv[argv.indexOf("--effort") + 1], "high");
    assert.equal((await w.events(th.id)).find(e => e.type === "thread.started").payload.effort, "high");
    assert.equal((await w.tool("threads.start", { cwd: w.work, prompt: "hello", effort: "huge" })).error.code, "bad_input");
    assert.equal((await w.tool("threads.effort", { thread: th.id, effort: "low" }, "mcp")).error.code, "not_found");
    assert.deepEqual((await w.tool("threads.effort", { thread: th.id, effort: "low" }, "deck")).data, { thread: th.id, effort: "low" });
    await until(() => w.launches().some(l => l.effort === "low"), "the effort to reach Claude Code");
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.effort, "low");
    assert.ok((await w.events(th.id)).some(e => e.type === "effort.switched" && e.payload.effort === "low"));
    await w.tool("threads.stop", { thread: th.id });
    await w.tool("threads.send", { thread: th.id, text: "hello", surface: "deck" });
    await w.finished(th.id, 2);
    argv = w.launches().filter(x => x.argv).at(-1).argv;
    assert.equal(argv[argv.indexOf("--effort") + 1], "low", "a resume keeps it");
    // The Capsule's Cmd-Return: deeper, on the same thread, in one send.
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "deeper", model: "opus", effort: "max" }, "mcp")).error.code, "not_found");
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "deeper", surface: "deck", model: "sonnet", effort: "max" }, "deck")).data.sent, true);
    await w.finished(th.id, 3);
    const rec = (await w.tool("threads.get", { thread: th.id })).data.thread;
    assert.deepEqual([rec.model, rec.effort], ["sonnet", "max"]);
    assert.ok(w.launches().some(l => l.model === "sonnet") && w.launches().some(l => l.effort === "max"));
  });

  test(`${driver}: a warm session for memory: the second question finds one waiting, each question a fresh one, none in the list`, { skip }, async t => {
    const w = await boot(t, { driver });
    const asker = { ask: async i => { const r = await w.internal("threads.quick", i); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return { data: r.data }; } };
    assert.equal((await w.tool("threads.quick", { purpose: "memory", prompt: "x" })).error.code, "no_such_tool", "internal: modules only");
    const a = (await asker.ask({ purpose: "memory", system: "Answer from the facts given.", prompt: "who is kit" })).data;
    assert.deepEqual([a.text, a.ok, a.warm], ["echo: who is kit", true, false]);
    // The spare for the next question is started behind it; wait for it to be up and waiting (a spare still starting is not warm yet).
    const quickLive = async () => (await w.tool("threads.list", { all: true })).data.filter(r => r.name === "Vyre memory" && r.status === "idle" && r.id !== a.thread);
    await until(async () => (await quickLive()).length === 1, "the spare");
    const b = (await asker.ask({ purpose: "memory", system: "Answer from the facts given.", prompt: "who is juno" })).data;
    assert.deepEqual([b.text, b.warm], ["echo: who is juno", true], "a fresh session that never heard the first question");
    assert.notEqual(a.thread, b.thread);
    await until(async () => (await w.tool("threads.get", { thread: a.thread })).data.thread.status === "stopped", "the used one closes");
    assert.ok(!(await w.tool("threads.list", {})).data.some(r => r.name === "Vyre memory"), "not in a person's list");
    const launch = w.launches().filter(x => x.argv).at(-1).argv;
    assert.ok(launch.includes("--setting-sources") && !launch.includes("--plugin-dir"), "lean: no settings, no plugin");
    assert.ok(launch.includes("--no-session-persistence"), "no transcript for Recall to index");
  });

  test(`${driver}: threads.quick spend_purpose puts that answer's cost in the ledger under the asker's own word, and a bad one is ignored`, { skip }, async t => {
    const w = await boot(t, { driver });
    const ask = async i => w.d.registry.call("threads.quick", { purpose: "memory", ...i }, "module:watchers");
    const a = await ask({ prompt: "spend 0.05", spend_purpose: "digest" });
    assert.equal(a.error, undefined, JSON.stringify(a));
    const row = () => w.d.registry.call("spend.summary", {}, "cli").then(r => JSON.stringify(r.data));
    await until(async () => (await row()).includes("watchers:digest"), "the ledger row");
    assert.match(await row(), /"purpose":"watchers:digest"/, "under the calling module's own name");
    // No word, or one that is not a plain word: today's attribution (the session's purpose), never the bad text.
    await ask({ prompt: "spend 0.04" });
    await ask({ prompt: "spend 0.03", spend_purpose: "bad purpose with spaces; drop table" });
    await ask({ prompt: "spend 0.02", spend_purpose: "teammates:theirs" });   // another module's name is never booked
    await until(async () => (await row()).includes('"purpose":"memory"'), "the default row");
    assert.doesNotMatch(await row(), /drop table|bad purpose|teammates:theirs/);
    // The field is for modules: a person's surface cannot even reach the tool, so it cannot name a purpose.
    assert.equal((await w.tool("threads.quick", { purpose: "memory", prompt: "x", spend_purpose: "x" })).error.code, "no_such_tool");
  });

  test(`${driver}: threads.quick with stream hands partial text to the calling module, never to a caller that did not ask`, { skip }, async t => {
    const w = await boot(t, { driver });
    // As a first-party module would call it (ctx.call's opts.onPartial becomes meta.partial).
    const ask = async (extra, partial) => (await w.d.registry.call("threads.quick", { purpose: "memory", prompt: "who is kit", ...extra }, "module:vyred", partial ? { partial } : {}));
    const parts = [];
    const a = await ask({ stream: true }, d => parts.push(d));
    assert.equal(a.error, undefined, JSON.stringify(a));
    assert.equal(a.data.text, "echo: who is kit");
    assert.equal(parts.join(""), "echo: who is kit", "the partials add up to the answer");
    const none = [];
    await ask({}, d => none.push(d));
    assert.deepEqual(none, [], "no stream asked, none given");
  });

  test(`${driver}: an interrupted turn ends canceled, by you`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "bash npm test", surface: "deck" })).data;
    await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    await w.tool("threads.interrupt", { thread: th.id });
    await w.finished(th.id);
    const fin = (await w.events(th.id)).find(e => e.type === "thread.finished").payload;
    assert.deepEqual([fin.canceled, fin.reason], [true, "interrupt"]);
  });

  test(`${driver}: rewind goes back to a message, as a double Esc does, and its words come back`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "one", surface: "deck" })).data;
    await w.finished(th.id);
    for (const [n, text] of [[2, "two"], [3, "three"]]) { await w.tool("threads.send", { thread: th.id, text, surface: "deck" }); await w.finished(th.id, n); }
    const turns = (await w.events(th.id)).filter(e => e.type === "thread.turn").map(e => e.payload);
    const file = path.join(w.transcripts, w.work.replace(/[^A-Za-z0-9]/g, "-"), `${th.id}.jsonl`);
    const lines = () => fs.readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    const two = lines().find(l => l.type === "user" && l.uuid === turns[1].uuid);
    assert.ok(two, "a user message's transcript uuid is the one thread.turn gave");
    const r = (await w.tool("threads.rewind", { thread: th.id, uuid: turns[1].uuid })).data;
    // .thread and .id name the same session (native-core's naming footgun): every thread-
    // returning answer carries both now, .id canonical.
    assert.deepEqual(r, { rewound: true, id: th.id, thread: th.id, uuid: turns[1].uuid, text: "two" });
    const argv = (await until(() => w.launches().find(l => l.argv && l.argv.includes("--resume-session-at")), "the rewound launch")).argv;
    assert.equal(argv[argv.indexOf("--resume-session-at") + 1], two.parentUuid, "it goes on from just before the message");
    assert.ok((await w.events(th.id)).some(e => e.type === "thread.rewound" && e.payload.at === two.parentUuid));
    await w.tool("threads.send", { thread: th.id, text: "two, but shorter", surface: "deck" });
    await w.finished(th.id, 4);
    const again = lines().find(l => l.type === "user" && l.message.content === "two, but shorter");
    assert.equal(again.parentUuid, two.parentUuid, "the new message hangs where the old one did");
    assert.equal((await w.tool("threads.rewind", { thread: th.id, uuid: turns[0].uuid })).data.rewound, false, "the first message starts a new session instead");
    assert.equal((await w.tool("threads.rewind", { thread: th.id, uuid: turns[1].uuid }, "mcp")).error.code, "not_found");
  });

  // native-core: Claude Code parity item 3, "fork from any turn" - rewind's other menu item.
  // threads.fork already forks from the live end (--fork-session + --resume); rewind already
  // resumes at a message's parentUuid (--resume-session-at) in place. Neither combined the two,
  // so there was no way to fork FROM an earlier turn, leaving the original untouched - only
  // "fork from now" or "rewind in place". threads.fork's new `at` does both together.
  test(`${driver}: fork from an earlier turn leaves the original untouched, past that point`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "one", surface: "deck" })).data;
    await w.finished(th.id);
    for (const [n, text] of [[2, "two"], [3, "three"]]) { await w.tool("threads.send", { thread: th.id, text, surface: "deck" }); await w.finished(th.id, n); }
    const turns = (await w.events(th.id)).filter(e => e.type === "thread.turn").map(e => e.payload);
    const file = path.join(w.transcripts, w.work.replace(/[^A-Za-z0-9]/g, "-"), `${th.id}.jsonl`);
    const before = fs.readFileSync(file, "utf8");
    const two = before.trim().split("\n").map(l => JSON.parse(l)).find(l => l.type === "user" && l.uuid === turns[1].uuid);
    assert.ok(two, "a user message's transcript uuid is the one thread.turn gave");

    const f = (await w.tool("threads.fork", { thread: th.id, at: turns[1].uuid, prompt: "two, forked", surface: "deck" })).data;
    assert.notEqual(f.id, th.id);
    await w.finished(f.id);
    const argv = w.launches().at(-1).argv;
    assert.ok(argv.includes("--fork-session"), "forked, not rewound in place");
    assert.equal(argv[argv.indexOf("--resume") + 1], th.id);
    assert.equal(argv[argv.indexOf("--resume-session-at") + 1], two.parentUuid, "goes on from just before turn two");
    assert.deepEqual(await w.said(f.id), ["echo: two, forked"]);

    assert.equal(fs.readFileSync(file, "utf8"), before, "the original session is untouched");
    await w.tool("threads.send", { thread: th.id, text: "still going", surface: "deck" });
    await w.finished(th.id, 4);
    assert.ok((await w.said(th.id)).includes("echo: still going"), "the original session still has its own three turns and can keep going");

    assert.equal((await w.tool("threads.fork", { thread: th.id, at: "no-such-uuid" })).error.code, "bad_input");
    assert.equal((await w.tool("threads.fork", { thread: th.id, at: turns[0].uuid })).error.code, "bad_input", "the first message: fork the whole session instead");
  });

  test(`${driver}: a failed turn is a state with its turn, and a stop cancels the tool calls it left open`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "fail", surface: "deck" })).data;
    await w.finished(th.id);
    const states = (await w.events(th.id)).filter(e => e.type === "thread.state").map(e => e.payload);
    const failed = states.find(x => x.state === "failed");
    assert.ok(failed, JSON.stringify(states));
    assert.equal(failed.turn, `${th.id}:1`);
    assert.match(failed.error, /broke on purpose/);
    assert.equal(states.at(-1).state, "idle", "and then it is idle, ready for the next message");
    assert.ok(states.filter(x => x.state === "running").every(x => x.turn === `${th.id}:1`), "state carries the turn");
    // thread.status: the same "failed" of its own, in the canonical vocabulary.
    const statuses = (await w.events(th.id)).filter(e => e.type === "thread.status").map(e => e.payload);
    const failedStatus = statuses.find(x => x.status === "failed");
    assert.ok(failedStatus, JSON.stringify(statuses));
    assert.equal(failedStatus.turn, `${th.id}:1`);
    assert.equal(statuses.at(-1).status, "waiting", "and then it is waiting, ready for the next message");
    await w.tool("threads.send", { thread: th.id, text: "bash npm test", surface: "deck" });
    await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    await w.tool("threads.stop", { thread: th.id });
    await until(async () => (await w.events(th.id)).some(e => e.type === "thread.stopped"), "the stop");
    const tools = (await w.events(th.id)).filter(e => e.type === "thread.tool").map(e => e.payload.status);
    assert.deepEqual(tools, ["running", "canceled"]);
    // thread.status: plain "stopped", not "paused" - the person asked for this one, unlike an idle close.
    assert.equal((await w.events(th.id)).filter(e => e.type === "thread.status").at(-1).payload.status, "stopped");
  });

  test(`${driver}: a retried send with the same Idempotency-Key is the same message, never a second turn; the queue can be read`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    const key = "deck-retry-1";
    const send = () => call("threads.send", { thread: th.id, text: "only once", surface: "deck" }, { root: w.root, caller: "deck", headers: { "idempotency-key": key } });
    const a = await send();
    assert.equal(a.data.sent, true);
    await w.finished(th.id, 2);
    const b = await send();
    assert.equal(b.data.sent, true, "a retry reads as done");
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await w.events(th.id)).filter(e => e.type === "thread.turn").length, 2, "no second turn for the retry");
    // The queue, read.
    await w.tool("threads.send", { thread: th.id, text: "bash npm test", surface: "deck" });
    await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    const q = (await w.tool("threads.send", { thread: th.id, text: "after", surface: "deck", mode: "queue" })).data;
    const rows = (await w.tool("threads.queue", { thread: th.id })).data.queued;
    assert.deepEqual(rows.map(r => [r.queued, r.uuid, r.text]), [[q.queued_id, q.uuid, "after"]]);
    await w.tool("threads.mode", { thread: th.id, mode: "plan" }, "deck");
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.mode, "plan", "the record says the mode");
    // The mode carries over a resume, and the chip hears it from thread.started.
    await w.tool("threads.stop", { thread: th.id });
    await until(async () => (await w.events(th.id)).some(e => e.type === "thread.stopped"), "the stop");
    await w.tool("threads.send", { thread: th.id, text: "back", surface: "deck" });
    const back = await until(async () => (await w.events(th.id)).filter(e => e.type === "thread.started").at(-1), "the resume");
    assert.equal(back.payload.mode, "plan");
    const argv = (await until(() => w.launches().find(l => l.argv && l.argv.includes("plan")), "the resumed launch in plan mode")).argv;
    assert.equal(argv[argv.indexOf("--permission-mode") + 1], "plan");
    // Let it finish before the home is removed: the resumed turn and the queued one after it.
    await until(async () => (await w.events(th.id)).some(e => e.type === "thread.sent" && e.payload.via === "turn" && e.payload.queued === q.queued_id), "the queued message handed over");
    await w.tool("threads.stop", { thread: th.id });
    await until(async () => (await w.tool("threads.get", { thread: th.id })).data.thread.status === "stopped", "the last stop");
  });

  test(`${driver}: subagents wait for a slot when the box or the project is full, then run`, { skip: driver === "cli" ? "subagent slots need the Agent SDK's in-process hooks" : skip }, async t => {
    const w = await boot(t, { driver, sessions: { limits: { max_subagents: 1 } } });
    const a = (await w.tool("threads.start", { cwd: w.work, prompt: "subagent-slow read the menu", surface: "deck" })).data;
    await until(async () => (await w.tool("sessions.slots.status", {})).data.subagent.held === 1, "the first subagent's slot");
    const b = (await w.tool("threads.start", { cwd: w.work, prompt: "subagent check the prices", surface: "deck:phone" })).data;
    const queued = await until(async () => {
      const s = (await w.tool("sessions.slots.status", {})).data.subagent;
      return Object.values(s.projects).some(p => p.waiting === 1) ? s : null;
    }, "the second to wait");
    assert.equal(queued.held, 1, "never over the limit");
    await w.finished(a.id);
    await w.finished(b.id);
    assert.deepEqual([...await w.said(a.id), ...await w.said(b.id)], ["subagent done: read the menu", "subagent done: check the prices"]);
    const st = (await w.tool("sessions.slots.status", {})).data.subagent;
    assert.equal(st.held, 0, "every slot came back");
    assert.deepEqual((await w.tool("sessions.limits.set", { project: "harlow-legal", max_subagents: 2 })).data, { project: "harlow-legal", subagent: 2 });
    assert.equal((await w.tool("sessions.limits.set", { project: "harlow-legal", max_subagents: 9 }, "mcp")).error.code, "denied", "a model never raises its own limits");
  });

  test(`${driver}: near the plan's limit, new subagents pause until the reset or "Resume anyway"`, { skip: driver === "cli" ? "subagent slots need the Agent SDK's in-process hooks" : skip }, async t => {
    const saved = process.env.FAKE_CLAUDE_RESETS_AT;
    process.env.FAKE_CLAUDE_RESETS_AT = String(Math.floor(Date.now() / 1000) + 3600);
    t.after(() => { if (saved === undefined) delete process.env.FAKE_CLAUDE_RESETS_AT; else process.env.FAKE_CLAUDE_RESETS_AT = saved; });
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "nearlimit", surface: "deck" })).data;
    await w.finished(th.id);
    const u = await until(async () => (await w.tool("sessions.usage.get", {})).data.auths.find(a => a.paused), "the pause");
    assert.deepEqual([u.auth, u.status, u.utilization], ["ambient", "allowed_warning", 0.85]);
    await w.tool("threads.send", { thread: th.id, text: "subagent check the prices", surface: "deck" });
    await w.finished(th.id, 2);
    assert.match((await w.said(th.id)).at(-1), /The subagent did not run: Subagents are paused: the plan is 85% used/);
    // Resume anyway is the person's: a model is refused.
    assert.equal((await w.tool("sessions.usage.resume", { auth: "ambient" }, "mcp")).error.code, "denied");
    assert.equal((await w.tool("sessions.usage.resume", { auth: "ambient" }, "deck")).data.paused, false);
    await w.tool("threads.send", { thread: th.id, text: "subagent check the prices", surface: "deck" });
    await w.finished(th.id, 3);
    assert.equal((await w.said(th.id)).at(-1), "subagent done: check the prices");
  });

  test(`${driver}: thread.usage says the context used and the window; a teammate's result waits for the turn, never steers`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    const usage = (await w.events(th.id)).find(e => e.type === "thread.usage").payload;
    assert.equal(usage.context.max, 200000);
    assert.ok(usage.context.used > 2400 && usage.context.share > 0 && usage.context.share < 1, JSON.stringify(usage.context));
    await w.tool("threads.send", { thread: th.id, text: "bash npm test", surface: "deck" });
    const ask = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    // request: core/team's own id for the ask this reply answers, so a surface with two open
    // asks to the same teammate matches the reply by id, not by role, FIFO (teammates, ADR 0031).
    const r = await w.internal("threads.post", { thread: th.id, text: "kit found the menu file", kind: "teammate-result", from: "teammate:kit", request: "req_abc123" });
    const posted = r.data && r.data.data ? r.data.data : r.data;
    assert.ok(posted, JSON.stringify(r));
    assert.equal(posted.queued, true, "queued behind the running turn, not steered");
    const queued = (await w.tool("threads.queue", { thread: th.id })).data.queued;
    assert.equal(queued.find(q => q.uuid === posted.uuid).request, "req_abc123", "readable back before it is even delivered");
    const queuedEvent = (await w.events(th.id)).find(e => e.type === "thread.queued" && e.payload.kind === "teammate-result");
    assert.equal(queuedEvent.payload.request, "req_abc123");
    await w.tool("threads.answer", { ask: ask.id, decision: "allow", surface: "deck" });
    await w.finished(th.id, 3);
    const sent = (await w.events(th.id)).find(e => e.type === "thread.sent" && e.payload.kind === "teammate-result");
    assert.deepEqual([sent.payload.via, sent.payload.surface, sent.payload.request], ["turn", "teammate:kit", "req_abc123"]);
    assert.equal((await w.said(th.id)).at(-1), "echo: kit found the menu file");
    assert.doesNotMatch((await w.said(th.id)).join(" "), /took in: kit/, "it never steered");
  });

  test(`${driver}: a teammate's post to an idle thread carries its request id straight into thread.sent too`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    await w.internal("threads.post", { thread: th.id, text: "kit is done", kind: "teammate-result", from: "teammate:kit", request: "req_xyz" });
    await w.finished(th.id, 2);
    const sent = (await w.events(th.id)).find(e => e.type === "thread.sent" && e.payload.kind === "teammate-result");
    assert.equal(sent.payload.request, "req_xyz");
  });

  test(`${driver}: an ill-shaped request id is dropped before it is ever stored or broadcast (reviewer's LOW on cb387d88)`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    await w.internal("threads.post", { thread: th.id, text: "kit is done", kind: "teammate-result", from: "teammate:kit", request: "a".repeat(65) });
    await w.finished(th.id, 2);
    const sent = (await w.events(th.id)).find(e => e.type === "thread.sent" && e.payload.kind === "teammate-result");
    assert.equal(sent.payload.request, undefined, "too long: never stored or emitted");
  });

  test(`${driver}: switch the model (/model), list the slash commands, and rewind the files a turn changed`, { skip }, async t => {
    const w = await boot(t, { driver });
    const menu = path.join(w.work, "menu.md");
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: `write ${menu}`, surface: "deck" })).data;
    const ask = await until(async () => (await w.tool("threads.asks", { thread: th.id })).data[0], "the ask");
    await w.tool("threads.answer", { ask: ask.id, decision: "allow", surface: "deck" });
    await w.finished(th.id);
    assert.ok(fs.existsSync(menu));
    // /model
    assert.deepEqual((await w.tool("threads.model", { thread: th.id, model: "sonnet" }, "deck")).data, { thread: th.id, model: "sonnet" });
    await until(() => w.launches().some(l => l.model === "sonnet"), "the switch to reach Claude Code");
    assert.equal((await w.tool("threads.get", { thread: th.id })).data.thread.model, "sonnet");
    assert.ok((await w.events(th.id)).some(e => e.type === "model.switched" && e.payload.model === "sonnet"));
    assert.equal((await w.tool("threads.model", { thread: th.id, model: "opus" }, "mcp")).error.code, "not_found");
    // The / menu
    const cmds = (await w.tool("threads.commands", { thread: th.id })).data.commands;
    assert.deepEqual(cmds.map(c => c.name), ["compact", "review"]);
    if (driver === "sdk") assert.equal(cmds[0].description, "Clear the conversation but keep a summary", "the SDK knows the descriptions");
    // Rewind the code only: the file its turn wrote goes, the conversation stays.
    const turn = (await w.events(th.id)).find(e => e.type === "thread.turn").payload;
    const r = (await w.tool("threads.rewind", { thread: th.id, uuid: turn.uuid, restore: "code" })).data;
    assert.equal(r.restore, "code");
    assert.deepEqual(r.files, { restored: true, files_changed: [menu] });
    assert.ok(!fs.existsSync(menu), "the file is put back as it was (not there)");
    assert.ok(!w.launches().some(l => l.argv && l.argv.includes("--resume-session-at")), "the conversation was not rewound");
  });

  test(`${driver}: images, ! shell, # memory, thinking and background tasks, as in Claude Code`, { skip }, async t => {
    const w = await boot(t, { driver });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" })).data;
    await w.finished(th.id);
    // Image paste
    const png = Buffer.from("89504e470d0a1a0a", "hex").toString("base64");
    await w.tool("threads.send", { thread: th.id, text: "look at this", surface: "deck", images: [{ media_type: "image/png", data: png }] });
    await w.finished(th.id, 2);
    assert.equal((await w.said(th.id)).at(-1), "echo: look at this (+1 images)");
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "x", images: [{ media_type: "application/pdf", data: png }] })).error.code, "bad_input");
    // ! shell: runs here, as the person, under the floor; Claude sees it with the next message
    const sh = (await w.tool("threads.shell", { thread: th.id, command: "echo northwind" }, "deck")).data;
    assert.deepEqual([sh.code, sh.output.trim()], [0, "northwind"]);
    assert.equal((await w.tool("threads.shell", { thread: th.id, command: "echo x > .claude/settings.local.json" }, "deck")).error.code, "denied", "the floor holds");
    assert.equal((await w.tool("threads.shell", { thread: th.id, command: "echo hi" }, "mcp")).error.code, "not_found", "a model never runs the person's shell");
    await w.tool("threads.send", { thread: th.id, text: "what did it print?", surface: "deck" });
    await w.finished(th.id, 3);
    assert.match((await w.said(th.id)).at(-1), /<bash-input>echo northwind<\/bash-input>[\s\S]*<bash-stdout>northwind/);
    // # memory
    const rem = (await w.tool("threads.remember", { thread: th.id, text: "Prices have two decimals." }, "deck")).data;
    assert.equal(rem.file, path.join(w.work, "CLAUDE.md"));
    assert.match(fs.readFileSync(rem.file, "utf8"), /^- Prices have two decimals\.$/m);
    // The user's own CLAUDE.md, for a temp home, is the home's own (claudeHome), never ~/.claude.
    const mine = (await w.tool("threads.remember", { thread: th.id, text: "Call me alex.", scope: "user" }, "deck")).data;
    assert.equal(mine.file, path.join(w.root, "claude", "CLAUDE.md"));
    // Thinking off
    assert.deepEqual((await w.tool("threads.thinking", { thread: th.id, on: false }, "deck")).data, { thread: th.id, thinking: false });
    await until(() => w.launches().some(l => l.thinking === 0), "thinking off to reach Claude Code");
    // Background tasks
    await w.tool("threads.send", { thread: th.id, text: "background npm run dev", surface: "deck" });
    await w.finished(th.id, 4);
    const task = (await w.tool("threads.tasks", { thread: th.id })).data.tasks[0];
    assert.deepEqual([task.kind, task.status, task.title, task.background], ["shell", "running", "npm run dev", true]);
    assert.equal((await w.tool("threads.kill-task", { thread: th.id, task: task.id }, "deck")).data.killed, true);
    await until(async () => (await w.events(th.id)).some(e => e.type === "thread.task" && e.payload.status === "killed"), "the task to stop");
  });

  test(`${driver}: on a Mac, Claude Code's own login`, { skip }, async t => {
    const w = await boot(t, { driver, role: "local" });
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: "whoami", surface: "deck" })).data;
    await w.finished(th.id);
    assert.deepEqual(await w.said(th.id), ["auth=ambient"]);
  });
}
