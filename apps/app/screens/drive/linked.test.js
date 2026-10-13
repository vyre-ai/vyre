// @ts-check
// Files > Linked in the app: the words, the names and paths, and the calls to the box. The screen holds no logic of its own beyond these.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);
const NOW = 1_800_000_000_000;

test("a folder's name becomes a link name the box accepts, and the empty name still has one", { skip: !strip }, async () => {
  const m = await import("./linked-model.ts");
  assert.equal(m.suggestName("Client docs"), "Client-docs");
  assert.equal(m.suggestName("  Ünïcode / 2026: plans!  "), "n-code-2026-plans");
  assert.equal(m.suggestName("---"), "Linked");
  assert.equal(m.suggestName("a".repeat(100)).length, 64);
  assert.ok(m.nameProblem("Client-docs") === "" && m.nameProblem("a b") !== "" && m.nameProblem("") !== "" && m.nameProblem("../x") !== "");
});

test("a sync reads as a line: not yet, how many and when, or the source's own reason", { skip: !strip }, async () => {
  const m = await import("./linked-model.ts");
  assert.equal(m.syncLine(null, NOW), "Not synced yet");
  assert.equal(m.syncLine({ status: "ok", count: 1, at: NOW - 30_000 }, NOW), "1 item, synced just now");
  assert.equal(m.syncLine({ status: "ok", count: 12, at: NOW - 5 * 60_000 }, NOW), "12 items, synced 5 minutes ago");
  assert.equal(m.syncLine({ status: "ok", count: 12, at: NOW - 3 * 3_600_000 }, NOW), "12 items, synced 3 hours ago");
  assert.equal(m.syncLine({ status: "error", count: 4, error: "your Google account is not allowed", at: NOW }, NOW), "Could not sync: your Google account is not allowed");
});

test("a path in the box's answers (Linked/<name>/a/b) is the path the tools take (a/b)", { skip: !strip }, async () => {
  const m = await import("./linked-model.ts");
  assert.equal(m.pathIn("Docs", "Linked/Docs/a/b.txt"), "a/b.txt");
  assert.equal(m.pathIn("Docs", "Linked/Docs"), "");
  assert.deepEqual(m.crumbsOf("Docs", "a/b"), [{ name: "Docs", path: "" }, { name: "a", path: "a" }, { name: "b", path: "a/b" }]);
  assert.equal(m.providerLabel([{ id: "gdrive", label: "Google Drive", pick: true }], "gdrive"), "Google Drive");
  assert.equal(m.providerLabel([], "sharepoint"), "sharepoint");
});

test("only a small text file is edited in the app", { skip: !strip }, async () => {
  const m = await import("./linked-model.ts");
  assert.ok(m.editable("notes.md", 100) && m.editable("a.txt", 262144));
  assert.ok(!m.editable("notes.md", 262145) && !m.editable("photo.png", 10) && !m.editable("a.docx", 10));
});

test("refusals get plain words, a conflict says what happened and what to do", { skip: !strip }, async () => {
  const m = await import("./linked-model.ts");
  assert.match(m.linkedRefusal("conflict", ""), /changed at the source.*Reload/s);
  assert.match(m.linkedRefusal("denied", "x"), /account/);
  assert.match(m.linkedRefusal("unavailable", ""), /not answering/);
  assert.match(m.linkedRefusal("no_such_tool", ""), /Update your Vyre/);
  assert.match(m.linkedRefusal("unsupported", "edited in Drive"), /edited in Drive/);
  assert.match(m.linkedRefusal("presence_required", ""), /Approve on this device/);
  assert.equal(m.linkedRefusal("bad_input", "name is taken"), "name is taken");
});

test("the source speaks the box's tools with the box's inputs", { skip: !strip }, async () => {
  const { linkedSource } = await import("./linked-source.ts");
  /** @type {any[]} */ const seen = [];
  const s = linkedSource(async (tool, input) => { seen.push({ tool, input }); return { data: ({ "files.linked.list": { links: [{ id: "l1" }] }, "files.linked.providers": { providers: [{ id: "gdrive", label: "Google Drive", pick: true }] }, "files.linked.pick": { parent: "root", folders: [] }, "files.linked.ls": { path: "Linked/Docs", entries: [] }, "files.linked.versions": { versions: [{ rev: "1", modified: 1 }] } })[tool] ?? {} }; });
  assert.equal((await s.list()).length, 1);
  assert.equal((await s.providers())[0].label, "Google Drive");
  await s.pick("gdrive"); await s.pick("gdrive", "F1");
  await s.link("Docs", "gdrive", { folder: "F1" });
  await s.sync("l1"); await s.sync("l1", true);
  await s.ls("l1", "a");
  await s.read("l1", "a/b.txt");
  await s.write("l1", "a/b.txt", "QQ==", "7"); await s.write("l1", "new.txt", "QQ==");
  assert.equal((await s.versions("l1", "a/b.txt"))[0].rev, "1");
  await s.unlink("l1");
  assert.deepEqual(seen.map((x) => [x.tool, x.input]), [
    ["files.linked.list", {}], ["files.linked.providers", {}],
    ["files.linked.pick", { provider: "gdrive" }], ["files.linked.pick", { provider: "gdrive", parent: "F1" }],
    ["files.linked.link", { name: "Docs", provider: "gdrive", source: { folder: "F1" } }],
    ["files.linked.sync", { id: "l1" }], ["files.linked.sync", { id: "l1", full: true }],
    ["files.linked.ls", { id: "l1", path: "a" }],
    ["files.linked.read", { id: "l1", path: "a/b.txt" }],
    ["files.linked.write", { id: "l1", path: "a/b.txt", base64: "QQ==", base_rev: "7" }], ["files.linked.write", { id: "l1", path: "new.txt", base64: "QQ==" }],
    ["files.linked.versions", { id: "l1", path: "a/b.txt" }],
    ["files.linked.unlink", { id: "l1" }],
  ]);
});

test("a refusal from the box becomes an error that keeps its code", { skip: !strip }, async () => {
  const { linkedSource } = await import("./linked-source.ts");
  const s = linkedSource(async () => ({ error: { code: "conflict", message: "changed" } }));
  await assert.rejects(s.write("l1", "a", "QQ==", "1"), (/** @type {any} */ e) => e.code === "conflict");
});

test("the sample world links a folder, lists it, saves back with the rev it was opened at, and refuses a stale save", { skip: !strip }, async () => {
  const { mockBox } = await import("./mock-box.ts");
  const { linkedSource } = await import("./linked-source.ts");
  const s = linkedSource(mockBox());
  const l = await s.link("Docs", "gdrive", { folder: "F1" });
  assert.deepEqual((await s.ls(l.id)).entries.map((e) => [e.name, e.dir]), [["Plans", true], ["budget.txt", false]]);
  const f = await s.read(l.id, "budget.txt");
  assert.equal(atob(f.base64), "Budget numbers.");
  const w = await s.write(l.id, "budget.txt", btoa("Budget v2"), f.rev);
  assert.notEqual(w.rev, f.rev);
  await assert.rejects(s.write(l.id, "budget.txt", btoa("stale"), f.rev), (/** @type {any} */ e) => e.code === "conflict");
  await assert.rejects(s.link("Docs", "gdrive", { folder: "F2" }), (/** @type {any} */ e) => e.code === "conflict");
  await s.unlink(l.id);
  assert.equal((await s.list()).length, 0);
});
