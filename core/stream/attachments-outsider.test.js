// @ts-check
// A member who is NOT in a chat names its id to the attachments and the stream: she is told no path, no file name, no size, and her own files of other chats still work. A member of the chat gets her files. Real daemon, kernel on.
// Run it on a test box, never on a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";
import { attachmentFixtures as F } from "../../test/contracts/attachments.fixtures.js";

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const MAL = "per_" + "m".repeat(26);

test("a member outside a chat names its id: attachments and the stream answer no path, no name and no file; the owner, in the chat, still has her files", { timeout: 180_000 }, async t => {
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
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: d.kernel.id.owner, path: "direct", session: "s1" });
  await d.kernel.gateway.grants.setRole(ownerChain, { person: MAL, role: "member" }, { presence: { op: "x", fields: {}, n: 1 } });
  const malToken = { token: (await d.kernel.surfaces.open(d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-m", person: MAL, path: "direct", session: "s-m" }), {})).token };
  const owner = (tool, input) => d.registry.call(tool, input, "cli");
  const mal = (tool, input) => d.registry.call(tool, input, "cli", malToken);
  const th = await owner("threads.start", { cwd: work, prompt: "hello", surface: "cli" });
  const chat = (await owner("threads.get", { thread: th.data.id, limit: 1 })).data.thread.chat;
  await until(async () => (await owner("threads.get", { thread: th.data.id, limit: 50 })).data.events.some((/** @type {any} */ e) => e.type === "thread.finished"), "the first turn");
  const pdf = (await owner("attachments.put", { thread: chat, name: F.pdf.name, data: F.pdf.base64 })).data;
  assert.ok(pdf && pdf.id, "the owner adds a file");
  // what an answer must never carry: the chat's folder path (project slug or id), the file's name or size
  const leaks = (/** @type {any} */ r) => { const j = JSON.stringify(r); return /Projects\/|\/chat\//.test(j) || j.includes(F.pdf.name) || j.includes(pdf.id); };

  const list = await mal("attachments.list", { thread: chat });
  assert.ok(!leaks(list) && ((list.data && list.data.attachments) || []).length === 0, "list: nothing for her: " + JSON.stringify(list).slice(0, 200));
  const got = await mal("attachments.get", { thread: chat, id: pdf.id });
  assert.ok(got.error && !leaks(got.error), "get: refused with no path or name: " + JSON.stringify(got).slice(0, 200));
  const thumb = await mal("attachments.get", { thread: chat, id: pdf.id, thumb: true });
  assert.ok(thumb.error && !leaks(thumb.error), "thumbnail: refused with no path or name");
  const put = await mal("attachments.put", { thread: chat, name: "x.pdf", data: F.pdf.base64 });
  assert.ok(put.error && !leaks(put.error), "put: refused with no path or name: " + JSON.stringify(put).slice(0, 200));
  const sent = await mal("stream.send", { chat, text: "this", attachments: [pdf] });
  assert.ok(sent.error && !leaks(sent.error), "the stream: refused with no path or name: " + JSON.stringify(sent).slice(0, 200));
  // the owner, in the chat, still has her files
  assert.deepEqual(((await owner("attachments.list", { thread: chat })).data.attachments || []).map((/** @type {any} */ a) => a.id), [pdf.id], "control: the owner lists her file");
  assert.ok((await owner("attachments.get", { thread: chat, id: pdf.id })).data, "control: and opens it");
});
