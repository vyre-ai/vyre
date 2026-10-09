// @ts-check
// The window meter for a person's own terminal session: read from the transcript's last request, and a warning said once per crossing, never to an agent or a session Vyre runs.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome } from "../../test/helpers.js";
import { lastUsage, meterOf, wantsMillion, warning } from "./meter.js";

const SESSION = "bbbbbbbb-2222-4000-8000-000000000002";
const usage = (input, cached, out) => ({ input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: out });
const reply = (u, model = "claude-opus-4-5-20251101", extra = {}) => JSON.stringify({ type: "assistant", sessionId: SESSION, message: { role: "assistant", model, content: [{ type: "text", text: "ok" }], usage: u }, ...extra });
const person = text => JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: text } });

function transcript(t, lines) {
  const dir = tempHome(t);
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

test("meter: the last request's tokens in the window, from the end of the file, skipping a subagent's lines", t => {
  const file = transcript(t, [person("hi"), reply(usage(10, 30_000, 500)), person("more"), reply(usage(12, 118_000, 800)), reply(usage(1, 1, 1), "claude-opus-4-5", { isSidechain: true })]);
  assert.deepEqual(lastUsage(file), { used: 118_812, model: "claude-opus-4-5-20251101" });
  const m = meterOf(file);
  assert.ok(m);
  assert.equal(m.window, 200_000);
  assert.ok(Math.abs(m.share - 0.59406) < 1e-5);
  assert.equal(lastUsage(transcript(t, [person("hi")])), null, "no request yet");
  assert.equal(lastUsage(path.join(tempHome(t), "none.jsonl")), null);
});

test("meter: a very long transcript is read from its end, and a session over its model's window has a bigger one than the name says", t => {
  const filler = Array.from({ length: 4000 }, (_, i) => person(`line ${i} ${"x".repeat(100)}`));
  const file = transcript(t, [reply(usage(1, 1000, 10)), ...filler, reply(usage(5, 250_000, 100))]);
  assert.equal(lastUsage(file)?.used, 250_105);
  assert.equal(meterOf(file)?.window, 1_000_000, "250,000 tokens do not fit 200,000");
  assert.ok((meterOf(file)?.share ?? 1) < 0.26);
  // A settings file that names a 1M model says so before any transcript can.
  const claude = tempHome(t);
  assert.equal(wantsMillion(claude, {}), false);
  fs.writeFileSync(path.join(claude, "settings.json"), JSON.stringify({ model: "opus[1m]" }));
  assert.equal(wantsMillion(claude, {}), true);
  assert.equal(wantsMillion(tempHome(t), { ANTHROPIC_MODEL: "claude-sonnet-4-5[1m]" }), true);
  const small = transcript(t, [reply(usage(10, 150_000, 100))]);
  assert.equal(meterOf(small, { million: true })?.window, 1_000_000);
  assert.ok((meterOf(small, { million: true })?.share ?? 1) < 0.2);
});

test("meter: the warning says what to do in plain words", () => {
  const w = warning({ used: 123_456, window: 200_000, share: 0.617 });
  assert.match(w, /^This session's window is 62% full \(about 123,000 of 200,000 tokens\)\./);
  assert.match(w, /type \/exit, then run `vyre roll` in this folder/);
  assert.ok(!w.includes("—"));
});

/** A vyred whose transcripts folder holds the session. */
async function world(t, lines, config = {}) {
  const root = fs.realpathSync(tempHome(t));
  const dir = path.join(root, "transcripts", "-work-app");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${SESSION}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  // the line the notice is told at is the setting `sessions.rollover_at` (default 80); these cases are written for a 60 percent line
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "transcripts")], recall: { every: 0, vectors: false }, vault: { keystore: "file" }, ...config }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  assert.equal((await call("settings.set", { key: "sessions.rollover_at", value: 60 }, { root, caller: "cli" })).error, undefined);
  const enrich = (input, caller = "harness", meta) => d.registry.call("harness.enrich", { prompt: "carry on", cwd: "/work/app", session: SESSION, transcript: file, ...input }, caller, meta);
  return { d, file, enrich, root };
}

test("harness.enrich: a terminal session is told once when its window passes the line, and again only after it has fallen back under it", async t => {
  const w = await world(t, [person("hi"), reply(usage(10, 90_000, 500))]);                 // 45%
  assert.equal((await w.enrich()).data.notice, undefined);
  fs.appendFileSync(w.file, reply(usage(10, 121_000, 600)) + "\n");                         // 60.8%
  const first = await w.enrich();
  assert.equal(first.error, undefined, JSON.stringify(first));
  assert.match(first.data.notice, /61% full[\s\S]*vyre roll/);
  assert.equal((await w.enrich()).data.notice, undefined, "once per crossing");
  fs.appendFileSync(w.file, reply(usage(10, 150_000, 600)) + "\n");
  assert.equal((await w.enrich()).data.notice, undefined, "still over: not again");
  // A roll (or /clear, or a compaction) leaves the window nearly empty: the next crossing is told.
  fs.appendFileSync(w.file, reply(usage(10, 20_000, 600)) + "\n");
  assert.equal((await w.enrich()).data.notice, undefined);
  fs.appendFileSync(w.file, reply(usage(10, 130_000, 600)) + "\n");
  assert.match((await w.enrich()).data.notice, /65% full/);
});

test("harness.enrich: no warning for an agent, a session Vyre runs, a transcript that is not the session's own or is outside a transcript folder, or with sessions.rollover off", async t => {
  const w = await world(t, [person("hi"), reply(usage(10, 150_000, 500))]);                 // 75%
  assert.equal((await w.enrich({ agent: "kit" }, "harness:agent:kit")).data?.notice, undefined, "an agent's");
  assert.equal((await w.enrich({}, "harness", { thread: SESSION })).data?.notice, undefined, "a session Vyre runs rolls itself");
  const other = path.join(path.dirname(w.file), "cccccccc-3333-4000-8000-000000000003.jsonl");
  fs.copyFileSync(w.file, other);
  assert.equal((await w.enrich({ transcript: other })).data?.notice, undefined, "another session's file");
  const outside = path.join(tempHome(t), `${SESSION}.jsonl`);
  fs.copyFileSync(w.file, outside);
  assert.equal((await w.enrich({ transcript: outside })).data?.notice, undefined, "outside every transcript folder: a path is never read on a caller's word");
  assert.equal((await w.enrich({ transcript: "/etc/passwd" })).data?.notice, undefined);
  assert.ok((await w.enrich()).data.notice, "and the person's own session is told");
  // Off: told nothing, ever.
  const off = await world(t, [person("hi"), reply(usage(10, 150_000, 500))]);
  // through the daemon socket, as a person's surface (a registry call with no kernel facts is not one)
  assert.equal((await call("settings.set", { key: "sessions.rollover", value: false }, { root: off.root, caller: "cli" })).error, undefined);
  assert.equal((await off.enrich()).data?.notice, undefined);
});
