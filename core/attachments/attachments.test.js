// @ts-check
// Attachments on a real daemon: a file added to a chat is kept sealed in the chat's own folder, a message names it by id, the model hears an image inline and any other file as a path with one sentence, and a
// file that is not this chat's, a model's try and a bad list are all refused before anything is said.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { boot } from "../sessions/testing/boot.js";
import { attachmentFixtures as F } from "../../test/contracts/attachments.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";

test("add a file to a chat, attach it to a message, and the model hears it; the wrong chat, a model and a bad list are refused", { timeout: 180_000 }, async t => {
  const w = await boot(t, { kernel: true });
  const ok = async (tool, input) => { const r = await w.tool(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const th = await ok("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" });
  await w.finished(th.id);
  const other = await ok("threads.start", { cwd: w.work, prompt: "hello", surface: "deck" });
  await w.finished(other.id);

  const pdf = await ok("attachments.put", { thread: th.id, name: F.pdf.name, data: F.pdf.base64 });
  const png = await ok("attachments.put", { thread: th.id, name: F.image.name, data: F.image.base64 });
  assert.match(pdf.id, /^att_[A-Za-z0-9_-]{22}$/);
  assert.deepEqual([pdf.name, pdf.mime, pdf.bytes], [F.pdf.name, "application/pdf", Buffer.from(F.pdf.base64, "base64").length]);
  assert.equal(png.mime, "image/png");
  assert.deepEqual((await ok("attachments.list", { thread: th.id })).attachments.map(a => a.id).sort(), [pdf.id, png.id].sort());
  assert.deepEqual((await ok("attachments.list", { thread: other.id })).attachments, [], "the other chat has none");
  // the chat's Files panel shows them by name, not by id
  const files = (await ok("work.file.list", { chat: th.id })).files;
  assert.ok(files.some(f => f.name.includes(F.pdf.name)), JSON.stringify(files));

  // refused: a model, a bad body, a file that is too big, a chat that is not there
  assert.ok((await w.tool("attachments.put", { thread: th.id, name: "x.txt", data: "aGk=" }, "mcp")).error, "a model does not add files for the person");
  assert.equal((await w.tool("attachments.put", { thread: th.id, name: "x.txt", data: "not base64!" })).error.code, "bad_input");
  assert.equal((await w.tool("attachments.put", { thread: th.id, name: "big.pdf", data: Buffer.alloc(9 * 1024 * 1024).toString("base64") })).error.code, "bad_input");
  assert.ok((await w.tool("attachments.put", { thread: "nope", name: "x.txt", data: "aGk=" })).error);

  // the message names them; the model hears the image inline and the pdf as a path
  const sent = await w.tool("threads.send", { thread: th.id, text: "Please read these", surface: "deck", attachments: [pdf, png] });
  assert.ok(!sent.error, JSON.stringify(sent));
  await w.finished(th.id, 2);
  const heard = (await w.said(th.id)).at(-1);
  assert.match(heard, /Please read these/);
  assert.match(heard, /The person attached 2 files; one is an image, shown to you\./);
  const made = path.join(w.work, ".vyre", "attachments", `${pdf.id}-${F.pdf.name}`);
  assert.ok(heard.includes(made), "the model is told where the file is");
  assert.ok(fs.readFileSync(made).equals(Buffer.from(F.pdf.base64, "base64")), "the file is there, whole");
  assert.equal(fs.readFileSync(path.join(w.work, ".vyre", "attachments", ".gitignore"), "utf8"), "*\n");
  assert.match(heard, /\(\+1 images?\)/, "the image went with the words");
  const turn = (await w.events(th.id)).filter(e => e.type === "thread.turn").at(-1);
  assert.ok(!/The person attached/.test(JSON.stringify(turn.payload.text)), "the transcript keeps the person's words only");

  // refused before anything is said: another chat's file, a made-up id, a bad list, a model's send
  const before = (await w.events(th.id)).filter(e => e.type === "turn.said").length;
  const elsewhere = await ok("attachments.put", { thread: other.id, name: "private.txt", data: "aGk=" });
  assert.equal((await w.tool("threads.send", { thread: th.id, text: "this one", surface: "deck", attachments: [elsewhere] })).error.code, "bad_input");
  assert.equal((await w.tool("threads.send", { thread: th.id, text: "this one", surface: "deck", attachments: [{ ...pdf, id: "att_Nope0000000000000000" }] })).error.code, "bad_input");
  assert.equal((await w.tool("threads.send", { thread: th.id, text: "this one", surface: "deck", attachments: [pdf, pdf] })).error.code, "bad_input");
  assert.equal((await w.events(th.id)).filter(e => e.type === "turn.said").length, before, "nothing was said");
});
