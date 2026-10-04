// @ts-check
// `vyre learn --json`: every read and change prints one JSON value, and a mistake prints
// {"error":...} with the same exit code the words would have. The real bin/vyre in a child
// process, against a vyred in this process in a temp home, with `present` as its verifier so
// accepting and relaxing need no dialog. The human output is covered in test/cli.test.js.

import "../../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
import { open } from "../../store/index.js";
import { tempHome, present } from "../../../test/helpers.js";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "bin", "vyre");

/** @returns {Promise<{ code: number, out: string, err: string }>} */
const run = (root, args) => new Promise(resolve =>
  execFile(process.execPath, [BIN, ...args], { env: { ...process.env, VYRE_HOME: root, NO_COLOR: "1", VYRE_NO_DIALOGS: "1" }, timeout: 30_000 },
    (err, stdout, stderr) => resolve({ code: err ? Number(/** @type {any} */ (err).code ?? 1) : 0, out: stdout, err: stderr })));

test("learn --json: show, stats, signals, skills, level and scope print one JSON value each", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file" }, modules: { disable: ["recall", "memory"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const j = async (...args) => {
    const r = await run(root, [...args, "--json"]);
    assert.equal(r.out.trim().split("\n").length, 1, `one line of JSON for ${args.join(" ")}: ${r.out}${r.err}`);
    return { code: r.code, data: JSON.parse(r.out) };
  };

  const added = await j("learn", "add", "never", "use", "em", "dashes");
  assert.equal(added.code, 0);
  const id = added.data.id;
  assert.ok(Number.isInteger(id));

  const show = await j("learn", "show", String(id));
  assert.equal(show.code, 0);
  assert.equal(show.data.id, id);
  assert.equal(show.data.status, "active");
  assert.ok("stats" in show.data, "show carries the lesson's effect");

  const stats = await j("learn", "stats");
  assert.deepEqual(stats.data.map(x => x.id), [id]);
  assert.ok("stats" in stats.data[0]);

  const signals = await j("learn", "signals");
  assert.ok(Array.isArray(signals.data.counts) && Array.isArray(signals.data.jobs), JSON.stringify(signals.data));

  const skills = await j("learn", "skills");
  assert.deepEqual(skills.data.skills, []);
  const noSkill = await j("learn", "skills", "show", "3");
  assert.equal(noSkill.code, 1);
  assert.deepEqual(noSkill.data.error, { code: "not_found", message: "no skill 3" });

  const up = await j("learn", "level", String(id), "block");
  assert.equal(up.data.level, "block");
  const down = await j("learn", "level", String(id), "remind");
  assert.equal(down.data.level, "remind", "lowering is learn.relax, with the person's proof");

  const scoped = await j("learn", "scope", String(id), "agent", "kit");
  assert.deepEqual(scoped.data.scope, { agent: "kit" });
  const wide = await j("learn", "scope", String(id), "all");
  assert.equal(wide.data.scope, "all");
  const sideways = await j("learn", "scope", String(id), "sideways");
  assert.equal(sideways.code, 1);
  assert.equal(sideways.data.error.code, "bad_input");
  const relax = await j("learn", "relax", String(id), "sideways");
  assert.equal(relax.code, 1);
  assert.match(relax.data.error.message, /^vyre learn relax <id>/);

  const missing = await j("learn", "show", "9");
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.data.error, { code: "not_found", message: "no lesson 9" });
  assert.equal((await j("learn", "show", "x")).code, 2);

  // The words are as they were.
  const human = await run(root, ["learn", "show", "9"]);
  assert.equal(human.out.trim(), "no lesson 9");
  assert.match((await run(root, ["learn", "stats"])).out, /never use em dashes|Never use em dashes/);
});

