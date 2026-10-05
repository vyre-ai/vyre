// @ts-check
// Watcher definitions are hidden records (def-watcher), like Flow definitions, in a REAL vyred with the kernel on: an existing folder is migrated into a record once, a record edited by a person
// is written back to the folder (so the watcher shows changed and waits for a new dry run), a folder edited by Claude's skill is written into the record, a lost folder is restored from the record,
// and none of it is run state (the schedule, cursor and items stay in the module's own tables).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { tempHome, present } from "../../test/helpers.js";
import { hashOf } from "./defs.js";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1";
const SPEC = JSON.stringify({ name: "northgate-inbox", project: "northgate", schedule: "*/30 * * * *", emits: "mail.seen" });
const CODE = "export default async function watch({ emit }) { emit({ id: 'a' }); }\n";

async function world(/** @type {any} */ t) {
  const root = tempHome(t);
  const dir = path.join(root, "watchers", "northgate-inbox"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "watcher.json"), SPEC); fs.writeFileSync(path.join(dir, "watch.js"), CODE);
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  const admin = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s" });
  const cli = (/** @type {string} */ tool, input = {}) => call(tool, input, { root, caller: "cli" });
  const recs = async () => (await d.kernel.gateway.records.query(admin, "def-watcher", { page: { limit: 50 } })).rows;
  return { root, dir, d, admin, cli, recs };
}

test("an existing watcher folder becomes a record once, whatever calls sync, and the record is the whole definition", { timeout: 90_000 }, async t => {
  const { dir, cli, recs } = await world(t);
  const l = await cli("watchers.list"); assert.ok(!l.error, JSON.stringify(l));
  await cli("watchers.list"); await cli("watchers.list");
  const rows = await recs();
  assert.equal(rows.length, 1, "migrated once, not once per look");
  assert.deepEqual([rows[0].data.name, rows[0].data.project, rows[0].data.schedule, rows[0].data.hash], ["northgate-inbox", "northgate", "*/30 * * * *", hashOf(SPEC, CODE)]);
  assert.equal(rows[0].data.spec, SPEC); assert.equal(rows[0].data.code, CODE);
  assert.equal(fs.readFileSync(path.join(dir, "watcher.json"), "utf8"), SPEC, "the folder is untouched");
  // the state of the watcher (the list) is unchanged by having a record
  assert.equal((await cli("watchers.list")).data.watchers.find((/** @type {any} */ w) => w.name === "northgate-inbox").state, "draft");
});

test("a record edited by a person is written back to the folder; a folder edited by the skill is written into the record; a lost folder is restored", { timeout: 90_000 }, async t => {
  const { dir, d, admin, cli, recs } = await world(t);
  await cli("watchers.list");
  let [rec] = await recs();
  // the person edits the record (the settings)
  const spec2 = JSON.stringify({ name: "northgate-inbox", project: "northgate", schedule: "0 * * * *", emits: "mail.seen" });
  await d.kernel.gateway.records.update(admin, "def-watcher", rec.id, { spec: spec2 }, rec.version);
  await cli("watchers.list");
  assert.equal(fs.readFileSync(path.join(dir, "watcher.json"), "utf8"), spec2, "the folder follows the record");
  assert.equal((await cli("watchers.list")).data.watchers.find((/** @type {any} */ w) => w.name === "northgate-inbox").schedule, "0 * * * *");
  // the skill rewrites the code in the folder
  const code2 = CODE + "// changed by the skill\n";
  fs.writeFileSync(path.join(dir, "watch.js"), code2);
  await cli("watchers.list");
  [rec] = await recs();
  assert.equal(rec.data.code, code2, "the record follows the folder");
  assert.equal(rec.data.hash, hashOf(spec2, code2));
  // a lost folder comes back from the record
  fs.rmSync(dir, { recursive: true, force: true });
  await cli("watchers.list");
  assert.equal(fs.readFileSync(path.join(dir, "watch.js"), "utf8"), code2);
  assert.equal((await recs()).length, 1);
});

test("the definition type is hidden like Flow definitions, and a model cannot reach it through the records tools", { timeout: 90_000 }, async t => {
  const { cli, d } = await world(t);
  await cli("watchers.list");
  const types = (await cli("records.types", {})).data.types.map((/** @type {any} */ x) => x.name);
  assert.ok(!types.includes("def-watcher"), "hidden from the person's lists");
  assert.ok((await cli("records.types", { system: true })).data.types.some((/** @type {any} */ x) => x.name === "def-watcher" && x.system === true));
  assert.ok((await d.registry.call("records.list", { type: "def-watcher" }, "mcp")).error, "a model is refused");
});
