// @ts-check
// The Dropbox linked-folder provider (core/files/linked-dropbox.js) against a fake Dropbox API (linked-dropbox-fake.js): the provider contract, plus what is Dropbox's own: paths not ids for the
// link, a cursor taken before the walk, a deleted entry with no id, rev-checked writes (and "conflicted copy" caught), and a delete that only ever moves a file into Vyre Trash.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { assertProvider } from "./linked-provider.js";
import { dropboxProvider } from "./linked-dropbox.js";
import { fakeDropboxApi } from "./linked-dropbox-fake.js";

const link = { id: "lnk_1", provider: "dropbox", source: { path: "/Client docs" } };

function rig(o = {}) {
  const api = fakeDropboxApi(o);
  api.add({ path: "/Client docs", folder: true });
  api.add({ path: "/Client docs/Contracts", folder: true });
  api.add({ path: "/Client docs/Contracts/retainer.md", text: "retainer five thousand" });
  api.add({ path: "/Client docs/notes.txt", text: "call Dana" });
  api.add({ path: "/Elsewhere/other.txt", text: "not in the folder" });
  const p = dropboxProvider({ client: { request: api.request } });
  return { api, p };
}
const byPath = (/** @type {any[]} */ es) => Object.fromEntries(es.map(e => [e.path, e]));
const code = (/** @type {Promise<any>} */ pr) => pr.then(() => null, e => e.code);

test("it is a provider like any other, and its id is dropbox", () => {
  assert.equal(assertProvider(rig().p).id, "dropbox");
});

test("a full list walks the folder into paths relative to the link, over several pages, with a cursor taken first", async () => {
  const { p, api } = rig({ pageSize: 2 });
  const r = await p.list(link, "per_alex", {});
  assert.equal(r.full, true);
  assert.deepEqual(Object.keys(byPath(r.entries)).sort(), ["Contracts", "Contracts/retainer.md", "notes.txt"]);
  const e = byPath(r.entries);
  assert.equal(e["Contracts"].dir, true);
  assert.equal(e["notes.txt"].mime, "text/plain");
  assert.equal(typeof r.next, "string");
  assert.ok(api.calls.findIndex(c => c[1] === "list_folder/get_latest_cursor") < api.calls.findIndex(c => c[1] === "list_folder"), "the cursor comes before the walk");
  assert.ok(api.calls.every(c => c[0] === "per_alex"), "every call is the person's");
});

test("the source may be an id, and a renamed folder still resolves; the whole Dropbox and odd paths are refused", async () => {
  const { p, api } = rig();
  const id = [...api.nodes.values()].find(n => n.path === "/Client docs").id;
  const viaId = await p.list({ ...link, source: { id } }, "per_alex", {});
  assert.equal(viaId.entries.length, 3);
  const viaFolder = await p.list({ ...link, source: { folder: id } }, "per_alex", {});
  assert.equal(viaFolder.entries.length, 3, "the picker's { folder } is read as an id");
  for (const source of [{ path: "/" }, { path: "" }, { path: "Client docs" }, { path: "/a/../b" }, {}, { id: "nope" }]) assert.equal(await code(p.list({ ...link, source }, "per_alex", {})), "bad_input", JSON.stringify(source));
  const lower = await p.list({ ...link, source: { path: "/CLIENT DOCS/" } }, "per_alex", {});
  assert.equal(lower.entries.length, 3, "Dropbox paths ignore case");
});

test("with a cursor it returns only what changed; a delete, a new folder or an expired cursor falls back to a full list", async () => {
  const { p, api } = rig();
  const first = await p.list(link, "per_alex", {});
  api.edit("/Client docs/notes.txt", "call Dana on Monday");
  api.add({ path: "/Elsewhere/other.txt", text: "changed, but not in the linked folder" });
  const r = await p.list(link, "per_alex", { token: first.next });
  assert.equal(r.full, false);
  assert.deepEqual(r.entries.map(x => x.path), ["notes.txt"]);
  api.remove("/Client docs/notes.txt");
  const gone = await p.list(link, "per_alex", { token: r.next });
  assert.equal(gone.full, true, "a deleted entry has no id, so everything is listed");
  assert.deepEqual(Object.keys(byPath(gone.entries)).sort(), ["Contracts", "Contracts/retainer.md"]);
  api.add({ path: "/Client docs/New", folder: true });
  assert.equal((await p.list(link, "per_alex", { token: gone.next })).full, true, "a folder change lists everything");
  const t = (await p.list(link, "per_alex", {})).next;
  api.expireCursors();
  assert.equal((await p.list(link, "per_alex", { token: t })).full, true, "an expired cursor lists everything");
});

