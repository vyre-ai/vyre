// @ts-check
// `vyre learn --json`: every read and change prints one JSON value, and a mistake prints
// {"error":...} with the same exit code the words would have. The real bin/vyre in a child
// process, against a vyred in this process in a temp home, with `present` as its verifier so
// accepting and relaxing need no dialog. The human output is covered in test/cli.test.js.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../../daemon/index.js";
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
