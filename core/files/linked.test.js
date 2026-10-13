// @ts-check
// Linked folders (core/files/linked.js): the record of "this source folder appears at Linked/<name>", per Space, with who linked it. The source is a PROVIDER (linked-provider.js);
// the fake one here records what it is asked, so no test reaches Google, SharePoint or GitHub.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate, open } from "../store/index.js";
import { registerLinked } from "./linked.js";
import { assertProvider, PROVIDER_METHODS } from "./linked-provider.js";
import { fakeProvider } from "./linked-fake.js";

const SPACE = "spc_abcdefghijkl";
const person = (id) => ({ hops: [{ actor: { kind: "person", id, space: SPACE } }] });

function rig({ chain = person("per_alex"), providers = [fakeProvider({ id: "fake" })] } = {}) {
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "linked-")), "vyre.db"));
  const tools = new Map();
  const clock = { t: 1_800_000_000_000 };
  const state = { chain };
  const ctx = {
    tool: (n, d) => tools.set(n, d),
    store: { db, migrate: (steps) => migrate(db, "files", steps) },
    kernel: { space: SPACE, owner: "per_alex", for: async () => ({ gateway: {}, surfaces: {} }), chainIn: async () => { if (!state.chain) throw Object.assign(new Error("x"), { code: "denied" }); return state.chain; }, proofFrom: () => undefined },
  };
  const linked = registerLinked(ctx, { providers, now: () => clock.t });
  const run = (n, i = {}, meta = {}) => tools.get(n).run(i, meta);
  return { run, tools, clock, state, db, linked };
}
const code = (p) => p.then(() => null, e => e.code);

test("a provider is one shape: list with change tokens, read, write, rename, delete and history; nothing names Drive", () => {
  assert.deepEqual([...PROVIDER_METHODS], ["list", "read", "write", "rename", "delete", "versions"]);
  assertProvider(fakeProvider({ id: "fake" }));
  assert.throws(() => assertProvider({ id: "x", list() {} }), /read/);
  assert.throws(() => assertProvider({ ...fakeProvider({ id: "x" }), id: "Bad Id" }), /id/);
});

test("linking records the source at Linked/<name>, who linked it, and lists it", async () => {
  const r = rig();
  const l = await r.run("files.linked.link", { name: "Client-docs", provider: "fake", source: { folder: "F1" } });
  assert.equal(l.path, "Linked/Client-docs");
  assert.equal(l.provider, "fake");
  assert.equal(l.linked_by, "per_alex");
  const { links } = await r.run("files.linked.list");
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].source, { folder: "F1" });
  assert.equal(links[0].at, r.clock.t);
});

