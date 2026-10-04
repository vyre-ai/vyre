// @ts-check
// Adoption (the owner claims an identity and the kernel replaces the owner's local id): sessions and queued words written under the old id are still the person's. Real daemon, kernel on.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const A = "per_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const spacesNeed = { name: "spaces", needs: { kernel: { actions: [], spaces: true } } };

test("sessions survive adoption: a thread started before is still listed, a kernel turn stored under the old id reopens as the identity, a queued turn reads as the identity's", { timeout: 120_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  let d = await start({ root, presence: present, log: () => {}, kernel: true });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const old = d.kernel.id.owner;
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck" }, "cli");
  assert.ok(r.data && r.data.id, JSON.stringify(r));
  await d.kernel.kernelFor(spacesNeed).adoptOwner(A);
  assert.equal(d.kernel.id.owner, A);
  await d.stop();
  d = await start({ root, presence: present, log: () => {}, kernel: true });
  t.after(() => d.stop());
  assert.equal(d.kernel.id.owner, A, "the next start reads the adoption");
  const listed = (await d.registry.call("threads.list", {}, "cli")).data;
  assert.ok(listed.some((/** @type {any} */ x) => x.id === r.data.id), "the thread started before adoption is still listed");
  // a kernel session asked for under the OLD id opens as the identity (a stored turn, a queued message)
  const ks = await d.registry.deps.kernelSession({ thread: r.data.id, agent: null, asker: old, probe: false });
  assert.ok(ks, "a session for the old id opens");
  assert.equal(d.kernel.kernelFor(spacesNeed).canonicalPerson(old), A);
  // a queued turn key written under the old id reads as the identity
  const sb = d.registry.deps.switchboard;
  if (sb && typeof sb.canonTurn === "function") assert.equal(sb.canonTurn(JSON.stringify({ chat: "c", asker: old })), JSON.stringify({ chat: "c", asker: A }));
});
