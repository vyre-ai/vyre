// @ts-check
// Vyre's own rollover, end to end on the fake `claude` (core/switchboard/testing/fake-claude.js): a long session rolls over between turns when its window passes
// the line, the thread and its history stay, the agent starts under a fresh session id, the next message carries the seed, and what was dropped is still read back
// word for word. Same boot() as sessions.test.js; the SDK driver runs where the SDK is installed (VYRE_SESSIONS_SDK_DIR).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noSdk, until, boot } from "./testing/boot.js";

// This harness has no inference door (the door path is lib/door-bridge.test.js): a provider that runs its own model process, Grok here, runs direct.
process.env.VYRE_LEGACY_DIRECT_MODEL = "1";

/** memory.prompt answers nothing here: the echoes below are then exactly what the person and Vyre sent. */
const noMemoryBlocks = w => {
  const realCall = w.d.registry.call.bind(w.d.registry);
  w.d.registry.call = async (tool, input, caller, meta) => tool === "memory.prompt" ? { data: { text: "", blocks: [] } } : realCall(tool, input, caller, meta);
};

/** A stand-in `grok` first on PATH: the fake ACP agent, its sessions kept in a folder. */
const withGrok = (t, w) => {
  const bin = path.join(w.root, "shim");
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp.js"), path.join(bin, "grok"));
  const saved = { PATH: process.env.PATH, FAKE_ACP_STORE: process.env.FAKE_ACP_STORE };
  process.env.FAKE_ACP_LOG = path.join(w.root, "acp.log");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.FAKE_ACP_STORE = path.join(w.root, "acp-store");
  fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
  t.after(() => { delete process.env.FAKE_ACP_LOG; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
};

for (const driver of ["cli", "sdk"]) {
  const skip = driver === "sdk" ? noSdk : false;

  /** A thread with a short history, then a reply that fills the window to `tokens`. */
  async function filled(t, w, tokens, first = "plan the Northwind menu") {
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: first, surface: "deck" })).data;
    await w.finished(th.id);
    assert.equal((await w.tool("threads.send", { thread: th.id, text: `bloat ${tokens}`, surface: "deck" })).error, undefined);
    await w.finished(th.id, 2);
    return th;
  }
  const rolled = async (w, id, n = 1) => until(async () => (await w.events(id)).filter(e => e.type === "thread.rolled").length >= n && (await w.events(id)).filter(e => e.type === "thread.rolled")[n - 1], `rollover ${n}`);

  test(`${driver}: a window past 60% rolls over between turns: same thread, a fresh native session, a notice, and the seed rides the next message with the person's words after it`, { skip }, async t => {
    const w = await boot(t, { driver });
    noMemoryBlocks(w);
    const th = await filled(t, w, 130_000);                         // 130k of 200k: 65%
    const ev = await rolled(w, th.id);
    assert.equal(ev.payload.thread, th.id);
    assert.equal(ev.payload.from, th.id, "the first window ran under the thread's own id");
    assert.match(ev.payload.to, /^[0-9a-f-]{36}$/);
    assert.notEqual(ev.payload.to, th.id);
    assert.ok(ev.payload.share >= 0.6 && ev.payload.share < 0.75, String(ev.payload.share));
    assert.equal(ev.payload.source, "reported");
    assert.match(ev.payload.text, /^Continued in a fresh session \(the window was 6\d% full\)\./);
    const events = await w.events(th.id);
    assert.ok(events.some(e => e.type === "thread.text" && e.payload.notice && /^Continued in a fresh session/.test(e.payload.text)), "said once in the transcript");
    // The agent was started under the new id, fresh, in the same folder.
    const starts = (await until(async () => { const l = w.launches(); return l.length >= 2 ? l : null; }, "second launch"));
    const second = starts.at(-1);
    assert.equal(second.cwd, w.work);
    const sid = second.argv[second.argv.indexOf("--session-id") + 1];
    assert.equal(sid, ev.payload.to, JSON.stringify(second.argv));
    assert.ok(!second.argv.includes("--resume"), "a fresh window is not a resume");
    // The thread record is the same one, with its rollover on the list.
    const rec = (await w.tool("threads.get", { thread: th.id })).data.thread;
    assert.equal(rec.id, th.id);
    const rolls = (await w.tool("threads.rolls", { thread: th.id })).data;
    assert.equal(rolls.native, ev.payload.to);
    assert.equal(rolls.rolls.length, 1);
    assert.equal(rolls.rolls[0].native_from, th.id);
    assert.equal(rolls.rolls[0].native_to, ev.payload.to);
    assert.equal(rolls.rolls[0].source, "reported");
    // The next message goes to the fresh session with the seed in front of it.
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "and the prices", surface: "deck" })).error, undefined);
    await w.finished(th.id, 3);
    const said = (await w.said(th.id)).at(-1);
    assert.match(said, /^echo: \[Vyre continuation:/);
    assert.match(said, /plan the Northwind menu/, "the seed carries what was said");
    assert.match(said, /Most recent, word for word/);
    assert.match(said, /memory_turn/);
    assert.match(said, /\n\]\n\nand the prices$/, "the person's words follow the seed");
    // The person's own words are what the transcript shows as sent, not the seed.
    const sent = (await w.events(th.id)).filter(e => e.type === "thread.sent").map(e => e.payload.text);
    assert.equal(sent.at(-1), "and the prices");
    // Settled: the seed went out once. A later message has none, and the session's own id is the one it resumes under.
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "thanks", surface: "deck" })).error, undefined);
    await w.finished(th.id, 4);
    assert.match((await w.said(th.id)).at(-1), /^echo: thanks$/);
    await w.tool("threads.stop", { thread: th.id });
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "back again", surface: "deck" })).error, undefined);
    await w.finished(th.id, 5);
    const resumed = w.launches().at(-1);
    assert.equal(resumed.argv[resumed.argv.indexOf("--resume") + 1], ev.payload.to, "a resume goes to the current window, not the first");
    assert.match((await w.said(th.id)).at(-1), /^echo: back again$/);
  });

  test(`${driver}: what the dropped window held is still read back word for word, through the pointers the seed names`, { skip }, async t => {
    const w = await boot(t, { driver });
    noMemoryBlocks(w);
    // A conversation too long for the seed's verbatim tail (60,000 characters): the person's early requests are then pointers. Each padded message gets a short reply.
    const pad = "padding words ".repeat(430);                                // about 6,000 characters
    const th = (await w.tool("threads.start", { cwd: w.work, prompt: `plan the Northwind menu with the spring specials and the autumn prices ${pad}`, surface: "deck" })).data;
    await w.finished(th.id);
    for (let i = 1; i <= 14; i++) {
      assert.equal((await w.tool("threads.send", { thread: th.id, text: `bloat 1000 request number ${i} for the bakery ${pad}`, surface: "deck" })).error, undefined);
      await w.finished(th.id, i + 1, 30_000);
    }
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "bloat 130000 and one more", surface: "deck" })).error, undefined);
    await w.finished(th.id, 16);
    const ev = await rolled(w, th.id);
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "and the prices", surface: "deck" })).error, undefined);
    await w.finished(th.id, 17);
    const seed = (await w.said(th.id)).at(-1);
    // A pointer line for the person's first request, in the first window's own session.
    const m = /\| ([0-9a-f]{8}):(\d+) person [^\n]*plan the Northwind menu/.exec(seed);
    assert.ok(m, seed.slice(0, 3000));
    assert.equal(m[1], th.id.slice(0, 8));
    // memory_turn (recall.turn) reads that turn exactly: all of it, though the index keeps only its first 4,000 characters.
    const turn = (await w.tool("recall.turn", { session: m[1], seq: Number(m[2]), after: 1 })).data;
    assert.equal(turn.session.id, th.id);
    assert.equal(turn.turns[0].text, `plan the Northwind menu with the spring specials and the autumn prices ${pad}`.trim());
    assert.equal(turn.turns[0].cut, undefined);
    assert.equal(turn.turns[0].pointer, `${th.id}:${m[2]}`);
    assert.match(turn.turns[1].text, /^echo: plan the Northwind menu/, "and the reply after it");
    // The second window's session is indexed under its own id and, without the seed, holds only the person's words.
    await w.tool("recall.index", {});
    const second = (await w.tool("recall.turn", { session: ev.payload.to, from: 0, span: 5 })).data;
    assert.equal(second.turns[0].text, "and the prices", "the seed is not a turn: it repeats what the first window already stored");
    // The seed's native session is the thread's own for origin: a transcript under it is a person's.
    const origin = (await w.internal("threads.origin", { session: ev.payload.to })).data;
    assert.deepEqual([origin.known, origin.human], [true, true]);
  });

  test(`${driver}: with sessions.rollover off, or below the line, nothing rolls`, { skip }, async t => {
    const w = await boot(t, { driver });
    noMemoryBlocks(w);
    const small = await filled(t, w, 60_000, "short one");                  // 30%
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await w.events(small.id)).filter(e => e.type === "thread.rolled").length, 0);
    assert.equal((await w.tool("settings.set", { key: "sessions.rollover", value: false })).error, undefined);
    const off = await filled(t, w, 150_000, "long but off");               // 75%
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await w.events(off.id)).filter(e => e.type === "thread.rolled").length, 0);
    // The line is a setting too.
    assert.equal((await w.tool("settings.set", { key: "sessions.rollover", value: true })).error, undefined);
    assert.equal((await w.tool("settings.set", { key: "sessions.rollover_at", value: 25 })).error, undefined);
    const lower = await filled(t, w, 60_000, "lower line");                 // 30% against a 25% line
    await rolled(w, lower.id);
  });

  test(`${driver}: it does not roll twice in 10 turns, and a person's surface can ask for a roll; a model's session cannot`, { skip }, async t => {
    const w = await boot(t, { driver });
    noMemoryBlocks(w);
    const th = await filled(t, w, 130_000);
    await rolled(w, th.id);
    // Fill the new window straight away: the loop guard holds it.
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "bloat 150000", surface: "deck" })).error, undefined);
    await w.finished(th.id, 3);
    await new Promise(r => setTimeout(r, 400));
    assert.equal((await w.events(th.id)).filter(e => e.type === "thread.rolled").length, 1, "rolled 1 turn ago");
    // Asking is a person's: a model's session is refused.
    const model = await w.d.registry.call("threads.roll", { thread: th.id }, `mcp:thread:${th.id}`, { thread: th.id });
    assert.ok(model.error, JSON.stringify(model));
    const guest = await w.d.registry.call("threads.rolls", { thread: th.id }, "mcp:agent:kit", { agent: "kit" });
    assert.ok(guest.error, JSON.stringify(guest));
    // The person asks: a second window (one turn at a time, never mid-turn).
    const asked = await w.tool("threads.roll", { thread: th.id });
    assert.equal(asked.error, undefined, JSON.stringify(asked));
    assert.equal(asked.data.rolled, true);
    assert.equal((await w.events(th.id)).filter(e => e.type === "thread.rolled").length, 2);
    const rolls = (await w.tool("threads.rolls", { thread: th.id })).data.rolls;
    assert.equal(rolls.length, 2);
    assert.equal(rolls[0].native_from, rolls[1].native_to, "the second window left the first window's fresh session");
    // A message sent while a roll is under way waits for it and goes to the fresh session, with the seed, once.
    const again = w.tool("threads.roll", { thread: th.id });
    const send = w.tool("threads.send", { thread: th.id, text: "mid-roll words", surface: "deck" });
    const [r, s] = await Promise.all([again, send]);
    assert.equal(s.error, undefined, JSON.stringify(s));
    assert.ok(r.error ? r.error.code === "busy" : r.data.rolled === true);
    await w.finished(th.id, 4);
    const said = (await w.said(th.id)).at(-1);
    assert.match(said, /mid-roll words$/);
    assert.equal((said.match(/^echo: \[Vyre continuation:/gm) || []).length, 1, "one seed (an earlier echo of one, quoted inside it, is indented)");
  });

  test(`${driver}: a named agent's thread rolls over as that agent: its fresh window starts with its own credentials and scope, and the seed holds only what its thread said`, { skip }, async t => {
    const w = await boot(t, { driver });
    noMemoryBlocks(w);
    assert.equal((await w.tool("agents.create", { name: "scout", projects: [], instructions: "Research only." })).error, undefined);
    const a = await w.d.registry.call("threads.launch", { cwd: w.work, agent: "scout", agent_kind: "agent", prompt: "what do you know", purpose: "agent" }, "module:agents");
    assert.equal(a.error, undefined, JSON.stringify(a));
    await w.finished(a.data.id);
    assert.equal((await w.tool("threads.send", { thread: a.data.id, text: "bloat 130000", surface: "deck" })).error, undefined);
    await w.finished(a.data.id, 2);
    const ev = await rolled(w, a.data.id);
    const launches = await until(async () => { const l = w.launches(); return l.length >= 2 ? l : null; }, "the fresh window's launch");
    assert.equal(launches.at(-1).agent, "scout", "the agent's own environment, not the person's");
    assert.equal(launches.at(-1).argv[launches.at(-1).argv.indexOf("--session-id") + 1], ev.payload.to);
    assert.equal((await w.tool("threads.send", { thread: a.data.id, text: "and the prices", surface: "deck" })).error, undefined);
    await w.finished(a.data.id, 3);
    assert.match((await w.said(a.data.id)).at(-1), /^echo: \[Vyre continuation:[\s\S]*what do you know[\s\S]*\n\]\n\nand the prices$/);
  });

  test(`${driver}: another agent (Grok, over ACP) rolls over on its own report of its window: a fresh session, the seed, and its conversation kept word for word where Recall reads it`, { skip }, async t => {
    const w = await boot(t, { driver });
    withGrok(t, w);
    noMemoryBlocks(w);
    const th = (await w.tool("threads.start", { cwd: w.work, provider: "grok", prompt: "plan the Northwind menu", surface: "deck" })).data;
    await w.finished(th.id);
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "ctxused 200000", surface: "deck" })).error, undefined);   // 77% of its 258,400
    await w.finished(th.id, 2);
    const ev = await rolled(w, th.id);
    assert.equal(ev.payload.to, null, "an ACP agent keeps its own session ids: nothing to name");
    assert.equal(ev.payload.source, "reported");
    assert.ok(ev.payload.share > 0.75 && ev.payload.window === 258_400, JSON.stringify(ev.payload));
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "and the prices", surface: "deck" })).error, undefined);
    await w.finished(th.id, 3);
    const said = "echo: " + w.acpPrompts().at(-1).join("");
    assert.match(said, /^echo: \[Vyre environment\][\s\S]*\[\/Vyre environment\][\s\S]*\[Vyre continuation:/, "an ACP agent is told its environment again with the first prompt of the fresh session, then the seed");
    assert.match(said, /plan the Northwind menu/);
    assert.match(said, /\n\]\n\nand the prices$/);
    // The conversation is kept as Claude Code's own layout under the home, and read back word for word through the same tool as any other session.
    const mirror = `m-${th.id}`;
    await w.tool("recall.index", {});
    const got = (await w.tool("recall.turn", { session: mirror, from: 0, span: 10 })).data;
    assert.equal(got.session.id, mirror);
    assert.equal(got.turns[0].text, "plan the Northwind menu");
    assert.equal(got.turns[0].role, "user");
    assert.match(got.turns[1].text, /^echo: [\s\S]*plan the Northwind menu$/);
    assert.equal(got.turns.find(x => x.text === "and the prices")?.role, "user");
    assert.ok(!got.turns.some(x => x.text.startsWith("[Vyre")), "a seed is not a turn");
    const origin = (await w.internal("threads.origin", { session: mirror })).data;
    assert.deepEqual([origin.known, origin.human, origin.provider], [true, true, "grok"]);
    // Deleting the thread deletes Vyre's own copy of its conversation, and Recall forgets it.
    const file = (await until(async () => { const f = []; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === `${mirror}.jsonl`) f.push(p); } }; walk(path.join(w.root, "mirror")); return f[0] || null; }, "the mirror file"));
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal((await w.tool("threads.delete", { thread: th.id })).error, undefined);
    assert.equal(fs.existsSync(file), false);
    assert.equal((await w.tool("recall.turn", { session: mirror, from: 0 })).error?.code, "not_found");
  });

  test(`${driver}: with no report of its window, an agent's is counted from the characters said, and rolls at the earlier line`, { skip }, async t => {
    const w = await boot(t, { driver });
    withGrok(t, w);
    noMemoryBlocks(w);
    const th = (await w.tool("threads.start", { cwd: w.work, provider: "grok", prompt: "start", surface: "deck" })).data;
    await w.finished(th.id);
    // The kernel log holds what was said: 400,000 characters is 100,000 tokens, and 12,000 more are the agent's own, of a 256,000-token window: 44%, under the 50% line an estimate rolls at.
    const say = chars => w.d.registry.deps.events.emit("threads", "thread.text", { message: "m", text: "word ".repeat(chars / 5), done: true }, { thread: th.id });
    say(400_000);
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "a short one", surface: "deck" })).error, undefined);
    await w.finished(th.id, 2);
    await new Promise(r => setTimeout(r, 300));
    assert.equal((await w.events(th.id)).filter(e => e.type === "thread.rolled").length, 0, "44% counted: under the line");
    say(100_000);                                                          // 125,000 tokens and 12,000: 53%
    assert.equal((await w.tool("threads.send", { thread: th.id, text: "and another", surface: "deck" })).error, undefined);
    await w.finished(th.id, 3);
    const ev = await rolled(w, th.id);
    assert.equal(ev.payload.source, "estimated");
    assert.match(ev.payload.text, /about 5\d% full/);
  });

  test(`${driver}: the switch eval: Claude to Codex and back, ten questions only the earlier turns can answer, every one right after each switch`, { skip }, async t => {
    const w = await boot(t, { driver });
    withGrok(t, w);
    noMemoryBlocks(w);
    // The recorded model (testing/golden.js): each agent answers a question only when its own session was sent the evidence.
    const gold = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "golden-switch.json"), "utf8"));
    const saved = { FAKE_GOLDEN_FILE: process.env.FAKE_GOLDEN_FILE, FAKE_GOLDEN_DIR: process.env.FAKE_GOLDEN_DIR };
    process.env.FAKE_GOLDEN_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "testing", "golden-switch.json");
    process.env.FAKE_GOLDEN_DIR = path.join(w.root, "golden");
    t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
    assert.equal((await w.tool("sessions.accounts.add", { provider: "grok", label: "Codex", kind: "login" })).error, undefined);
    const say = gold.turns.map(x => x.say);
    let n = 0;
    const turn = async (text, how) => {
      const r = how === "start" ? await w.tool("threads.start", { cwd: w.work, prompt: text, surface: "deck" }) : how.provider
        ? await w.tool("threads.switch", { thread: how.id, provider: how.provider, text }) : await w.tool("threads.send", { thread: how.id, text, surface: "deck" });
      assert.equal(r.error, undefined, JSON.stringify(r));
      const id = how === "start" ? r.data.id : how.id;
      await w.finished(id, ++n);
      return { id, said: (await w.said(id)).at(-1) };
    };
    const quiz = async (id, after, first) => {
      const asked = gold.questions.filter(q => q.after === after);
      for (const [i, q] of asked.entries()) {
        const r = await turn(q.ask, i === 0 && first ? { id, provider: first } : { id });
        assert.equal(r.said, q.answer, `${after}: ${q.ask}`);
      }
      return asked.length;
    };
    const th = (await turn(say[0], "start")).id;
    for (const x of say.slice(1, 3)) await turn(x, { id: th });
    let right = await quiz(th, "claude to codex", "grok");
    for (const x of say.slice(3)) await turn(x, { id: th });
    right += await quiz(th, "codex to claude", "claude");
    assert.equal(right, 10, "all ten questions were asked, and every answer was right");
    const switches = (await w.events(th)).filter(e => e.type === "thread.provider").map(e => `${e.payload.from} to ${e.payload.to}`);
    assert.deepEqual(switches, ["claude to grok", "grok to claude"]);
  });
}
