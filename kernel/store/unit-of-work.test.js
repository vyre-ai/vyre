// A record write and its event commit together or not at all (one transaction, one fsync): a kill between what used to be two commits leaves neither, an event the database refuses takes the
// record with it and memory agrees with the disk, and a write that was acknowledged survives a kill.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { SCRATCH } from "../../test/scratch.mjs";
import { bootKernel } from "../boot.js";
import { CONTACT } from "../conformance/suite.js";

const SPACE = "spc_crashtest001", OWNER = "per_owner";
const dir = () => fs.mkdtempSync(path.join(SCRATCH, "vyre-unit-"));
const chainOf = k => k.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s1" });

test("a kill between the record's change and its event leaves neither; the acknowledged write before it is intact", () => {
  const d = dir(), file = path.join(d, "kernel.db");
  try {
    const child = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), "unit-crash.child.mjs"), file], { encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", `the child was killed mid-write: ${child.stderr}`);
    assert.match(child.stdout, /^acked /, "the first write was acknowledged");
    assert.doesNotMatch(child.stdout, /survived/);
    const db = new DatabaseSync(file);
    const names = db.prepare("SELECT json_extract(data, '$.name') AS n FROM kernel_records WHERE type = 'contact'").all().map(r => r.n);
    assert.deepEqual(names, ["Acknowledged"], "the killed write's record is not there");
    const events = db.prepare("SELECT count(*) AS c FROM kernel_events WHERE type = 'contact.created'").get().c;
    assert.equal(events, 1, "and neither is its event");
    const changes = db.prepare("SELECT count(*) AS c FROM kernel_changes WHERE json_extract(entry, '$.type') = 'contact'").get().c;
    assert.equal(changes, 1, "nor its change entry");
    db.close();
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("an event the database refuses takes the record with it: the caller is told, memory and disk agree, and the same write works afterwards", async t => {
  const d = dir(), file = path.join(d, "kernel.db");
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;");
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7) });
  const R = k.gateway.records, chain = chainOf(k);
  await R.define(chain, { add_types: [{ ...CONTACT, fields: [...CONTACT.fields.filter(f => f.name !== "email"), { name: "email", kind: "text", label: "Email", unique: true }] }] });
  const a = await R.create(chain, "contact", { name: "Kept", email: "kept@example.test" });
  const seq = () => k.log.latestSeq();
  const before = { seq: seq(), changes: db.prepare("SELECT count(*) AS c FROM kernel_changes").get().c };
  db.exec("CREATE TRIGGER refuse BEFORE INSERT ON kernel_events WHEN new.type LIKE 'contact.%' BEGIN SELECT RAISE(ABORT, 'refused'); END");
  // a create, an update and a remove whose events are refused
  await assert.rejects(() => R.create(chain, "contact", { name: "Ghost", email: "ghost@example.test" }), e => e instanceof Error);
  await assert.rejects(() => R.update(chain, "contact", a.id, { name: "Changed", email: "changed@example.test" }, a.version), e => e instanceof Error);
  await assert.rejects(() => R.remove(chain, "contact", a.id, a.version), e => e instanceof Error);
  db.exec("DROP TRIGGER refuse");
  assert.equal(db.prepare("SELECT count(*) AS c FROM kernel_changes").get().c, before.changes, "no change entries were kept");
  assert.equal(db.prepare("SELECT count(*) AS c FROM kernel_records WHERE type = 'contact'").get().c, 1);
  const now = await R.get(chain, "contact", a.id);
  assert.equal(now.data.name, "Kept", "memory shows the old row");
  assert.equal(now.version, a.version);
  assert.equal(now.deleted_at, undefined, "the remove did not stick in memory");
  // the unique values the refused writes held are free again, and the same writes now succeed
  const ghost = await R.create(chain, "contact", { name: "Ghost", email: "ghost@example.test" });
  const changed = await R.update(chain, "contact", a.id, { name: "Changed", email: "changed@example.test" }, a.version);
  assert.equal(changed.version, a.version + 1);
  assert.ok(ghost.id);
  // a fresh kernel on the same file agrees with the live one
  const again = await bootKernel({ db: new DatabaseSync(file), space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7) });
  const list = await again.gateway.records.query(chainOf(again), "contact", { page: { limit: 10 }, sort: [{ field: "name", dir: "asc" }] });
  assert.deepEqual(list.rows.map(r => r.data.name), ["Changed", "Ghost"]);
});

test("concurrent writers take turns inside the unit: every acknowledged write has its event, none is lost or doubled", async t => {
  const d = dir(), file = path.join(d, "kernel.db");
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;");
  const k = await bootKernel({ db, space: SPACE, owner: OWNER, owner_uid: 501, key: Buffer.alloc(32, 7) });
  const R = k.gateway.records, chain = chainOf(k);
  await R.define(chain, { add_types: [CONTACT] });
  const ids = await Promise.all(Array.from({ length: 60 }, async (_, i) => { const r = await R.create(chain, "contact", { name: `C${i}` }); await R.update(chain, "contact", r.id, { age: i }, r.version); return r.id; }));
  assert.equal(new Set(ids).size, 60);
  assert.equal(db.prepare("SELECT count(*) AS c FROM kernel_events WHERE type = 'contact.created'").get().c, 60);
  assert.equal(db.prepare("SELECT count(*) AS c FROM kernel_events WHERE type = 'contact.updated'").get().c, 60);
  assert.equal(db.prepare("SELECT count(*) AS c FROM kernel_changes").get().c, 120);
  assert.deepEqual(k.log.verify().ok, true, "the hash chain is intact");
});
