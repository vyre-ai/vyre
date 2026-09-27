// @ts-check
// `vyre recall` as a person and a surface run it: the real bin/vyre in a child process, against a
// vyred in this process in a temp home whose Recall index holds the synthetic corpus
// (test/fixtures). Vectors are off in config.json, so nothing loads a model or touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { open } from "../../store/index.js";
import { seedRecall } from "../../../test/fixtures/corpus.js";
import { tempHome } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, stdout: string, out: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, stdout, out: stdout + stderr })));
const framesOf = s => s.trim().split("\n").map(l => JSON.parse(l));

test("recall cli: vyre commands lists search, status, setup and eval", async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "recall", "--json"]);
  assert.equal(r.code, 0, r.out);
  const row = JSON.parse(r.stdout).commands[0];
  assert.deepEqual(row.verbs.map(v => v.verb), ["search", "status", "setup", "eval"]);
  for (const v of ["search", "status", "setup", "eval"]) assert.ok(row.usage.includes(v), row.usage);
  const search = row.verbs[0];
  assert.equal(search.read, true);
  assert.deepEqual(search.args, [{ name: "query", required: true, repeat: true }]);
  assert.deepEqual(search.flags.map(f => f.name), ["limit", "here", "user", "assistant", "keyword"]);
  assert.deepEqual(row.verbs[3].flags, [{ name: "k", value: "n" }]);
  const index = JSON.parse((await run(root, ["commands", "index", "--json"])).stdout).commands[0];
  assert.deepEqual(index.verbs, []);
});

test("recall cli: status and search as words and as --view frames, with --json's data", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ transcripts: [path.join(root, "no-transcripts")], vault: { keystore: "file" },
    recall: { vectors: false }, modules: { disable: ["learn", "memory"] } }));
  const db = open(path.join(root, "vyre.db"));
  seedRecall(db);
  db.close();
  const d = await start({ root, log: () => {} });
  t.after(() => d.stop());
  const vyre = (/** @type {string[]} */ ...args) => run(root, args);

  // Bare, `status` alone: the status. `status` with more words searches for them.
  const bare = JSON.parse((await vyre("recall", "--json")).stdout);
  assert.ok(bare.sessions > 0, JSON.stringify(bare));
  assert.deepEqual(JSON.parse((await vyre("recall", "status", "--json")).stdout).sessions, bare.sessions);
  assert.match((await vyre("recall", "status")).out, /sessions · \d+ turns indexed/);

  // `search <query>` is the bare query.
  const hits = JSON.parse((await vyre("recall", "Northwind", "invoices", "--json")).stdout);
  assert.ok(hits.length > 0);
  assert.deepEqual(JSON.parse((await vyre("recall", "search", "Northwind", "invoices", "--json")).stdout).map(h => h.session), hits.map(h => h.session));
  assert.match((await vyre("recall", "search", "Northwind", "invoices")).out, /Northwind invoices/);
  const empty = await vyre("recall", "search");
  assert.equal(empty.code, 2, empty.out);
  assert.match(empty.out, /vyre recall search needs what to look for/);

  const sv = await vyre("recall", "status", "--view");
  assert.equal(sv.code, 0, sv.out);
  const sf = framesOf(sv.stdout);
  assert.equal(sf[0].view.kind, "card");
  assert.equal(sf[0].view.title, "Recall");
  assert.deepEqual(sf[0].view.fields.slice(0, 2).map(f => f.label), ["Sessions", "Turns"]);
  assert.deepEqual(sf[0].data, bare);
  assert.deepEqual(sf[sf.length - 1], { v: 1, done: true, exit: 0 });

  const qv = await vyre("recall", "search", "Northwind", "invoices", "--view");
  assert.equal(qv.code, 0, qv.out);
  const qf = framesOf(qv.stdout);
  assert.equal(qf[0].cmd, "recall search");
  assert.equal(qf[0].view.kind, "table");
  assert.deepEqual(qf[0].view.columns.map(c => c.key), ["name", "role", "when", "snippet", "id"]);
  assert.deepEqual(qf[0].data, hits, "the frame's data is what --json prints");
  assert.deepEqual(qf[0].view.rows.map(r => r.id), hits.map(h => h.session), "each row keeps the session id --resume takes");
  assert.ok(qf[0].view.rows.every(r => !/[«»]/.test(r.snippet)), "the match marks are for the terminal");
  assert.deepEqual(qf[qf.length - 1], { v: 1, done: true, exit: 0 });
});
