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
