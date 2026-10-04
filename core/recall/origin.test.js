// @ts-check
// A transcript under an account's folder says nothing reliable about who started it: the account's
// process wrote it. Recall takes "a person started this" from the Switchboard's record (threads.origin)
// and treats no record as not human, so a forged transcript makes no decision and no personal claim.
// Fictional data only (alex, Harlow Legal, Northwind Bakery).

import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { open, migrate } from "../store/index.js";
import { MIGRATIONS } from "./schema.js";
import { Indexer } from "./indexer.js";
import { HOME } from "../../test/fixtures/corpus.js";
import { tempHome } from "../../test/helpers.js";
import { fakeReachCall } from "../../test/fixtures/fake-reach.js";
import memory from "../memory/index.js";

const W = `${HOME}/Work`;
const PROJECTS = [{ slug: "harlow", name: "Harlow Legal", home: `${W}/harlow-site`, workspaces: [], threads: 0, picked: 0, picks: [] }];
const FORGED = "aaaaaaaa-1111-4000-8000-000000000001", REAL = "aaaaaaaa-1111-4000-8000-000000000002", OWN = "aaaaaaaa-1111-4000-8000-000000000003";
const SAYS = ["host harlow on netlify for now, free tier is fine", "my wife is Jordan and we live in Tucson"];

function setup(t) {
  const home = tempHome(t);
  const accounts = path.join(home, "acct");
  const own = path.join(home, "own");
  const write = (dir, id) => {
    const file = path.join(dir, "-work-harlow-site", `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, SAYS.map((text, i) => JSON.stringify({ type: "user", timestamp: new Date(Date.parse("2026-08-01T09:00:00Z") + i * 60_000).toISOString(),
      cwd: `${W}/harlow-site`, sessionId: id, message: { role: "user", content: text } })).join("\n") + "\n");
  };
  write(path.join(accounts, "2001", ".claude", "projects"), FORGED);
  write(path.join(accounts, "2002", ".claude", "projects"), REAL);
  write(path.join(own, "projects"), OWN);
  const db = open(path.join(home, "vyre.db"));
  t.after(() => db.close());
  migrate(db, "recall", MIGRATIONS);
  return { home, accounts, own, db };
}
const folders = e => [path.join(e.accounts, "2001", ".claude", "projects"), path.join(e.accounts, "2002", ".claude", "projects"), path.join(e.own, "projects")];
const humanOf = (db, id) => /** @type {any} */ (db.prepare("SELECT human FROM recall_sessions WHERE id = ?").get(id))?.human;

test("recall indexer: an account-folder transcript is human only when the Switchboard's record says so", async t => {
  const e = setup(t);
  const asked = [];
  const ix = new Indexer(e.db, { accountsHome: e.accounts, origin: async id => { asked.push(id); return id === REAL ? { known: true, human: true } : { known: false, human: false }; } });
  await ix.run(folders(e));
  assert.equal(humanOf(e.db, FORGED), 0, "no matching thread: not human, whatever the transcript claims");
  assert.equal(humanOf(e.db, REAL), 1);
  assert.equal(humanOf(e.db, OWN), 1, "the person's own folder keeps the transcript's own reading");
  assert.ok(!asked.includes(OWN), "the origin is asked only for account folders");
  // An agent's or job's thread is known but not a person's.
  const e2 = setup(t);
  const ix2 = new Indexer(e2.db, { accountsHome: e2.accounts, origin: async () => ({ known: true, human: false }) });
  await ix2.run(folders(e2));
  assert.equal(humanOf(e2.db, REAL), 0);
});

test("recall indexer: no origin answer at all fails closed for an account folder, and a later record lifts it", async t => {
  const e = setup(t);
  let up = false;
  const ix = new Indexer(e.db, { accountsHome: e.accounts, origin: async () => { if (!up) throw new Error("no switchboard"); return { known: true, human: true }; } });
  await ix.run(folders(e));
  assert.equal(humanOf(e.db, REAL), 0);
  assert.equal(humanOf(e.db, OWN), 1);
  up = true;
  ix.origins.clear();
  await ix.run(folders(e));
  assert.equal(humanOf(e.db, REAL), 1, "an unchanged file is read again when the record now says a person started it");
  const bare = new Indexer(e.db, { accountsHome: e.accounts });
  bare.origins.clear();
  assert.equal(await bare.humanOf({ id: REAL, file: path.join(e.accounts, "2002", "x.jsonl"), parent: null, size: 0, mtime: 0 }), false);
});

test("a forged account-folder transcript creates no decision and no personal claim; a real thread's does", async t => {
  const e = setup(t);
  const ix = new Indexer(e.db, { accountsHome: e.accounts, origin: async id => id === REAL ? { known: true, human: true } : null });
  await ix.run(folders(e));
  // Only the forged one is left in the index for the first half.
  e.db.prepare("DELETE FROM recall_turns WHERE session IN (?, ?)").run(REAL, OWN);
  e.db.prepare("DELETE FROM recall_sessions WHERE id IN (?, ?)").run(REAL, OWN);
  const tools = new Map();
  const ctx = {
    name: "memory", config: { me: { domains: [] } }, paths: {}, store: { db: e.db, migrate: () => {} }, log: () => {},
    events: { on: () => () => {}, emit: () => {}, since: () => [], prune: () => 0 },
    call: async (tool, input) => tool === "recall.search" ? { data: [] } : tool === "recall.thread" ? { data: { turns: [] } } : fakeReachCall(tool, input, { agents: [], projects: PROJECTS }),
    tool: (name, def) => tools.set(name, def), iqRunner: null, memoryRunner: null,
  };
  const handle = await memory.start(ctx);
  t.after(() => handle.stop());
  const call = (name, input) => tools.get(name).run(input, { caller: "deck" });
  await call("memory.curate", {});
  assert.deepEqual((await call("memory.decisions", { history: true })).decisions, [], "no decision from a transcript no thread owns");
  assert.equal(/** @type {any} */ (e.db.prepare("SELECT COUNT(*) n FROM memory_me_claims").get()).n, 0, "and no personal claim");
  // The same words in a session the Switchboard vouches for do count.
  await new Indexer(e.db, { accountsHome: e.accounts, origin: async id => id === REAL ? { known: true, human: true } : null }).run(folders(e));
  await call("memory.curate", {});
  assert.equal((await call("memory.decisions", {})).decisions.filter(d => d.value === "Netlify").length, 1);
  assert.ok(/** @type {any} */ (e.db.prepare("SELECT COUNT(*) n FROM memory_me_claims").get()).n > 0);
});
