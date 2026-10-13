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
  assert.equal(fs.readFileSync(path.join(root, "GROK.md"), "utf8"), "Draft for approval.\n", "Grok reads GROK.md: the same words");
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

test("symlinks: a link planted in the folder is never read, written through or listed (rc1-e's repros)", t => {
  const root = tmp(t), outside = tmp(t);
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
  // 1. AGENTS.md -> a secret outside: readDocs returns nothing of it
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "AGENTS.md"));
  assert.equal(readDocs(root)["AGENTS.md"], "", "a linked AGENTS.md reads as empty");
  // writing replaces the link itself and never writes the secret's file
  writeDocs(root, "AGENTS.md", "mine\n");
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "TOP SECRET", "the target was not written");
  assert.equal(fs.lstatSync(path.join(root, "AGENTS.md")).isSymbolicLink(), false, "the link was replaced by a file");
  // 2. context -> a folder outside: nothing is written there, nothing listed from there
  fs.writeFileSync(path.join(outside, "other.md"), "x");
  fs.symlinkSync(outside, path.join(root, "context"));
  assert.deepEqual(listContext(root), [], "a linked context folder lists nothing");
  assert.throws(() => addNote(root, "planted", "hello"), /link or a file/);
  assert.equal(fs.existsSync(path.join(outside, "planted.md")), false, "nothing landed outside");
  assert.throws(() => removeContext(root, "other.md"), /no context item/);
  assert.equal(fs.existsSync(path.join(outside, "other.md")), true, "and nothing outside was removed");
});

test("symlinks: a pre-planted temp name, a linked item and a linked .link are all inert", t => {
  const root = tmp(t), outside = tmp(t);
  fs.writeFileSync(path.join(outside, "victim.txt"), "KEEP");
  fs.symlinkSync(path.join(outside, "victim.txt"), path.join(root, "AGENTS.md.tmp"));
  writeDocs(root, "AGENTS.md", "fine\n");
  assert.equal(fs.readFileSync(path.join(outside, "victim.txt"), "utf8"), "KEEP", "a planted .tmp link is never written through");
  fs.mkdirSync(path.join(root, "context"));
  fs.symlinkSync(path.join(outside, "victim.txt"), path.join(root, "context", "leak.md"));
  fs.symlinkSync(path.join(outside, "victim.txt"), path.join(root, "context", "ref.link"));
  addNote(root, "real", "ok");
  assert.deepEqual(listContext(root).map(c => c.name), ["real.md"], "a link is not an item");
  addLink(root, "mine", "Clients/x.pdf");
  assert.equal(listContext(root).find(c => c.name === "mine.link")?.files, "Clients/x.pdf");
  assert.throws(() => removeContext(root, "leak.md"), /no context item/);
  assert.equal(fs.readFileSync(path.join(outside, "victim.txt"), "utf8"), "KEEP");
});

test("symlinks: a folder swapped for a link between the check and the write is caught, and nothing lands outside", t => {
  const root = tmp(t), outside = tmp(t);
  fs.mkdirSync(path.join(root, "context"));
  // The swap happens right after the temp file is written: the context folder is moved away and a link to `outside` takes its place.
  const realWrite = fs.writeFileSync, realRename = fs.renameSync;
  let swapped = false;
  /** @type {any} */ (fs).writeFileSync = (/** @type {any[]} */ ...a) => {
    const r = /** @type {any} */ (realWrite)(...a);
    if (!swapped && String(a[0]).includes(`${path.sep}context${path.sep}`)) { swapped = true; realRename(path.join(root, "context"), path.join(root, "context.old")); fs.symlinkSync(outside, path.join(root, "context")); }
    return r;
  };
  try { assert.throws(() => addNote(root, "race", "x"), /link or a file/); } finally { /** @type {any} */ (fs).writeFileSync = realWrite; }
  assert.equal(swapped, true, "the swap ran");
  assert.deepEqual(fs.readdirSync(outside), [], "nothing was left outside the folder");
});
