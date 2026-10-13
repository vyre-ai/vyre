// @ts-check
// The Google Drive linked-folder provider (core/files/linked-gdrive.js) against a fake Drive REST API (linked-gdrive-fake.js): the same provider contract the fake source meets, plus what is
// Drive's own: folders are ids not paths, edits are conflict-checked by version, a Google Doc is read as text, and a person sees only what their own account may.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assertProvider } from "./linked-provider.js";
import { googleDriveProvider } from "./linked-gdrive.js";
import { fakeDriveApi } from "./linked-gdrive-fake.js";

const link = { id: "lnk_1", provider: "gdrive", source: { folder: "ROOT" } };

function rig(o = {}) {
  const api = fakeDriveApi(o);
  api.add({ id: "ROOT", name: "Client docs", folder: true });
  api.add({ id: "SUB", name: "Contracts", parent: "ROOT", folder: true });
  api.add({ id: "RET", name: "retainer.md", parent: "SUB", text: "retainer five thousand" });
  api.add({ id: "NOTE", name: "notes.txt", parent: "ROOT", text: "call Dana" });
  api.add({ id: "DOC", name: "Plan", parent: "ROOT", doc: true, text: "the launch plan" });
  api.add({ id: "ELSEWHERE", name: "other.txt", text: "not in the folder" });
  const p = googleDriveProvider({ client: { request: api.request } });
  return { api, p };
}
const byPath = (/** @type {any[]} */ es) => Object.fromEntries(es.map(e => [e.path, e]));
const code = (/** @type {Promise<any>} */ pr) => pr.then(() => null, e => e.code);

test("it is a provider like any other, and its id is gdrive", () => {
  assert.equal(assertProvider(rig().p).id, "gdrive");
});

test("a full list walks the folder tree into paths relative to the link, with a token for the next one", async () => {
  const { p, api } = rig({ pageSize: 2 });
  const r = await p.list(link, "per_alex", {});
  assert.equal(r.full, true);
  assert.deepEqual(Object.keys(byPath(r.entries)).sort(), ["Contracts", "Contracts/retainer.md", "Plan", "notes.txt"]);
  const e = byPath(r.entries);
  assert.equal(e["Contracts/retainer.md"].id, "RET");
  assert.equal(e["Contracts"].mime, "application/vnd.google-apps.folder");
  assert.equal(e["Plan"].indexable, true, "a Google Doc is read as text");
  assert.equal(typeof r.next, "string");
  assert.ok(api.calls.every(c => c[0] === "per_alex"), "every call is the person's");
});

test("with a token it returns only what changed, in the folder, and a folder change falls back to a full list", async () => {
  const { p, api } = rig();
  const first = await p.list(link, "per_alex", {});
  api.edit("NOTE", "call Dana on Monday");
  api.edit("ELSEWHERE", "also changed, but not in the linked folder");
  const r = await p.list(link, "per_alex", { token: first.next });
  assert.equal(r.full, false);
  assert.deepEqual(r.entries.filter((/** @type {any} */ e) => !e.deleted).map((/** @type {any} */ e) => e.path), ["notes.txt"]);
  assert.deepEqual(r.entries.filter((/** @type {any} */ e) => e.deleted).map((/** @type {any} */ e) => e.id), ["ELSEWHERE"], "a change outside the folder arrives as a removal, so a file moved out of it leaves the index");
  assert.notEqual(r.entries.find((/** @type {any} */ e) => e.path === "notes.txt").rev, first.entries.find((/** @type {any} */ e) => e.path === "notes.txt").rev);
  // a rename of a folder moves everything under it, so the answer is the whole list
  api.files.get("SUB").name = "Agreements"; api.edit("SUB", "");
  const f = await p.list(link, "per_alex", { token: r.next });
  assert.equal(f.full, true);
  assert.ok(f.entries.some((/** @type {any} */ e) => e.path === "Agreements/retainer.md"));
});

test("a file trashed at the source comes back deleted", async () => {
  const { p, api } = rig();
  const first = await p.list(link, "per_alex", {});
  api.trash("NOTE");
  const r = await p.list(link, "per_alex", { token: first.next });
  assert.deepEqual(r.entries.map((/** @type {any} */ e) => [e.id, e.deleted]), [["NOTE", true]]);
});

