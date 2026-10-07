// @ts-check
// `vyre roll`: the real bin/vyre in a child process against a vyred in a temp home that indexed a session in this folder. The `claude` it starts is a stub that
// records what it was given, so what is under test is the seed, the fresh session id and the hand-over, not Claude Code.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { call } from "../../daemon/client.js";
import { tempHome } from "../../../test/helpers.js";
import { firstMessage, newest, INLINE_BYTES } from "./roll.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string, out: string }>} */
const run = (root, cwd, args, env = {}) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1", ...env }, timeout: 60_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout, out: stdout + stderr })));

const line = (type, cwd, message, n) => JSON.stringify({ type, cwd, timestamp: new Date(1e12 + n * 60_000).toISOString(), message });

/** A home whose Recall holds one session that ran in `work`, and a `claude` that writes its arguments to a file. */
async function world(t, { turns = 4, pad = "" } = {}) {
  const root = fs.realpathSync(tempHome(t));
  const work = path.join(root, "work", "bakery");
  fs.mkdirSync(work, { recursive: true });
  const dir = path.join(root, "transcripts", work.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  const id = "aaaaaaaa-1111-4000-8000-000000000001";
  const lines = [];
  for (let i = 0; i < turns; i++) {
    lines.push(i % 2 === 0 ? line("user", work, { role: "user", content: `request ${i}: fix the bakery menu page ${pad}` }, i)
      : line("assistant", work, { role: "assistant", content: [{ type: "text", text: `done ${i}: the bakery menu page is fixed` }] }, i));
    if (i === 1) lines.push(line("assistant", work, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: path.join(work, "menu.tsx") } }] }, i));
  }
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), lines.join("\n") + "\n");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "transcripts")], recall: { every: 0, vectors: false }, vault: { keystore: "file" } }));
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  await call("recall.index", {}, { root });
  const log = path.join(root, "claude-args.json");
  // `claude` on PATH: a stub that records its arguments (the Harness plugin's --plugin-dir is dropped from them: VYRE_HARNESS_DIR names none here).
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const stub = path.join(bin, "claude");
  fs.writeFileSync(stub, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));\n`);
  fs.chmodSync(stub, 0o755);
  return { root, work, id, log, stub, bin, d };
}

test("roll: the first message is the seed itself when it fits, else a line naming the file that holds it; the newest session is a person's and not a subagent", () => {
  const seed = "[Vyre continuation: x\n]";
  assert.ok(firstMessage(seed, null).startsWith(seed));
  assert.match(firstMessage(seed, null), /<vyre-roll>.*wait for what the person says next\.<\/vyre-roll>$/s);
  const f = firstMessage(seed, "/h/rolls/n.md");
  assert.ok(!f.includes("[Vyre continuation"));
  assert.match(f, /^<vyre-roll>.*Read \/h\/rolls\/n\.md first/s);
  assert.ok(INLINE_BYTES < 128_000, "under an argument's limit");
  assert.equal(newest([{ id: "p/agent-1" }, { id: "s2", human: 0 }, { id: "s3", human: 1 }, { id: "s4" }])?.id, "s3");
  assert.equal(newest([]), null);
});

test("roll: --print gives the seed for this folder's newest session, and builds nothing else", async t => {
  const w = await world(t);
  const r = await run(w.root, w.work, ["roll", "--print"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.stdout, /^\[Vyre continuation:/);
  assert.match(r.stdout, /Most recent, word for word/);
  assert.match(r.stdout, /request 0: fix the bakery menu page/);
  assert.match(r.stdout, /done 3: the bakery menu page is fixed/);
  assert.match(r.stdout, /\n\]\n$/);
  assert.equal(fs.existsSync(w.log), false, "claude was not started");
});

test("roll: it starts claude in the folder under a fresh session id with the seed as the first message, and a later roll reaches back through this one", async t => {
  const w = await world(t);
  const r = await run(w.root, w.work, ["roll"], { PATH: `${w.bin}:${process.env.PATH}`, VYRE_HARNESS_DIR: path.join(w.root, "no-harness") });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /rolling aaaaaaaa into a fresh window \(1 window, \d+ turns carried word for word\)/);
  const got = JSON.parse(fs.readFileSync(w.log, "utf8"));
  assert.equal(got.cwd, fs.realpathSync(w.work));
  assert.equal(got.argv[0], "--session-id");
  assert.match(got.argv[1], /^[0-9a-f-]{36}$/);
  assert.notEqual(got.argv[1], w.id);
  assert.match(got.argv[2], /^\[Vyre continuation:/);
  assert.match(got.argv[2], /request 0: fix the bakery menu page/);
  assert.match(got.argv[2], /\n\]\n\n<vyre-roll>/);
  // The record: a roll out of the fresh session names this one as the window before.
  const again = await call("threads.roll-session", { session: got.argv[1], cwd: w.work }, { root: w.root });
  assert.equal(again.error, undefined, JSON.stringify(again));
  assert.equal(again.data.windows, 2, "the chain reaches back through the first roll");
  assert.notEqual(again.data.session, got.argv[1]);
});

test("roll: with --file the seed goes in a file the first message names (what a seed too big for an argument does); --no-start writes it and says how to start", async t => {
  const w = await world(t);
  const big = await run(w.root, w.work, ["roll", "--file"], { PATH: `${w.bin}:${process.env.PATH}`, VYRE_HARNESS_DIR: path.join(w.root, "no-harness") });
  assert.equal(big.code, 0, big.out);
  const got = JSON.parse(fs.readFileSync(w.log, "utf8"));
  const file = path.join(w.root, "rolls", `${got.argv[1]}.md`);
  assert.ok(fs.existsSync(file), "the seed is written under the home");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(file, "utf8"), /^\[Vyre continuation:[\s\S]*request 0: fix the bakery menu page/);
  assert.match(got.argv[2], new RegExp(`^<vyre-roll>.*Read ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} first`, "s"));
  assert.ok(!got.argv[2].includes("[Vyre continuation"), "the argument itself is short");
  fs.rmSync(w.log);
  const n = await run(w.root, w.work, ["roll", "--no-start", "--json"], { PATH: `${w.bin}:${process.env.PATH}`, VYRE_HARNESS_DIR: path.join(w.root, "no-harness") });
  assert.equal(n.code, 0, n.out);
  const j = JSON.parse(n.stdout);
  assert.equal(j.from, w.id);
  assert.match(j.start, /^claude --session-id /);
  assert.ok(fs.existsSync(j.file));
  assert.equal(fs.existsSync(w.log), false, "nothing started");
});

test("roll: no session in the folder, an unknown --session or --thread, and a stray word are said plainly", async t => {
  const w = await world(t);
  const elsewhere = path.join(w.root, "work", "other");
  fs.mkdirSync(elsewhere, { recursive: true });
  const none = await run(w.root, elsewhere, ["roll"]);
  assert.equal(none.code, 1);
  assert.match(none.out, /no session of yours found in .*other/);
  assert.equal((await run(w.root, w.work, ["roll", "--print", "--session", "nope-nope"])).code, 1);
  const thread = await run(w.root, w.work, ["roll", "--thread", "no-such-thread"]);
  assert.equal(thread.code, 1);
  assert.match(thread.out, /no thread no-such-thread/);
  const word = await run(w.root, w.work, ["roll", "now"]);
  assert.equal(word.code, 2);
  assert.match(word.out, /vyre roll takes flags, not words/);
});
