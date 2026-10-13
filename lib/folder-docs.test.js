// @ts-check
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDocs, writeDocs, listContext, addContextFile, addNote, addLink, removeContext, plainName, clip } from "./folder-docs.js";

const tmp = (/** @type {any} */ t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "fdocs-")); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test("docs: two files read back; with sync, either one written is both; a bad file or a huge text is refused", t => {
  const root = tmp(t);
  assert.deepEqual(readDocs(root), { "AGENTS.md": "", "CLAUDE.md": "" });
  writeDocs(root, "AGENTS.md", "Be brief.\n");
  assert.deepEqual(readDocs(root), { "AGENTS.md": "Be brief.\n", "CLAUDE.md": "" }, "apart by default (an agent)");
  writeDocs(root, "AGENTS.md", "Draft for approval.\n", { sync: true });
  assert.deepEqual(readDocs(root), { "AGENTS.md": "Draft for approval.\n", "CLAUDE.md": "Draft for approval.\n" }, "kept the same (a project)");
  writeDocs(root, "CLAUDE.md", "Edited in CLAUDE.md.\n", { sync: true });
  assert.equal(readDocs(root)["AGENTS.md"], "Edited in CLAUDE.md.\n");
  assert.throws(() => writeDocs(root, "NOTES.md", "x"), /AGENTS.md or CLAUDE.md/);
  assert.throws(() => writeDocs(root, "AGENTS.md", "x".repeat(70_000)), /up to 64 KB/);
  assert.equal(fs.statSync(path.join(root, "AGENTS.md")).mode & 0o077, 0, "only the owner reads it");
});

test("context: a file, a note and a reference live in context/, are listed by kind, replaced by name and removed; the name is only a name", t => {
  const root = tmp(t);
  addContextFile(root, "../../brief.pdf", Buffer.from("PDF"));
  addNote(root, "Call notes", "Priya prefers email.");
  addLink(root, "Intake form", "/Clients/Rivera/intake.pdf");
  assert.deepEqual(listContext(root).map(c => [c.name, c.kind, c.files ?? null]), [["brief.pdf", "file", null], ["Call notes.md", "note", null], ["Intake form.link", "link", "Clients/Rivera/intake.pdf"]]);
  assert.equal(fs.readFileSync(path.join(root, "context", "brief.pdf"), "utf8"), "PDF");
  addNote(root, "Call notes", "Replaced.");
  assert.equal(fs.readFileSync(path.join(root, "context", "Call notes.md"), "utf8"), "Replaced.");
  assert.throws(() => addLink(root, "x", "Clients/../../etc/passwd"), /place in Files/);
  assert.throws(() => addContextFile(root, "..", Buffer.from("x")), /plain name/);
  assert.throws(() => addContextFile(root, "big", Buffer.alloc(11 * 1024 * 1024)), /10 MB/);
  removeContext(root, "brief.pdf");
  assert.throws(() => removeContext(root, "brief.pdf"), /no context item/);
  assert.equal(plainName("a/b\\c.txt"), "c.txt");
  assert.equal(clip("one two three four", 9), "one two ...");
});
