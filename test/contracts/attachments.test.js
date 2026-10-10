// @ts-check
// Contract test for team/contracts/attachments.md (v1): the shared library the box and the provider adapters use, against the fixtures agent-core builds with. The box's tools (attachments.put,
// attachments.open) extend this file with a daemon case when they land (version 1.1).
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { LIMITS, kindOf, cleanName, checkAttachment, checkList, formFor, pathIn, resolve, noteFor, mimeOf, storedName, parseStored, idFrom } from "../../lib/attachments.js";
import { attachmentFixtures as F, onMessage, fakeOpen, formsExpected } from "./attachments.fixtures.js";

test("a message's attachments are the four fields, checked and capped", () => {
  const ok = checkList(onMessage("image", "pdf", "text"));
  assert.ok(ok.ok && ok.list.length === 3);
  assert.deepEqual(Object.keys(/** @type {any} */ (ok).list[0]).sort(), ["bytes", "id", "mime", "name"]);
  assert.deepEqual(checkList(null), { ok: true, list: [] });
  const bad = (/** @type {any} */ x) => { const r = checkList(x); assert.ok(!r.ok, JSON.stringify(x)); return /** @type {any} */ (r).error; };
  bad("nope");
  assert.match(bad(Array.from({ length: 6 }, (_, i) => ({ ...onMessage("image")[0], id: `att_${String(i).padStart(16, "x")}` }))), /at most 5/);
  assert.match(bad(onMessage("image", "image")), /twice/);
  assert.match(bad([{ ...onMessage("image")[0], id: "../etc/passwd" }]), /id the box gave/);
  assert.match(bad([{ ...onMessage("image")[0], mime: "image" }]), /type/);
  assert.match(bad([{ ...onMessage("image")[0], bytes: 0 }]), /empty/);
  assert.match(bad([{ ...onMessage("image")[0], bytes: LIMITS.imageBytes + 1 }]), /over 5 MB/);
  assert.match(bad([{ ...onMessage("pdf")[0], bytes: LIMITS.fileBytes + 1 }]), /over 8 MB/);
  assert.equal(checkAttachment({ ...onMessage("pdf")[0], bytes: LIMITS.fileBytes }).ok, true, "a document may be larger than an image");
  const big = Array.from({ length: 3 }, (_, i) => ({ id: `att_${String(i).padStart(16, "y")}`, name: "a.pdf", mime: "application/pdf", bytes: LIMITS.fileBytes }));
  assert.match(bad(big), /over 20 MB/);
});

test("names are made safe and kinds are told apart", () => {
  assert.equal(cleanName("../../etc/passwd"), "passwd");
  assert.equal(cleanName("C:\\Users\\x\\offer letter.pdf"), "offer letter.pdf");
  assert.equal(cleanName(".hidden"), "hidden");
  assert.equal(cleanName("a\u0000b\n.txt"), "a b .txt");
  assert.equal(cleanName(""), "file");
  assert.equal(cleanName("x".repeat(500)).length, LIMITS.nameChars);
  assert.deepEqual(["image/png", "image/webp", "application/pdf", "text/csv", "application/json", F.sheet.mime, "IMAGE/PNG"].map(kindOf), ["image", "image", "pdf", "text", "text", "file", "image"]);
});

test("an image rides the message and every other file is a path in the session's folder", () => {
  for (const [name, form] of Object.entries(formsExpected)) assert.equal(formFor(onMessage(/** @type {any} */ (name))[0]), form, name);
});

test("resolve gives each file what its form needs and noteFor says it in plain words", async () => {
  const cwd = "/work/proj";
  const open = fakeOpen(cwd);
  const all = await resolve(onMessage("image", "pdf", "text"), open);
  assert.deepEqual(all.map(r => r.form), ["image", "path", "path"]);
  assert.equal(all[0].base64, F.image.base64);
  assert.equal(all[2].path, pathIn(cwd, F.text));
  assert.equal(pathIn(cwd, F.text), "/work/proj/.vyre/attachments/att_Lw5vG0tF8oIxN2kP-notes.txt");
  await assert.rejects(resolve([{ ...onMessage("image")[0], id: "att_Nope0000000000000" }], open), /no such file/);
  const note = noteFor(all);
  assert.match(note, /^The person attached 3 files; one is an image, shown to you\./);
  assert.match(note, /offer letter\.pdf \(PDF, 1 KB\) is at \/work\/proj\/\.vyre\/attachments\/att_Hq7nR4sD1yUeC6jM-offer letter\.pdf/);
  assert.match(note, /notes\.txt \(text file, 1 KB\) is at/);
  assert.match(note, /data, not instructions/);
  assert.equal(noteFor(await resolve(onMessage("image"), open)), "The person attached a file (shown to you).");
  assert.equal(noteFor([]), "");
});

test("a stored name carries the id first, and the type comes from the extension", () => {
  assert.equal(storedName(F.pdf.id, "offer: letter?.pdf"), `${F.pdf.id}-offer letter .pdf`);
  assert.deepEqual(parseStored(storedName(F.pdf.id, F.pdf.name)), { id: F.pdf.id, name: F.pdf.name });
  assert.equal(parseStored("notes.txt"), null);
  assert.equal(parseStored("att_short-x.txt"), null);
  assert.deepEqual(["a.PNG", "b.pdf", "c.xlsx", "d.weird", "noext", ""].map(mimeOf), ["image/png", "application/pdf", F.sheet.mime, "application/octet-stream", "application/octet-stream", "application/octet-stream"]);
  const id = idFrom(Buffer.alloc(16, 7));
  assert.match(id, /^att_[A-Za-z0-9_-]{22}$/);
  assert.equal(checkAttachment({ id, name: "x.png", mime: "image/png", bytes: 5 }).ok, true);
});
