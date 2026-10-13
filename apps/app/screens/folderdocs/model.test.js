// @ts-check
// The shared Instructions and Context editors: the lines for each kind of context item, and a project's api over the tools that carry it.
import "../../../../scripts/mac-test-guard.mjs";
import "../../scripts/test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const strip = Boolean(/** @type {any} */ (process.features).typescript);

test("items: a file, a note and a Files reference read plainly", { skip: !strip }, async () => {
  const m = await import("./model.ts");
  assert.deepEqual(m.itemLine({ name: "price-list.xlsx", kind: "file", size: 42000 }), { title: "price-list.xlsx", sub: "File, 41 KB" });
  assert.deepEqual(m.itemLine({ name: "Style guide.md", kind: "note", size: 900 }), { title: "Style guide", sub: "Note, 900 bytes" });
  assert.deepEqual(m.itemLine({ name: "Intake form.link", kind: "link", size: 60, files: "Clients/Rivera/intake.pdf" }), { title: "Intake form", sub: "In Files: Clients/Rivera/intake.pdf" });
  assert.equal(m.filesPath("  //Clients//Rivera/intake.pdf "), "Clients/Rivera/intake.pdf");
});

test("project api: each part calls the one tool for it with the project named; refusals keep the box's words", { skip: !strip }, async () => {
  const { projectFolderApi } = await import("./project-source.ts");
  /** @type {{ tool: string, input: any }[]} */ const seen = [];
  const call = async (/** @type {string} */ tool, /** @type {any} */ input) => {
    seen.push({ tool, input });
    if (tool === "projects.docs.set" && input.text === "no") return { error: { code: "denied", message: "you have read-only access to this project (viewer)" } };
    if (tool === "projects.docs.get") return { data: { files: { "AGENTS.md": "Be exact." } } };
    if (tool === "projects.refs.list") return { data: { items: [{ name: "a.md", kind: "note", size: 3 }] } };
    return { data: {} };
  };
  const a = projectFolderApi(call, "harlow-legal");
  assert.equal(a.id, "project:harlow-legal");
  assert.deepEqual(await a.docs(), { "AGENTS.md": "Be exact." });
  assert.equal((await a.context()).length, 1);
  await a.saveDoc("AGENTS.md", "yes");
  await a.addNote("Style", "Plain.");
  await a.addLink("Intake", "Clients/x.pdf");
  await a.addFile("a.pdf", "QQ==");
  await a.remove("a.md");
  assert.deepEqual(seen.map((x) => x.tool), ["projects.docs.get", "projects.refs.list", "projects.docs.set", "projects.refs.add", "projects.refs.add", "projects.refs.add", "projects.refs.remove"]);
  assert.ok(seen.every((x) => x.input.project === "harlow-legal"));
  assert.deepEqual(seen[3].input, { project: "harlow-legal", name: "Style", text: "Plain." });
  await assert.rejects(() => a.saveDoc("AGENTS.md", "no"), /read-only/);
});