test("a person sees only what their own account may: a hidden file is not listed, and a hidden root is refused", async () => {
  const { p, api } = rig();
  api.hide("per_bo", "NOTE");
  const r = await p.list(link, "per_bo", {});
  assert.ok(!r.entries.some((/** @type {any} */ e) => e.path === "notes.txt"));
  api.hide("per_cy", "ROOT");
  assert.equal(await code(p.list(link, "per_cy", {})), "denied");
});

test("read gives a file's bytes fetched now, a Google Doc as text, and refuses a folder", async () => {
  const { p } = rig();
  const { entries } = await p.list(link, "per_alex", {});
  const e = byPath(entries);
  const a = await p.read(link, "per_alex", e["notes.txt"]);
  assert.equal(Buffer.from(a.bytes).toString(), "call Dana");
  assert.equal(a.rev, e["notes.txt"].rev);
  const d = await p.read(link, "per_alex", e["Plan"]);
  assert.equal(Buffer.from(d.bytes).toString(), "the launch plan");
  assert.match(d.mime, /^text\/plain/);
  assert.equal(await code(p.read(link, "per_alex", e["Contracts"])), "bad_input");
});

test("write updates a file in place when the base version is current, and answers conflict when it is not", async () => {
  const { p, api } = rig();
  const { entries } = await p.list(link, "per_alex", {});
  const rev = byPath(entries)["notes.txt"].rev;
  const w = await p.write(link, "per_alex", "notes.txt", new TextEncoder().encode("call Dana Tuesday"), { baseRev: rev });
  assert.equal(w.id, "NOTE"); assert.notEqual(w.rev, rev);
  assert.equal(api.files.get("NOTE").bytes.toString(), "call Dana Tuesday");
  api.edit("NOTE", "someone else wrote this");
  assert.equal(await code(p.write(link, "per_alex", "notes.txt", new TextEncoder().encode("mine"), { baseRev: w.rev })), "conflict");
  assert.equal(api.files.get("NOTE").bytes.toString(), "someone else wrote this", "nothing was overwritten");
});

test("write to a new path creates the folders it needs under the linked folder and the file", async () => {
  const { p, api } = rig();
  const w = await p.write(link, "per_alex", "Contracts/2026/new.txt", new TextEncoder().encode("fresh"), {});
  const f = api.files.get(w.id);
  assert.equal(f.name, "new.txt"); assert.equal(f.bytes.toString(), "fresh");
  const year = api.files.get(f.parents[0]);
  assert.equal(year.name, "2026"); assert.deepEqual(year.parents, ["SUB"]);
  assert.equal(await code(p.write(link, "per_alex", "../escape.txt", new Uint8Array(1), {})), "bad_input");
});

test("a Google Doc is not written as bytes", async () => {
  const { p } = rig();
  assert.equal(await code(p.write(link, "per_alex", "Plan", new Uint8Array(1), {})), "unsupported");
});

test("rename renames or moves within the linked folder; delete trashes, never destroys", async () => {
  const { p, api } = rig();
  const { entries } = await p.list(link, "per_alex", {});
  const e = byPath(entries);
  await p.rename(link, "per_alex", e["notes.txt"], "Contracts/call-notes.txt");
  assert.equal(api.files.get("NOTE").name, "call-notes.txt");
  assert.deepEqual(api.files.get("NOTE").parents, ["SUB"]);
  await p.delete(link, "per_alex", e["Contracts/retainer.md"]);
  assert.equal(api.files.get("RET").trashed, true);
  assert.ok(api.files.has("RET"), "still in Drive's trash");
});

test("versions come from Drive's revisions", async () => {
  const { p, api } = rig();
  api.edit("NOTE", "second");
  const { entries } = await p.list(link, "per_alex", {});
  const v = await p.versions(link, "per_alex", byPath(entries)["notes.txt"]);
  assert.equal(v.length, 2);
  assert.ok(v[0].rev && v[0].modified);
});

test("a source without a folder id is refused", async () => {
  const { p } = rig();
  assert.equal(await code(p.list({ id: "x", source: {} }, "per_alex", {})), "bad_input");
  assert.equal(await code(p.list({ id: "x", source: { folder: "../x" } }, "per_alex", {})), "bad_input");
});