test("learn skills: dismiss says no to a proposed skill, retire removes an installed one's file", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file" }, modules: { disable: ["recall", "memory"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  // Two proposed skills, as learn's own propose() writes them after three clean sessions.
  const db = open(path.join(root, "vyre.db"));
  const put = db.prepare(`INSERT INTO learn_skills (name, scope, status, body, hash, path, source, sessions, created, updated)
    VALUES (?, '"all"', 'proposed', ?, NULL, NULL, '{"kind":"template"}', 3, ?, ?)`);
  for (const name of ["learned-ship", "learned-bake"]) put.run(name, `---\nname: ${name}\ndescription: Use when ${name.slice(8)}ing.\n---\n\n1. Do it.\n`, Date.now(), Date.now());
  db.close();
  const vyre = (...args) => run(root, args);

  const listed = JSON.parse((await vyre("learn", "skills", "--json")).out);
  assert.deepEqual(listed.skills.map(s => [s.id, s.status]), [[1, "proposed"], [2, "proposed"]]);

  const dismissed = await vyre("learn", "skills", "dismiss", "1");
  assert.equal(dismissed.code, 0, dismissed.out + dismissed.err);
  assert.match(dismissed.out, /dismissed skill 1/);
  const again = await vyre("learn", "skills", "dismiss", "1", "--json");
  assert.equal(again.code, 1);
  assert.match(JSON.parse(again.out).error.message, /skill 1 is dismissed/);

  const installed = JSON.parse((await vyre("learn", "skills", "install", "2", "--agent", "kit", "--json")).out);
  assert.equal(installed.status, "installed");
  assert.ok(installed.path.startsWith(fs.realpathSync(root)) || installed.path.startsWith(root), installed.path);
  assert.ok(fs.existsSync(installed.path));
  const retired = JSON.parse((await vyre("learn", "skills", "retire", "2", "--json")).out);
  assert.equal(retired.status, "retired");
  assert.equal(fs.existsSync(installed.path), false, "retiring removes the skill's file");
  assert.match((await vyre("learn", "skills", "retire", "2")).err + (await vyre("learn", "skills", "retire", "2")).out, /skill 2 is retired/);

  const shown = JSON.parse((await vyre("learn", "skills", "show", "1", "--json")).out);
  assert.equal(shown.status, "dismissed");

  const noId = await vyre("learn", "skills", "retire");
  assert.equal(noId.code, 2);
  assert.match(noId.out + noId.err, /vyre learn skills retire <id>/);
  assert.match(noId.out + noId.err, /vyre learn lists them with their numbers/);
  assert.equal((await vyre("learn", "skills", "dismiss", "x")).code, 2);
});

test("learn cli: vyre commands lists every verb run() handles, without vyred", async t => {
  const root = tempHome(t);
  const r = await run(root, ["commands", "learn", "--json"]);
  assert.equal(r.code, 0, r.err);
  const verbs = JSON.parse(r.out).commands[0].verbs;
  assert.deepEqual(verbs.map(v => v.verb), ["list", "show", "add", "accept", "retire", "level", "scope", "relax", "stats", "signals", "skills"]);
  assert.deepEqual(verbs.filter(v => v.person).map(v => v.verb), ["accept", "retire", "level", "scope", "relax", "skills"]);
  assert.deepEqual(verbs.filter(v => v.read).map(v => v.verb), ["list", "show", "stats", "signals"]);
  assert.deepEqual(verbs.find(v => v.verb === "level").args, [{ name: "id", required: true }, { name: "choice", required: true, choices: ["remind", "ask", "block"] }]);
});

test("learn cli: --view draws lessons and signals as tables and one lesson as a card, with the data --json prints", async t => {
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", transcripts: [], vault: { keystore: "file" }, modules: { disable: ["recall", "memory"] } }));
  const d = await start({ root, presence: present, log: () => {} });
  t.after(() => d.stop());
  const frames = s => s.trim().split("\n").map(l => JSON.parse(l));
  const id = JSON.parse((await run(root, ["learn", "add", "always", "run", "the", "tests", "--json"])).out).id;

  const l = await run(root, ["learn", "list", "--view"]);
  assert.equal(l.code, 0, l.err);
  const f = frames(l.out);
  assert.deepEqual([f[0].cmd, f[0].view.kind, f[0].view.title], ["learn list", "table", "Lessons"]);
  assert.deepEqual(f[0].view.columns.map(c => c.key), ["id", "rule", "level", "status", "effect"]);
  assert.deepEqual(f[0].view.rows.map(r => r.id), [id]);
  assert.deepEqual(f[0].data, JSON.parse((await run(root, ["learn", "--json"])).out));
  assert.deepEqual(f.at(-1), { v: 1, done: true, exit: 0 });

  const s = frames((await run(root, ["learn", "show", String(id), "--view"])).out);
  assert.deepEqual([s[0].view.kind, s[0].view.title, s[0].view.state], ["card", `Lesson ${id}`, "ok"]);
  assert.equal(s[0].data.id, id);
  const g = frames((await run(root, ["learn", "signals", "--view"])).out);
  assert.deepEqual(g[0].view.columns.map(c => c.key), ["kind", "n"]);
  assert.deepEqual(g[0].data, JSON.parse((await run(root, ["learn", "signals", "--json"])).out));
});
