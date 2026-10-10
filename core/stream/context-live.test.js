// @ts-check
// A chat message on a real daemon (kernel on, the person's own session): the stream reads the files the person attached and the record they named under their own chain, and the assistant hears an image
// inline, a file as a path and a card of the record, while the chat itself shows only the person's words and the attachments' names.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";
import { CONTACT } from "../../kernel/conformance/suite.js";
import { attachmentFixtures as F } from "../../test/contracts/attachments.fixtures.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

test("a message with a named record and attached files reaches the assistant as a card, an image and a path; the chat shows the words and the names", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } });
  asOwner(d, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const call = (tool, input, caller = "cli") => d.registry.call(tool, input, caller);
  const ok = async (tool, input) => { const r = await call(tool, input); assert.ok(!r.error, `${tool}: ${JSON.stringify(r)}`); return r.data; };
  const owner = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s1" });
  await d.kernel.gateway.records.define(owner, { add_types: [CONTACT] });
  const dana = (await ok("records.create", { type: "contact", data: { name: "Dana Whitfield", age: 52, status: "open" } })).record;
  await ok("records.seal-put", { urn: dana.urn, field: "ssn", value: "123-45-6789", class: "us-ssn" });

  const th = await ok("threads.start", { cwd: work, prompt: "hello", surface: "cli" });
  const chat = (await ok("threads.get", { thread: th.id, limit: 1 })).thread.chat;
  assert.match(chat, /^chat_/);
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 50 })).events.some(e => e.type === "thread.finished"), "the first turn");
  const pdf = await ok("attachments.put", { thread: chat, name: F.pdf.name, data: F.pdf.base64 });
  const png = await ok("attachments.put", { thread: chat, name: F.image.name, data: F.image.base64 });
  assert.deepEqual((await ok("attachments.list", { thread: chat })).attachments.map(a => a.id).sort(), [pdf.id, png.id].sort());

  // refused before anything is stored: a file that is not this chat's
  const before = (await ok("stream.open", { chat })).frames?.length;
  const bad = await call("stream.send", { chat, text: "this", attachments: [{ ...pdf, id: "att_Nope0000000000000000" }] });
  assert.equal(bad.error && bad.error.code, "bad_input", JSON.stringify(bad));
  if (before !== undefined) assert.equal((await ok("stream.open", { chat })).frames.length, before, "nothing was stored");

  const sent = await call("stream.send", { chat, text: "What is Dana Whitfield's age? Read the files.", attachments: [pdf, png] });
  assert.ok(!sent.error, JSON.stringify(sent));
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 200 })).events.filter(e => e.type === "thread.finished").length >= 2, "the second turn");
  const said = (await ok("threads.get", { thread: th.id, limit: 200 })).events.filter(e => e.type === "thread.text" && e.payload.done && !e.payload.notice).map(e => e.payload.text).at(-1);
  assert.match(said, /What is Dana Whitfield's age\? Read the files\./);
  assert.match(said, /\[Vyre record card, from the person's own words naming "Dana Whitfield"/);
  assert.match(said, /SSN: \{\{field:[^}]+#ssn\}\} \(sealed\)/);
  assert.ok(!said.includes("123-45-6789"), "the value is nowhere");
  assert.match(said, /The person attached 2 files; one is an image, shown to you\./);
  const file = path.join(work, ".vyre", "attachments", `${pdf.id}-${F.pdf.name}`);
  assert.ok(said.includes(file) && fs.existsSync(file), "the pdf is a path in the assistant's folder");
  assert.match(said, /\(\+1 images?\)/, "the image went with the words");
  // the chat shows the person's words and the names of the files, nothing the assistants were told besides
  const open = await ok("stream.open", { chat });
  const mine = (open.frames || []).filter(f => f.type === "chat.user-message").at(-1);
  assert.equal(mine.data.text, "What is Dana Whitfield's age? Read the files.");
  assert.deepEqual(mine.data.attachments.map(a => a.name), [F.pdf.name, F.image.name]);
});
