// @ts-check
// A key typed or pasted into a chat never reaches a model, from any surface (R031-68). Each chat entry (threads.start, threads.send, threads.edit-retry, stream.send) refuses text that holds a key
// shaped like a vendor's, by the one detector (lib/credential-shapes.js), before anything is stored or handed to a turn; the refusal names the kind and never the value. A vault reference passes.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present, asOwner } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";

// Built at run time so this file holds no string a scanner reads as a real key.
const KEY = "sk-" + "ant-" + "a1B2".repeat(8);

test("a raw key sent through each surface's chat tools is refused before any turn sees it; a vault reference goes through", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true });
  asOwner(d, root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const call = (/** @type {string} */ tool, /** @type {any} */ input, /** @type {string} */ caller = "cli", /** @type {any} */ meta) => d.registry.call(tool, input, caller, meta);
  /** @param {any} r */ const refused = (r, who = "") => { assert.equal(r.error && r.error.code, "secret_in_message", `${who}: ${JSON.stringify(r)}`); assert.ok(!JSON.stringify(r).includes(KEY), "the refusal never repeats the key"); assert.match(r.error.message, /Anthropic key/); };

  // threads.start from the person's surfaces (cli, deck, capsule, mobile): no session is made
  for (const caller of ["cli", "local", "deck", "capsule", "mobile"]) refused(await call("threads.start", { cwd: work, prompt: `use ${KEY} please`, surface: "deck" }, caller));
  assert.deepEqual((await call("threads.list", { all: true })).data, [], "no thread was started by a refused prompt");

  const ok = await call("threads.start", { cwd: work, prompt: "use vault://anthropic-key please", surface: "deck" });
  assert.ok(ok.data && ok.data.id, JSON.stringify(ok));
  const id = ok.data.id;

  // threads.send, by each surface and by a model's call
  for (const caller of ["cli", "local", "deck", "capsule", "mobile", "mcp", "harness"]) refused(await call("threads.send", { thread: id, text: `here: ${KEY}`, surface: "deck" }, caller, caller === "mcp" || caller === "harness" ? { thread: id } : undefined), caller);
  refused(await call("threads.edit-retry", { thread: id, text: `again ${KEY}` }));
  refused(await call("stream.send", { chat: "chat-none", text: `to the group ${KEY}` }));
  // the same reference a person sends goes through
  const sent = await call("threads.send", { thread: id, text: "ok, vault://anthropic-key is the one", surface: "deck" });
  assert.ok(!sent.error || sent.error.code !== "secret_in_message", JSON.stringify(sent));

  // nothing the box holds or handed to a turn carries the key: the thread's events, and every transcript the fake Claude wrote
  assert.ok(!JSON.stringify((await call("threads.get", { thread: id, limit: 500 })).data).includes(KEY), "not in the thread");
  for (const f of fs.readdirSync(transcripts, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath ?? f.path, f.name), "utf8").includes(KEY), `not in ${f.name}`);
});
