// @ts-check
// The linked-folder index (core/files/linked-index.js): per person, incremental by the provider's change token, searchable by name, path and text, and never reaching across people.
// The source is the fake provider; nothing here reaches a real service.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, open } from "../store/index.js";
import { LINKED_MIGRATIONS } from "./linked.js";
import { INDEX_MIGRATIONS, linkedIndex, TEXT_CAP } from "./linked-index.js";
import { fakeProvider } from "./linked-fake.js";

const link = { id: "lnk_1", provider: "fake", source: { folder: "F1" } };

function rig(files = { "Contracts/retainer.md": "the retainer fee is five thousand", "notes.txt": "call Dana on Friday", "logo.png": "binary" }) {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lidx-")), "vyre.db"));
  migrate(db, "files", [...LINKED_MIGRATIONS, ...INDEX_MIGRATIONS]);
  const clock = { t: 1_800_000_000_000 };
  const p = fakeProvider({ files });
  // the png is not text
  for (const f of p.store.values()) if (f.path.endsWith(".png")) f.mime = "image/png";
  const idx = linkedIndex({ db, providers: new Map([["fake", p]]), now: () => clock.t });
  return { db, p, idx, clock };
}

test("the first sync lists everything, indexes names and the text of text files, and remembers the token", async () => {
  const r = rig();
  const s = await r.idx.sync(link, "per_alex");
  assert.equal(s.status, "ok"); assert.equal(s.count, 3);
  const hits = r.idx.search("per_alex", "retainer");
  assert.deepEqual(hits.map(h => h.path).sort(), ["Contracts/retainer.md"]);
  assert.equal(hits[0].link, "lnk_1");
  assert.deepEqual(r.idx.search("per_alex", "Friday").map(h => h.path), ["notes.txt"]);
  assert.equal(r.idx.search("per_alex", "logo").length, 1, "a binary is found by name");
  assert.equal(r.idx.search("per_alex", "binary").length, 0, "but its bytes are never read");
  assert.equal(r.p.calls.filter(c => c[0] === "read").length, 2, "only the two text files were fetched");
});

test("the second sync asks only for changes since the token, and fetches only what changed", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex");
  r.p.calls.length = 0;
  r.p.external.put("notes.txt", "call Dana on Monday");
  r.p.external.put("new.txt", "fresh words");
  const s = await r.idx.sync(link, "per_alex");
  assert.equal(s.count, 4);
  assert.notEqual(r.p.calls.find(c => c[0] === "list")[2], null, "a token went with it");
  assert.equal(r.p.calls.filter(c => c[0] === "read").length, 2);
  assert.equal(r.idx.search("per_alex", "Friday").length, 0, "the old text is gone");
  assert.equal(r.idx.search("per_alex", "Monday").length, 1);
});

test("a file removed at the source leaves the index", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex");
  r.p.external.remove("notes.txt");
  const s = await r.idx.sync(link, "per_alex");
  assert.equal(s.count, 2);
  assert.equal(r.idx.search("per_alex", "Friday").length, 0);
});

test("a full listing drops what the person can no longer see", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex");
  const real = r.p.list;
  r.p.list = async (_l, _p, o) => { r.p.calls.push(["list", _p, o && o.token]); return { entries: [{ id: "f1", path: "Contracts/retainer.md", name: "retainer.md", mime: "text/markdown", size: 5, modified: 1, rev: "9" }], next: "9", full: true }; };
  await r.idx.sync(link, "per_alex", { full: true });
  assert.deepEqual(r.idx.search("per_alex", "Friday"), []);
  assert.equal(r.idx.status(link.id, "per_alex").count, 1);
  r.p.list = real;
});

test("each person has their own index: one person's files never show up for another", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex");
  assert.deepEqual(r.idx.search("per_bo", "retainer"), []);
  assert.equal(r.idx.status(link.id, "per_bo"), null);
  const calls = r.p.calls.filter(c => c[0] === "list").map(c => c[1]);
  assert.deepEqual(calls, ["per_alex"], "the source was asked as the person");
});

test("a failing source records the error and keeps the token and the old index", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex");
  r.p.list = async () => { throw Object.assign(new Error("the source said no"), { code: "denied" }); };
  const s = await r.idx.sync(link, "per_alex");
  assert.equal(s.status, "error"); assert.equal(s.error, "the source said no");
  assert.equal(r.idx.search("per_alex", "retainer").length, 1);
  assert.equal(r.idx.status(link.id, "per_alex").status, "error");
});

test("text is capped, and a sync already running for the same person and link is joined, not doubled", async () => {
  const r = rig({ "big.txt": "x".repeat(TEXT_CAP + 5000) + " tailword" });
  const [a, b] = await Promise.all([r.idx.sync(link, "per_alex"), r.idx.sync(link, "per_alex")]);
  assert.deepEqual(a, b);
  assert.equal(r.p.calls.filter(c => c[0] === "list").length, 1);
  assert.equal(r.idx.search("per_alex", "tailword").length, 0, "past the cap is not indexed");
});

test("forgetting a link drops its index for every person", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex"); await r.idx.sync(link, "per_bo");
  r.idx.forget(link.id);
  assert.deepEqual(r.idx.search("per_alex", "retainer"), []);
  assert.equal(r.idx.status(link.id, "per_bo"), null);
});

test("search can be limited to one linked folder, and a query of only punctuation finds nothing instead of erroring", async () => {
  const r = rig();
  await r.idx.sync(link, "per_alex");
  assert.equal(r.idx.search("per_alex", "retainer", { link: "lnk_other" }).length, 0);
  assert.deepEqual(r.idx.search("per_alex", '"*(('), []);
});

test("a folder entry is kept as a folder (dir), so a listing can tell it from a file", async () => {
  const r = rig({});
  r.p.list = async () => ({ entries: [{ id: "d1", path: "Sub", name: "Sub", mime: "x/dir", size: 0, modified: 1, rev: "1", dir: true }], next: "1", full: true });
  await r.idx.sync(link, "per_alex");
  assert.deepEqual(r.idx.children(link.id, "per_alex", "").map(c => [c.name, c.dir]), [["Sub", true]]);
  assert.equal(r.idx.entryAt(link.id, "per_alex", "Sub").entry, "d1");
  assert.equal(r.idx.entryAt(link.id, "per_alex", "nope"), null);
});
