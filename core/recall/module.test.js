// @ts-check
// The recall module inside a real vyred: tools over the socket, events in the log, background
// indexing that does not hold up startup, and the guard that keeps tests off real transcripts.

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { request, call } from "../daemon/client.js";
import { useEmbedder, readable } from "./index.js";
import { realHome } from "../config/dialogs.js";
import { fakeEmbedder } from "./testing.js";
import { SESSIONS, writeTranscripts } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";

/** A temp home whose config points transcripts at the fixture corpus. */
function home(t, recall = {}) {
  const root = tempHome(t);
  const dir = path.join(root, "transcripts");
  writeTranscripts(dir);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [dir], recall: { every: 0, ...recall } }));
  return { root, dir };
}

test("recall module: indexes in the background and answers every tool", async t => {
  const { root } = home(t, { vectors: false });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const tools = (await request("GET", "/v1/tools", undefined, { root })).data.map(x => x.name);
  for (const n of ["recall.search", "recall.thread", "recall.sessions", "recall.index", "recall.status"]) assert.ok(tools.includes(n), `${n} is missing`);

  const ix = await call("recall.index", {}, { root });
  assert.equal(ix.data.sessions, SESSIONS.length);
  assert.deepEqual(Object.keys(ix.data).filter(k => ["sessions", "appended", "reindexed", "skipped", "ms"].includes(k)).sort(),
    ["appended", "ms", "reindexed", "sessions", "skipped"]);
  assert.equal(ix.data.skipped, SESSIONS.length, "the pass at start had not indexed the corpus");

  const hits = (await call("recall.search", { q: "intake form", limit: 3 }, { root })).data;
  assert.equal(hits[0].name, "Harlow site rebuild");
  // sessions widens a scope: a module may name them, a model (mcp) may not.
  const nowhere = { q: "intake form", project_cwds: ["/nonexistent/scope"], sessions: [hits[0].session] };
  assert.ok((await d.registry.call("recall.search", nowhere, "module:memory")).data.length > 0);
  const widened = await d.registry.call("recall.search", nowhere, "mcp");
  assert.ok(widened.error && !(widened.data && widened.data.length), "a model widened its scope by naming sessions");
  const th = (await call("recall.thread", { session: hits[0].session }, { root })).data;
  assert.equal(th.turns.length, 4);
  const ss = (await call("recall.sessions", { human: false }, { root })).data;
  assert.equal(ss.length, 2);
  const st = (await call("recall.status", {}, { root })).data;
  assert.equal(st.sessions, SESSIONS.length);
  assert.equal(st.turns, 16);
  assert.equal(st.vectors.on, false);
  assert.match(st.vectors.why, /config/);

  const events = (await request("GET", "/v1/events?type=session.indexed", undefined, { root })).data;
  assert.equal(events.length, SESSIONS.length);
  const first = events.find(e => e.thread === "11111111-aaaa-4000-8000-000000000001");
  assert.deepEqual(first.payload, { session: "11111111-aaaa-4000-8000-000000000001", from: 0, to: 3, rewritten: false });
  assert.equal(first.source, "recall");
});

