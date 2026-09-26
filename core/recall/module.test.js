// @ts-check
// The recall module inside a real vyred: tools over the socket, events in the log, background
// indexing that does not hold up startup, and the guard that keeps tests off real transcripts.

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

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "bin", "vyre");
const run = (args, env) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, ...env, NO_COLOR: "1" } },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, out: stdout + stderr })));

test("recall cli: up, index, recall, down against a temp home", async t => {
  const { root } = home(t, { vectors: false });
  const env = { VYRE_HOME: root };
  t.after(() => run(["down"], env));
  assert.match((await run(["up"], env)).out, /vyred running/);
  const ix = await run(["index"], env);
  assert.equal(ix.code, 0);
  assert.match(ix.out, /6 sessions/);
  const r = await run(["recall", "intake", "form"], env);
  assert.equal(r.code, 0);
  assert.match(r.out, /Harlow site rebuild/);
  assert.match(r.out, /intake form/);
  assert.match((await run(["recall", "zygomorphic"], env)).out, /nothing matching/);
  assert.match((await run(["recall"], env)).out, /6 sessions · 16 turns/);
  const ev = await run(["recall", "eval", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "recall-eval.json")], env);
  assert.equal(ev.code, 0);
  assert.match(ev.out, /14 questions/);
  assert.match(ev.out, /keyword +MRR@10 \d\.\d{3}/);
  assert.match((await run(["down"], env)).out, /vyred stopped/);
});