test("read gives the bytes, the rev and a mime; a file outside the folder is not found", async () => {
  const { p, api } = rig();
  const e = byPath((await p.list(link, "per_alex", {})).entries);
  const f = await p.read(link, "per_alex", e["Contracts/retainer.md"]);
  assert.equal(Buffer.from(f.bytes).toString(), "retainer five thousand");
  assert.equal(f.mime, "text/markdown");
  assert.equal(f.rev, e["Contracts/retainer.md"].rev);
  const outside = [...api.nodes.values()].find(n => n.path === "/Elsewhere/other.txt");
  assert.equal(await code(p.read(link, "per_alex", { id: outside.id })), "not_found");
  assert.equal(await code(p.read(link, "per_alex", { id: "../../x" })), "bad_input");
});

test("write creates, overwrites, and checks the rev: a stale one answers conflict and writes nothing", async () => {
  const { p, api } = rig();
  const made = await p.write(link, "per_alex", "Contracts/new.txt", Buffer.from("fresh"));
  assert.match(made.id, /^id:/);
  assert.equal(Buffer.from((await p.read(link, "per_alex", { id: made.id })).bytes).toString(), "fresh");
  const note = byPath((await p.list(link, "per_alex", {})).entries)["notes.txt"];
  const ok = await p.write(link, "per_alex", "notes.txt", Buffer.from("v2"), { baseRev: note.rev });
  assert.notEqual(ok.rev, note.rev);
  assert.equal(await code(p.write(link, "per_alex", "notes.txt", Buffer.from("v3"), { baseRev: note.rev })), "conflict");
  assert.equal(api.nodes.get(note.id).bytes.toString(), "v2", "the stale write wrote nothing");
  assert.equal(await code(p.write(link, "per_alex", "gone.txt", Buffer.from("x"), { baseRev: "r1" })), "conflict", "a file that is no longer there is a conflict");
  assert.equal((await p.write(link, "per_alex", "notes.txt", Buffer.from("last word"))).id, note.id, "a write with no baseRev overwrites");
  for (const bad of ["", "/abs.txt", "../x.txt", "a//b.txt", "Vyre Trash/x.txt", "a\\b.txt"]) assert.equal(await code(p.write(link, "per_alex", bad, Buffer.from("x"))), "bad_input", bad);
});

test("a write that loses a race is caught: Dropbox keeps a conflicted copy, and the answer is conflict", async () => {
  const { p, api } = rig();
  const note = byPath((await p.list(link, "per_alex", {})).entries)["notes.txt"];
  api.beforeUpload(() => api.edit("/Client docs/notes.txt", "someone else, just now"));
  assert.equal(await code(p.write(link, "per_alex", "notes.txt", Buffer.from("mine"), { baseRev: note.rev })), "conflict");
  const strict = rig({ conflicts: "error" });
  const n2 = byPath((await strict.p.list(link, "per_alex", {})).entries)["notes.txt"];
  strict.api.beforeUpload(() => strict.api.edit("/Client docs/notes.txt", "someone else"));
  assert.equal(await code(strict.p.write(link, "per_alex", "notes.txt", Buffer.from("mine"), { baseRev: n2.rev })), "conflict", "Dropbox's own conflict answer maps the same way");
});

test("rename moves a file, making the folders it needs", async () => {
  const { p, api } = rig();
  const note = byPath((await p.list(link, "per_alex", {})).entries)["notes.txt"];
  const r = await p.rename(link, "per_alex", note, "Archive/2026/notes-old.txt");
  assert.equal(r.id, note.id);
  assert.equal(api.nodes.get(note.id).path, "/Client docs/Archive/2026/notes-old.txt");
  const paths = Object.keys(byPath((await p.list(link, "per_alex", {})).entries));
  assert.ok(paths.includes("Archive/2026/notes-old.txt") && !paths.includes("notes.txt"));
  const outside = [...api.nodes.values()].find(n => n.path === "/Elsewhere/other.txt");
  assert.equal(await code(p.rename(link, "per_alex", { id: outside.id }, "x.txt")), "not_found", "a file outside the folder is not moved");
});