test("recall module: with an embedder, vectors fill in after a pass and search goes hybrid", async t => {
  const { root } = home(t);
  const emb = fakeEmbedder();
  useEmbedder(emb);
  t.after(() => useEmbedder(null));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("recall.index", {}, { root });
  let st;
  for (let i = 0; i < 100; i++) {
    st = (await call("recall.status", {}, { root })).data;
    if (st.vectors.pending === 0 && !st.vectors.embedding) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(st.vectors.embedded, 16);
  assert.match(st.vectors.why, /^on/);
  const before = emb.calls;
  const hits = (await call("recall.search", { q: "invoice watcher" }, { root })).data;
  assert.ok(hits.length > 0);
  assert.equal(emb.calls, before + 1, "the query was not embedded, so search was not hybrid");
});

test("recall module: under node --test the real ~/.claude is never read", () => {
  const real = path.join(os.homedir(), ".claude", "projects");
  assert.deepEqual(readable([real, "/tmp/elsewhere"]), ["/tmp/elsewhere"]);
});

test("recall module: a temp, dev or trial home never reads the person's ~/.claude, only its own", () => {
  const real = path.join(os.homedir(), ".claude", "projects");
  const cfgDir = path.join(os.homedir(), "claude-config", "projects");
  const dev = "/tmp/vyre-dev-home";
  const env = { CLAUDE_CONFIG_DIR: path.join(os.homedir(), "claude-config") };   // no NODE_TEST_CONTEXT: a dev world is not a test
  assert.deepEqual(readable([real, cfgDir, "/tmp/elsewhere", `${dev}/claude/projects`], dev, env), ["/tmp/elsewhere", `${dev}/claude/projects`]);
  assert.deepEqual(readable(["~/.claude/projects"], dev, env), []);
  // Said on purpose: the real one is read.
  assert.deepEqual(readable([real], dev, { ...env, VYRE_ALLOW_REAL_TRANSCRIPTS: "1" }), [real]);
  // A home kept elsewhere on purpose names its folder, and reads it.
  const named = path.join(os.homedir(), ".claude", "projects", "fixture-only");
  assert.deepEqual(readable([named, real], dev, { VYRE_CLAUDE_HOME: path.dirname(path.dirname(named)) }), [named, real]);
  // The person's own ~/.vyre reads their own conversations.
  // (The person's home is realHome(), not $HOME: under a temp HOME this must still hold.)
  assert.deepEqual(readable([real], realHome(), {}), [real]);
  // Under node --test nothing real, even for ~/.vyre or with the opt-in.
  assert.deepEqual(readable([real], realHome(), { NODE_TEST_CONTEXT: "child", VYRE_ALLOW_REAL_TRANSCRIPTS: "1" }), []);
});

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vyre");
const run = (args, env) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" } },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr })));

test("recall cli: up, index, recall, down against a temp home", async t => {
  const { root } = home(t, { vectors: false });
  const env = { VYRE_HOME: root, VYRE_UP_WAIT_MS: "180000" }; // a busy machine takes longer than the usual 15 s to start vyred
  t.after(() => run(["down"], env));
  assert.match((await run(["up"], env)).out, /vyred running/);
  const ix = await run(["index"], env);
  assert.equal(ix.code, 0, ix.out);
  assert.match(ix.out, /6 sessions/);
  const r = await run(["recall", "intake", "form"], env);
  assert.equal(r.code, 0);
  assert.match(r.out, /Harlow site rebuild/);
  assert.match(r.out, /intake form/);
  assert.match((await run(["recall", "zygomorphic"], env)).out, /nothing matching/);
  assert.match((await run(["recall"], env)).out, /6 sessions · 16 turns/);
  const ev = await run(["recall", "eval", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "recall-eval.json")], env);
  assert.equal(ev.code, 0, ev.out);
  assert.match(ev.out, /14 questions/);
  assert.match(ev.out, /keyword +MRR@10 \d\.\d{3}/);
  assert.match((await run(["down"], env)).out, /vyred stopped/);
});

test("recall module: a completed turn indexes that session soon, without waiting for a pass", async t => {
  const { root } = home(t, { vectors: false, soonMs: 50 });
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("recall.index", {}, { root });
  const id = "11111111-aaaa-4000-8000-000000000001";
  const before = (await call("recall.thread", { session: id }, { root })).data;
  assert.equal(before.turns.length, 4);

  // The terminal session answers once more: a user line and an assistant line land in its transcript.
  const file = before.session.file;
  const at = new Date(before.session.ended + 60_000).toISOString();
  const base = { sessionId: id, cwd: before.session.cwd, userType: "external", entrypoint: "cli", isSidechain: false };
  fs.appendFileSync(file, JSON.stringify({ ...base, type: "user", timestamp: at, uuid: "soon-1", message: { role: "user", content: "Add a map to the contact page." } }) + "\n"
    + JSON.stringify({ ...base, type: "assistant", timestamp: at, uuid: "soon-2", message: { role: "assistant", content: [{ type: "text", text: "Added the map to /contact." }] } }) + "\n");
  // What the harness's Stop hook reports.
  assert.deepEqual((await call("harness.stop", { session: id }, { root })).data, { ok: true });

  let after = before;
  for (let i = 0; i < 50 && after.turns.length < 6; i++) {
    await new Promise(r => setTimeout(r, 50));
    after = (await call("recall.thread", { session: id }, { root })).data;
  }
  assert.deepEqual(after.turns.slice(4).map(x => x.text), ["Add a map to the contact page.", "Added the map to /contact."]);
  const ev = (await request("GET", "/v1/events?type=session.indexed", undefined, { root })).data.filter(e => e.thread === id);
  assert.deepEqual(ev.at(-1).payload, { session: id, from: 4, to: 5, rewritten: false });
});
