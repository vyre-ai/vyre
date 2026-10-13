// @ts-check
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "./layout.js";

const UUID = "0b9f7c3e-5d2a-4e1b-9c8d-1a2b3c4d5e6f";

test("a project's folder is the one the Drive already uses, named by the record id", () => {
  assert.equal(L.projectDir(UUID), `Projects/${UUID}`);
  assert.equal(L.projectFiles(UUID), `Projects/${UUID}/files`);
  assert.equal(L.projectChat(UUID, "c1"), `Projects/${UUID}/chat/c1`);
  assert.equal(L.projectMade(UUID, "c1"), `Projects/${UUID}/made/c1`);
});

test("an agent has four named parts under its own id", () => {
  assert.equal(L.agentDir("ag_7"), "agents/ag_7");
  for (const p of ["instructions", "context", "memory", "work"]) assert.equal(L.agentPart("ag_7", p), `agents/ag_7/${p}`);
  assert.deepEqual([...L.AGENT_PARTS], ["instructions", "context", "memory", "work"]);
  assert.throws(() => L.agentPart("ag_7", "secrets"), /part/);
});

test("a record lives under its object and its own id, an object by slug", () => {
  assert.equal(L.recordDir("matter", UUID), `objects/matter/${UUID}`);
  assert.equal(L.recordDir("project-template", UUID), `objects/project-template/${UUID}`);
  assert.equal(L.objectDir("matter"), "objects/matter");
  assert.throws(() => L.recordDir("Matter Files", UUID), /object/);
});

test("templates, flows and the space's own documents", () => {
  assert.equal(L.templateDir("t1"), "templates/t1");
  assert.equal(L.flowDir("f1"), "flows/f1");
  assert.equal(L.spaceDocs(), "space");
});

test("an id that could step out of its folder is refused", () => {
  for (const bad of ["", "..", "a/b", "a\\b", "../x", ".hidden", "a b", "x".repeat(65), null, undefined, 4])
    assert.throws(() => L.agentDir(/** @type {any} */ (bad)), /id/, String(bad));
  assert.throws(() => L.projectDir("../Projects/x"), /id/);
  assert.throws(() => L.recordDir("matter", "../../x"), /id/);
});

test("a rename never moves anything: no path is built from a display name", () => {
  assert.equal(L.agentDir("ag_7"), L.agentDir("ag_7"));
  assert.throws(() => L.projectDir("Harlow Legal"), /id/);
});

test("whereIs reads a path back into what it is", () => {
  assert.deepEqual(L.whereIs(`Projects/${UUID}/files/a.pdf`), { kind: "project", id: UUID, rest: "files/a.pdf" });
  assert.deepEqual(L.whereIs("agents/ag_7/memory/n.md"), { kind: "agent", id: "ag_7", rest: "memory/n.md" });
  assert.deepEqual(L.whereIs(`objects/matter/${UUID}`), { kind: "record", object: "matter", id: UUID, rest: "" });
  assert.deepEqual(L.whereIs("space/handbook.md"), { kind: "space", rest: "handbook.md" });
  assert.equal(L.whereIs("random/x"), null);
  assert.equal(L.whereIs("agents/../x"), null);
});

test("every builder's output is read back by whereIs", () => {
  assert.equal(L.whereIs(L.projectDir(UUID))?.kind, "project");
  assert.equal(L.whereIs(L.agentPart("a1", "work"))?.kind, "agent");
  assert.equal(L.whereIs(L.templateDir("t1"))?.kind, "template");
  assert.equal(L.whereIs(L.flowDir("f1"))?.kind, "flow");
});

test("no writer in core/work spells a project folder by hand", async () => {
  const fs = await import("node:fs"), path = await import("node:path"), url = await import("node:url");
  const dir = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "../../core/work");
  const bad = fs.readdirSync(dir).filter(f => f.endsWith(".js") && !f.endsWith(".test.js")).filter(f => /`Projects\/\$\{/.test(fs.readFileSync(path.join(dir, f), "utf8")));
  assert.deepEqual(bad, [], "build the folder with lib/files/layout.js");
});

test("a linked folder has one fixed place under Linked, named by its link name", () => {
  assert.equal(L.ROOTS.linked, "Linked");
  assert.equal(L.linkedDir("Client-docs"), "Linked/Client-docs");
  assert.throws(() => L.linkedDir("../x"), /id/);
  assert.deepEqual(L.whereIs("Linked/Client-docs/a/b.pdf"), { kind: "linked", id: "Client-docs", rest: "a/b.pdf" });
  assert.equal(L.whereIs("Linked"), null);
});
