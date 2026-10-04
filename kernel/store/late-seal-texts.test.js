// Sealing a field late must leave no copy of the old values anywhere the kernel keeps free text or history: the change log, the event log, and the task texts (a form or a title that quoted a value).
// Raw bytes of the database file and its write-ahead log are searched afterwards, as in the scrub test in sqlite.test.js.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";

const SPACE = "spc_aaaaaaaaaaaa", OWNER = "per_owner";
const PLAIN = ["123-45-6789", "987-65-4321"];

test("late sealing clears the task texts that quote the old values, and no copy is left in the file", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-lateseal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  let refs = 0;
  const sealer = { api: { put: async i => ({ ref: { sealed: i.class, ref: `sv_${++refs}`, present: true, valid_format: true, set_at: 1 } }) } };
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [{ name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "ssn", kind: "text", label: "SSN", required: true }] }] });
  const a = await R.create(owner, "person", { name: "Jane", ssn: PLAIN[0] });
  const b = await R.create(owner, "person", { name: "Bob", ssn: PLAIN[1] });
  // tasks whose free text quotes a value (a title, a form), and one that does not
  const quoting = await k.gateway.ask.request(owner, { title: `Call Jane about ${PLAIN[0]}`, output: { kind: "note" }, source: "manual", doer: { kind: "person", id: OWNER, space: SPACE }, form: { note: `her number is ${PLAIN[1]} ok` } });
  const plainTask = await k.gateway.ask.request(owner, { title: "Water the plants", output: { kind: "note" }, source: "manual", doer: { kind: "person", id: OWNER, space: SPACE } });
  const rows = () => db.prepare("SELECT task, text FROM kernel_task_texts").all();
  assert.ok(rows().some(r => r.text.includes(PLAIN[0])), "the text is stored before the seal");
  const out = await k.gateway.migrate.sealField(owner, { type: "person", field: "ssn", class: "us-ssn" });
  assert.equal(out.moved, 2);
  assert.equal(rows().some(r => PLAIN.some(p => r.text.includes(p))), false, "no task text quotes a value any more");
  assert.ok(rows().some(r => r.task === plainTask.id), "a task that quoted nothing keeps its text");
  // a restart: the value is in no task (the log's text hash resolves to nothing) and in no event
  db.close();
  const db2 = new DatabaseSync(file);
  const again = await bootKernel({ db: db2, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer });
  const chain2 = again.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  assert.equal(JSON.stringify(await again.gateway.ask.list(chain2, {})).includes(PLAIN[0]), false, "no task shows a value after a restart");
  assert.equal(JSON.stringify(again.log.read()).includes(PLAIN[0]), false, "no event holds a value");
  db2.close();
  const bytes = fs.readFileSync(file, "latin1") + (fs.existsSync(file + "-wal") ? fs.readFileSync(file + "-wal", "latin1") : "");
  for (const p of PLAIN) assert.equal(bytes.includes(p), false, `${p} is not anywhere in the file or its log`);
  void a; void b; void quoting;
});

test("SC-1: the task texts that quote a sealed value in another spelling are cleared too (case, spacing, no-break and zero-width characters, punctuation, split over two fields), and every task about the record loses its text", async t => {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "vyre-lateseal2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kernel.db");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const sealer = { api: { put: async i => ({ ref: { sealed: i.class, ref: "sv_1", present: true, valid_format: true, set_at: 1 } }) } };
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7), sealer });
  const owner = k.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: OWNER, path: "direct", session: "s" });
  const R = k.gateway.records;
  await R.define(owner, { add_types: [{ name: "person", label: "Person", fields: [{ name: "name", kind: "text", label: "Name", required: true }, { name: "legal", kind: "text", label: "Legal name", required: true }] }] });
  const rec = await R.create(owner, "person", { name: "Ana", legal: "Ana Maria Lopez" });
  const mk = (title, form, record) => k.gateway.ask.request(owner, { title, output: { kind: "note" }, source: "manual", doer: { kind: "person", id: OWNER, space: SPACE }, ...(form ? { form } : {}), ...(record ? { record } : {}) });
  const quoting = [
    await mk("ana maria lopez needs a call"),
    await mk("ANA  MARIA   LOPEZ"),
    await mk("Ana Maria Lopez"),
    await mk("Ana​ Maria Lopez"),
    await mk("x", { note: "Ana-Maria Lopez." }),
    await mk("y", { first: "Ana Maria", last: "Lopez" }),
    await mk("Follow up (nothing quoted)", undefined, `vyre://${SPACE}/person/${rec.id}`),
  ];
  const keep = await mk("Water the plants");
  const rows = () => db.prepare("SELECT task, text FROM kernel_task_texts").all();
  assert.ok(quoting.every(q => rows().some(r => r.task === q.id)), "every text is stored before the seal");
  const out = await k.gateway.migrate.sealField(owner, { type: "person", field: "legal", class: "legal-name" });
  assert.match(out.task_texts_note, /not searched/, "the answer says what is not covered");
  assert.ok(out.task_texts_cleared >= quoting.length, `the result says what was cleared (${out.task_texts_cleared})`);
  for (const q of quoting) assert.equal(rows().some(r => r.task === q.id), false, `task "${q.title}" lost its text`);
  assert.ok(rows().some(r => r.task === keep.id), "an unrelated task keeps its text");
  db.close();
});