test("delete never deletes: the file moves into Vyre Trash inside the folder, leaves the listing, and a clash is renamed", async () => {
  const { p, api } = rig();
  const e = byPath((await p.list(link, "per_alex", {})).entries);
  const first = await p.list(link, "per_alex", {});
  assert.deepEqual(await p.delete(link, "per_alex", e["notes.txt"]), { deleted: true });
  assert.equal(api.nodes.get(e["notes.txt"].id).path, "/Client docs/Vyre Trash/notes.txt", "still in Dropbox, in the trash folder");
  assert.equal(api.nodes.get(e["notes.txt"].id).deleted, undefined);
  assert.equal(api.permanentDeletes, 0);
  assert.ok(!api.calls.some(c => /delete/.test(c[1])), "files/delete_v2 was never called");
  const after = await p.list(link, "per_alex", { token: first.next });
  assert.equal(after.full, true, "Dropbox reports the old path as deleted, which lists everything");
  assert.ok(!after.entries.some(x => x.id === e["notes.txt"].id), "the sync drops it");
  assert.ok(!Object.keys(byPath((await p.list(link, "per_alex", {})).entries)).some(x => x.startsWith("Vyre Trash")), "the trash folder is not shown");
  assert.deepEqual(await p.delete(link, "per_alex", e["notes.txt"]), { deleted: true }, "deleting what is already in the trash does nothing more");
  const again = await p.write(link, "per_alex", "notes.txt", Buffer.from("same name again"));
  await p.delete(link, "per_alex", { id: again.id });
  assert.deepEqual([...api.nodes.values()].map(n => n.path).filter(x => x.includes("Vyre Trash/")).sort(), ["/Client docs/Vyre Trash/notes (1).txt", "/Client docs/Vyre Trash/notes.txt"]);
  const outside = [...api.nodes.values()].find(n => n.path === "/Elsewhere/other.txt");
  assert.equal(await code(p.delete(link, "per_alex", { id: outside.id })), "not_found", "a file outside the folder is never touched");
  assert.equal(api.nodes.get(outside.id).path, "/Elsewhere/other.txt");
});

test("versions lists revisions", async () => {
  const { p, api } = rig();
  const note = byPath((await p.list(link, "per_alex", {})).entries)["notes.txt"];
  api.edit("/Client docs/notes.txt", "second");
  assert.equal((await p.versions(link, "per_alex", note)).length, 2);
});

test("a person sees only what their own account may; a dead token is a plain sentence", async () => {
  const { p, api } = rig();
  api.hide("per_zed", "/Client docs");
  assert.equal(await code(p.list(link, "per_zed", {})), "denied");
  const dead = dropboxProvider({ client: { request: async () => { throw Object.assign(new Error("invalid_access_token/."), { status: 401 }); } } });
  const e = await dead.list(link, "per_alex", {}).catch(x => x);
  assert.equal(e.code, "denied");
  assert.match(e.message, /add a new one in the Vault/);
  const busy = dropboxProvider({ client: { request: async () => { throw Object.assign(new Error("too_many_requests/."), { status: 429 }); } } });
  assert.equal(await code(busy.list(link, "per_alex", {})), "unavailable");
});

test("pick lists the folders a person may link, one level at a time, never the trash", async () => {
  const { p, api } = rig();
  api.add({ path: "/Client docs/Vyre Trash", folder: true });
  const top = await p.pick("per_alex", {});
  assert.deepEqual(top.folders.map(f => f.name), ["Client docs", "Elsewhere"]);
  assert.equal(top.parent, "root");
  const inner = await p.pick("per_alex", { parent: top.folders[0].id });
  assert.deepEqual(inner.folders.map(f => f.name), ["Contracts"]);
  assert.equal(await code(p.pick("per_alex", { parent: "/etc" })), "bad_input");
});