test("a name is one place: a second link with the same name, a bad name or an unknown provider is refused", async () => {
  const r = rig();
  await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  assert.equal(await code(r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F2" } })), "conflict");
  assert.equal(await code(r.run("files.linked.link", { name: "../x", provider: "fake", source: { folder: "F" } })), "bad_input");
  assert.equal(await code(r.run("files.linked.link", { name: "Other", provider: "nope", source: { folder: "F" } })), "bad_input");
  assert.equal(await code(r.run("files.linked.link", { name: "Other", provider: "fake", source: {} })), "bad_input");
});

test("a call that proved no person links nothing", async () => {
  const r = rig({ chain: null });
  assert.equal(await code(r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F" } })), "denied");
});

test("unlink frees the name and keeps the record's history; the source is never touched", async () => {
  const r = rig();
  const l = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  assert.deepEqual(await r.run("files.linked.unlink", { id: l.id }), { unlinked: true });
  assert.equal((await r.run("files.linked.list")).links.length, 0);
  await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F2" } });
  assert.equal(await code(r.run("files.linked.unlink", { id: "nope" })), "not_found");
  assert.deepEqual(r.linked.providers.get("fake").touched, []);
});

test("only the person who linked a folder, or the Space owner, unlinks it", async () => {
  const r = rig({ chain: person("per_bo") });
  const l = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  r.state.chain = person("per_cy");
  assert.equal(await code(r.run("files.linked.unlink", { id: l.id })), "denied");
  r.state.chain = person("per_alex");
  assert.deepEqual(await r.run("files.linked.unlink", { id: l.id }), { unlinked: true });
});

test("the tools are the person's: link and unlink carry presence, list does not", () => {
  const r = rig();
  assert.ok(r.tools.get("files.linked.link").presence);
  assert.ok(r.tools.get("files.linked.unlink").presence);
  assert.equal(r.tools.get("files.linked.list").presence, undefined);
});

const seeded = () => rig({ providers: [fakeProvider({ id: "fake", files: { "a/plan.md": "the launch plan", "b.txt": "budget numbers" } })] });

test("sync is the person's own: it indexes what the source shows them and answers the status; search finds it", async () => {
  const r = seeded();
  const l = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  assert.equal((await r.run("files.linked.status", { id: l.id })).sync, null, "not synced yet");
  const s = await r.run("files.linked.sync", { id: l.id });
  assert.equal(s.status, "ok"); assert.equal(s.count, 2);
  const hits = (await r.run("files.linked.search", { q: "launch" })).hits;
  assert.deepEqual(hits.map(h => [h.name, h.link_name, h.path]), [["plan.md", "Docs", "Linked/Docs/a/plan.md"]]);
  assert.equal(r.linked.providers.get("fake").calls.find(c => c[0] === "list")[1], "per_alex", "asked as the person");
});

test("another person's search sees none of it until they sync it through their own identity", async () => {
  const r = seeded();
  const l = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  await r.run("files.linked.sync", { id: l.id });
  r.state.chain = person("per_bo");
  assert.deepEqual((await r.run("files.linked.search", { q: "launch" })).hits, []);
  await r.run("files.linked.sync", { id: l.id });
  assert.equal((await r.run("files.linked.search", { q: "launch" })).hits.length, 1);
});

test("unlinking drops the index, and sync or search for a gone link is not_found", async () => {
  const r = seeded();
  const l = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  await r.run("files.linked.sync", { id: l.id });
  await r.run("files.linked.unlink", { id: l.id });
  assert.deepEqual((await r.run("files.linked.search", { q: "launch" })).hits, []);
  assert.equal(await code(r.run("files.linked.sync", { id: l.id })), "not_found");
});

test("the scheduler syncs every pair that has synced once, and one failing pair does not stop the rest", async () => {
  const r = seeded();
  const a = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  await r.run("files.linked.sync", { id: a.id });
  r.state.chain = person("per_bo");
  await r.run("files.linked.sync", { id: a.id });
  const p = r.linked.providers.get("fake");
  p.external.put("c.txt", "later file");
  const n = await r.linked.syncKnown();
  assert.equal(n, 2);
  assert.equal(p.calls.filter(c => c[0] === "list").length, 4);
  r.state.chain = person("per_alex");
  assert.equal((await r.run("files.linked.search", { q: "later" })).hits.length, 1);
});

test("the files module migrates one list for mentions, shared links, linked folders and their index, in a fixed order", async () => {
  const { filesMigrations } = await import("./migrations.js");
  const FILES_MIGRATIONS = filesMigrations();
  const { MIGRATIONS } = await import("./mentions.js");
  const { LINK_MIGRATIONS } = await import("./space-links.js");
  assert.equal(FILES_MIGRATIONS[0], MIGRATIONS[0]);
  assert.equal(FILES_MIGRATIONS[MIGRATIONS.length], LINK_MIGRATIONS[0]);
  const db = open(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mig-")), "vyre.db"));
  migrate(db, "files", FILES_MIGRATIONS);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'files_%'").all().map(x => x.name);
  for (const t of ["files_mention_grants", "files_links", "files_linked", "files_linked_index", "files_linked_sync"]) assert.ok(names.includes(t), t);
});

const b64 = (/** @type {string} */ t) => Buffer.from(t).toString("base64");
async function opened() {
  const r = rig({ providers: [fakeProvider({ id: "fake", files: { "a/plan.md": "the launch plan", "a/deep/x.txt": "x", "b.txt": "budget numbers" } })] });
  const l = await r.run("files.linked.link", { name: "Docs", provider: "fake", source: { folder: "F1" } });
  return { r, l, p: r.linked.providers.get("fake") };
}

test("ls lists a folder from the person's index (syncing the first time) with folders implied by deeper paths", async () => {
  const { r, l } = await opened();
  const top = await r.run("files.linked.ls", { id: l.id });
  assert.deepEqual(top.entries.map(e => [e.name, e.dir, e.path]), [["a", true, "Linked/Docs/a"], ["b.txt", false, "Linked/Docs/b.txt"]]);
  const a = await r.run("files.linked.ls", { id: l.id, path: "a" });
  assert.deepEqual(a.entries.map(e => e.name), ["deep", "plan.md"]);
  assert.equal(await code(r.run("files.linked.ls", { id: l.id, path: "../x" })), "bad_input");
});

test("read fetches the content when it is opened, as the person, and answers its revision", async () => {
  const { r, l, p } = await opened();
  const f = await r.run("files.linked.read", { id: l.id, path: "b.txt" });
  assert.equal(Buffer.from(f.base64, "base64").toString(), "budget numbers");
  assert.equal(f.name, "b.txt"); assert.equal(f.size, 14); assert.ok(f.rev);
  const reads = p.calls.filter(c => c[0] === "read");
  assert.ok(reads.length >= 1);
  assert.equal(reads.at(-1)[1], "per_alex");
  assert.equal(await code(r.run("files.linked.read", { id: l.id, path: "nope.txt" })), "not_found");
});

test("a file edited at the source is read as it is now, not as it was indexed", async () => {
  const { r, l, p } = await opened();
  await r.run("files.linked.sync", { id: l.id });
  p.external.put("b.txt", "budget changed");
  const f = await r.run("files.linked.read", { id: l.id, path: "b.txt" });
  assert.equal(Buffer.from(f.base64, "base64").toString(), "budget changed");
});

test("write goes back to the source with the revision it was opened at, then the index follows", async () => {
  const { r, l, p } = await opened();
  const f = await r.run("files.linked.read", { id: l.id, path: "b.txt" });
  const w = await r.run("files.linked.write", { id: l.id, path: "b.txt", base64: b64("budget v2"), base_rev: f.rev });
  assert.equal(w.path, "Linked/Docs/b.txt"); assert.notEqual(w.rev, f.rev);
  assert.deepEqual(p.calls.filter(c => c[0] === "write").at(-1).slice(1), ["per_alex", "b.txt", f.rev]);
  assert.equal((await r.run("files.linked.search", { q: "v2" })).hits.length, 1, "the edit is searchable at once");
});

test("a stale write is refused with conflict and nothing is overwritten", async () => {
  const { r, l, p } = await opened();
  const f = await r.run("files.linked.read", { id: l.id, path: "b.txt" });
  p.external.put("b.txt", "someone else");
  assert.equal(await code(r.run("files.linked.write", { id: l.id, path: "b.txt", base64: b64("mine"), base_rev: f.rev })), "conflict");
  assert.equal(Buffer.from(p.store.get([...p.store.values()].find(x => x.path === "b.txt").id).bytes).toString(), "someone else");
});

test("write is bounded: bad base64, too large and an escaping path are refused before the source is asked", async () => {
  const { r, l, p } = await opened();
  p.calls.length = 0;
  assert.equal(await code(r.run("files.linked.write", { id: l.id, path: "b.txt", base64: "***" })), "bad_input");
  assert.equal(await code(r.run("files.linked.write", { id: l.id, path: "../b.txt", base64: b64("x") })), "bad_input");
  assert.equal(await code(r.run("files.linked.write", { id: l.id, path: "big.bin", base64: "A".repeat(12 * 1024 * 1024) })), "too_large");
  assert.equal(p.calls.filter(c => c[0] === "write").length, 0);
});

test("rename, delete and versions go to the source as the person; the index follows", async () => {
  const { r, l, p } = await opened();
  await r.run("files.linked.rename", { id: l.id, path: "b.txt", to: "a/budget.txt" });
  assert.deepEqual((await r.run("files.linked.ls", { id: l.id, path: "a" })).entries.map(e => e.name), ["deep", "budget.txt", "plan.md"]);
  const v = await r.run("files.linked.versions", { id: l.id, path: "a/budget.txt" });
  assert.ok(v.versions.length >= 1);
  await r.run("files.linked.delete", { id: l.id, path: "a/budget.txt" });
  assert.equal(await code(r.run("files.linked.read", { id: l.id, path: "a/budget.txt" })), "not_found");
  assert.deepEqual(p.calls.filter(c => ["rename", "delete", "versions"].includes(c[0])).map(c => [c[0], c[1]]), [["rename", "per_alex"], ["versions", "per_alex"], ["delete", "per_alex"]]);
});

test("writing, renaming and deleting follow the Space Drive's rule: no extra proof from the person, and the manifest marks them outward so an assistant's is held", async () => {
  const r = rig();
  for (const n of ["write", "rename", "delete", "read"]) assert.equal(r.tools.get(`files.linked.${n}`).presence, undefined, n);
  const m = JSON.parse(fs.readFileSync(new URL("./module.json", import.meta.url), "utf8"));
  const tool = (/** @type {string} */ n) => m.does.tools.find((/** @type {any} */ t) => t.name === n);
  for (const n of ["write", "rename", "delete"]) assert.equal(tool(`files.linked.${n}`).outward, true, n);
  assert.equal(tool("files.drive.upload").outward, true, "the same mark the Space Drive's upload has");
  assert.ok(!tool("files.linked.read").outward);
});

test("providers lists what can be linked, and pick offers the folders the person may choose, as the person", async () => {
  const r = rig();
  assert.deepEqual((await r.run("files.linked.providers")).providers, [{ id: "fake", label: "Fake source", pick: true }]);
  const pk = await r.run("files.linked.pick", { provider: "fake" });
  assert.deepEqual(pk.folders.map(f => f.name), ["Client docs", "Archive"]);
  assert.deepEqual(r.linked.providers.get("fake").calls.at(-1), ["pick", "per_alex", null]);
  assert.equal(await code(r.run("files.linked.pick", { provider: "nope" })), "bad_input");
});

test("# mentions: the tag search finds linked files the person's account sees, by name and by text, and names them without their text", async () => {
  const { r, l } = await opened();
  await r.run("files.linked.sync", { id: l.id });
  const hits = (await r.run("files.linked.mentions.search", { q: "launch" })).items;
  assert.deepEqual(hits.map(h => [h.id, h.name, h.hint, h.icon]), [[`${l.id}:a/plan.md`, "plan.md", "Linked/Docs/a", "file"]]);
  assert.deepEqual((await r.run("files.linked.mentions.search", { q: "" })).items, []);
  r.state.chain = person("per_bo");
  assert.deepEqual((await r.run("files.linked.mentions.search", { q: "launch" })).items, [], "another person's index is not searched");
});

test("# mentions: resolving a tag hands the chat the file's text as outside context and says how to read the rest", async () => {
  const { r, l, p } = await opened();
  await r.run("files.linked.sync", { id: l.id });
  const res = await r.run("files.linked.mentions.resolve", { id: `${l.id}:a/plan.md`, thread: "t1" }, { caller: "module:sessions" });
  assert.equal(res.name, "plan.md");
  assert.equal(res.context, "the launch plan");
  assert.match(res.note, new RegExp(`files\\.linked\\.read \\{id: "${l.id}", path: "a/plan.md"\\}`));
  assert.equal(p.calls.filter(c => c[0] === "read").at(-1)[1], "per_alex");
  assert.equal(await code(r.run("files.linked.mentions.resolve", { id: `${l.id}:nope.txt`, thread: "t1" }, { caller: "module:sessions" })), "not_found");
  assert.equal(await code(r.run("files.linked.mentions.resolve", { id: `${l.id}:a/plan.md`, thread: "t1" }, { caller: "cli" })), "denied");
});

test("# mentions: a tag whose chat has no person behind it still resolves, to a note without the text", async () => {
  const { r, l } = await opened();
  r.state.chain = null;
  const res = await r.run("files.linked.mentions.resolve", { id: `${l.id}:a/plan.md`, thread: "t1" }, { caller: "module:assistant" });
  assert.equal(res.context, undefined);
  assert.match(res.note, /files\.linked\.read/);
});

test("tree gives the picker every file the person's index holds, per linked folder, syncing a folder they have never synced", async () => {
  const { r, l } = await opened();
  const t = await r.run("files.linked.tree");
  assert.deepEqual(t.folders.map(f => [f.id, f.name, f.files.map(x => x.path).sort()]), [[l.id, "Docs", ["a/deep/x.txt", "a/plan.md", "b.txt"]]]);
  r.state.chain = person("per_bo");
  const bo = await r.run("files.linked.tree");
  assert.equal(bo.folders[0].files.length, 3, "their own sync, through their own identity");
  assert.deepEqual(r.linked.providers.get("fake").calls.filter(c => c[0] === "list").map(c => c[1]), ["per_alex", "per_bo"]);
});

test("tree is capped per folder, and a failing source leaves that folder empty instead of failing the picker", async () => {
  const { r, l, p } = await opened();
  assert.equal((await r.run("files.linked.tree", { limit: 2 })).folders[0].files.length, 2);
  p.list = async () => { throw Object.assign(new Error("no"), { code: "denied" }); };
  r.state.chain = person("per_cy");
  assert.deepEqual((await r.run("files.linked.tree")).folders[0].files, []);
});
