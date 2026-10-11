// @ts-check
// A team member's project files (0.3.3), on a REAL vyred with the kernel on: the member door's `files` group (kernel/remote/wire.js CALLS.files, core/work/member-files.js). She lists, reads and uploads in the files area of
// a project she owns; a member of that project's team can; another member cannot list, read or upload; nobody reaches the `.project` marker or anything outside `files/`; a name with a folder, `..` or a leading dot is
// refused; a file over the size cap and a project over the count cap are refused in words; a person who is not a member gets nothing. Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { start } from "../daemon/index.js";
import { tempHome } from "../../test/helpers.js";
import { CALLS } from "../../kernel/remote/wire.js";
import { createMemberTools, MEMBER_TOOLS } from "./member-tools.js";
import { createMemberFiles, fileName, MAX_BYTES, MAX_FILES } from "./member-files.js";

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza", BEN = "per_" + "cdefghijklmnopqrstuvwxyzab", ZED = "per_" + "defghijklmnopqrstuvwxyzabc";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });
const b64 = (/** @type {string} */ s) => Buffer.from(s).toString("base64");

/** @param {any} t */
async function world(t) {
  const d = await start({ root: tempHome(t), log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  t.after(() => d.stop());
  const OWNER = d.kernel.id.owner, space = d.kernel.id.space;
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  for (const person of [ANA, BEN]) await d.kernel.gateway.grants.setRole(ownerChain, { person, role: "member" }, { presence: proof() });
  const tools = createMemberTools({ space, kernel: d.kernel, registry: d.registry });
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: `d-${person.slice(4, 8)}`, person, path: "relay" });
  const files = (/** @type {string} */ person, /** @type {string} */ call, /** @type {any} */ input = {}) => tools.files[call](chainOf(person), input);
  const work = (/** @type {string} */ person, /** @type {string} */ call, /** @type {any} */ input = {}) => tools.work[call](chainOf(person), input);
  return { d, OWNER, space, files, work, ownerChain, chainOf };
}

test("files is a group of the Space kernel's remote calls, and every call of it is a row of the member door's one table", () => {
  assert.deepEqual([...CALLS.files].sort(), ["list", "read", "upload"]);
  assert.deepEqual(Object.keys(MEMBER_TOOLS).filter(k => k.startsWith("files.")).map(k => k.slice(6)).sort(), [...CALLS.files].sort());
});

test("she uploads a file into her own project's files area, lists it, and reads it back", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const p = await w.work(ANA, "project-create", { name: "Ana's files" });
  const up = await w.files(ANA, "upload", { project: p.slug, name: "note.txt", data: b64("hello team") });
  assert.equal(up.name, "note.txt"); assert.equal(up.size, 10);
  const list = await w.files(ANA, "list", { project: p.slug });
  assert.deepEqual(list.files.map((/** @type {any} */ f) => f.name), ["note.txt"], JSON.stringify(list));
  const got = await w.files(ANA, "read", { project: p.slug, name: "note.txt" });
  assert.equal(Buffer.from(got.data, "base64").toString(), "hello team");
});

test("another member cannot list, read or upload in it; a member added to its team by its owner can", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const p = await w.work(ANA, "project-create", { name: "Ana's private" });
  await w.files(ANA, "upload", { project: p.slug, name: "secret.txt", data: b64("only the team") });
  await assert.rejects(w.files(BEN, "list", { project: p.slug }));
  await assert.rejects(w.files(BEN, "read", { project: p.slug, name: "secret.txt" }));
  await assert.rejects(w.files(BEN, "upload", { project: p.slug, name: "ben.txt", data: b64("x") }));
  // her team: the project's owner adds him (a team-member row of kind person), as the ownership rule allows
  const row = (await w.d.kernel.gateway.records.query(w.chainOf(ANA), "project", { filter: { field: "slug", op: "eq", value: p.slug }, page: { limit: 1 } })).rows[0];
  await w.d.kernel.gateway.records.create(w.chainOf(ANA), "team-member", { name: "ben", actor: { actor: { kind: "person", id: BEN, space: w.space } }, kind: "person", project: { urn: row.urn } });
  const seen = await w.files(BEN, "list", { project: p.slug });
  assert.deepEqual(seen.files.map((/** @type {any} */ f) => f.name), ["secret.txt"], "now he opens it");
  assert.equal(Buffer.from((await w.files(BEN, "read", { project: p.slug, name: "secret.txt" })).data, "base64").toString(), "only the team");
});

test("nothing outside files/ is reachable, and a name must be a plain name", { timeout: 120_000 }, async t => {
  const w = await world(t);
  const p = await w.work(ANA, "project-create", { name: "Ana's names" });
  for (const bad of ["../x.txt", "a/b.txt", ".project", ".hidden", "..", "x..y", "a\\b", "", " ", "x".repeat(121), "trailing."]) {
    await assert.rejects(w.files(ANA, "upload", { project: p.slug, name: bad, data: b64("x") }), /file name is|Name the|letters, numbers/i, `upload ${JSON.stringify(bad)} is refused in words`);
    await assert.rejects(w.files(ANA, "read", { project: p.slug, name: bad }), undefined, `read ${JSON.stringify(bad)} is refused`);
  }
  assert.throws(() => fileName("../x"), /file name is/);
  assert.equal(fileName("report 2026-10.pdf"), "report 2026-10.pdf");
  // the project is named by its record, not by a path
  await assert.rejects(w.files(ANA, "list", { project: "../../" }), /No project like that|Name the project/);
  // a key the row does not name is dropped by the door: a path she tries to give is never used
  const up = await w.files(ANA, "upload", { project: p.slug, name: "ok.txt", data: b64("x"), path: "Projects/other/files/evil.txt" });
  assert.equal(up.name, "ok.txt");
});

test("a file over the size cap and a project over the count cap are refused in words; a non-member gets nothing", { timeout: 150_000 }, async t => {
  const w = await world(t);
  const p = await w.work(ANA, "project-create", { name: "Ana's caps" });
  await assert.rejects(w.files(ANA, "upload", { project: p.slug, name: "big.bin", data: Buffer.alloc(MAX_BYTES + 1).toString("base64") }), /at most 10 MB/);
  await assert.rejects(w.files(ANA, "upload", { project: p.slug, name: "bad.bin", data: "not base64!!" }), /base64/);
  await assert.rejects(w.files(ZED, "list", { project: p.slug }), /not found/i, "a person who is not a member gets nothing");
});

test("a project holds at most 200 files here: the 201st new name is refused in words, and replacing a file still works", async () => {
  const stored = /** @type {string[]} */ ([]);
  const project = { data: { drive_path: "Projects/p1" } };
  const kernel = () => ({
    records: { get: async () => project, query: async () => ({ rows: [project] }) },
    drive: { list: async () => stored.map(p => ({ path: p, size: 1, version: 1 })), put: async (/** @type {any} */ _c, /** @type {string} */ p) => { if (!stored.includes(p)) stored.push(p); return { version: 1 }; } },
  });
  const ops = createMemberFiles({ kernel, maxFiles: 3 });
  const chain = { hops: [{ actor: { kind: "person", id: ANA } }] };
  for (const n of ["a", "b", "c"]) await ops["files-upload"](chain, { project: "p1", name: `${n}.txt`, data: b64("x") });
  await assert.rejects(ops["files-upload"](chain, { project: "p1", name: "d.txt", data: b64("x") }), /holds at most 3 files/);
  await ops["files-upload"](chain, { project: "p1", name: "a.txt", data: b64("y") });
  assert.equal(MAX_FILES, 200);
});
