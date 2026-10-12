// @ts-check
// A member switching a chat's provider names only an account that is hers (12 Oct): threads.switch and threads.chat-switch share the switch path, which now judges the asker as a launch does (memberAccount).
// turn. The Space rides with the queued row; a delivery that dropped it asked the HOME's kernel for a session in a chat only the team's kernel holds, "no session came back; the reply was dropped" (12 Oct 2026).
// The hop onto a member's own account (runQueuedOver) carries the Space too: core/switchboard/hop-revert.test.js holds that unit; this is the delivery on the real Switchboard, kernel and fake claude.
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
import { fileURLToPath } from "node:url";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.VYRE_SEAL_DEV = "1"; process.env.VYRE_KERNEL_PATH_RULE = "1"; process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a member who switches a chat's provider cannot name the owner's account: refused in words, the thread unchanged; her own account is taken; the owner is as before", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, PATH: process.env.PATH };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  const shim = path.join(root, "shim"); fs.mkdirSync(shim, { recursive: true });
  fs.symlinkSync(path.resolve(CORE, "sessions", "testing", "fake-acp.js"), path.join(shim, "codex-acp"));
  const store = path.join(root, "acp-store"); fs.mkdirSync(store, { recursive: true });
  Object.assign(process.env, { PATH: `${shim}:${process.env.PATH}`, FAKE_ACP_STORE: store, FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } for (const k of ["FAKE_ACP_STORE", "FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE"]) delete process.env[k]; });
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = asOwner(await start({ root, presence: present, log: () => {}, kernel: true }), root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const OWNER = d.kernel.id.owner;
  const firm = { kernel: d.kernel, gateway: d.kernel.gateway, space: d.kernel.id.space };
  const ownerIn = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.grants.setRole(ownerIn, { person: ANA, role: "member" }, { presence: proof() });
  const chat = await firm.gateway.grants.chats.create(ownerIn, { people: [ANA] });
  const db = d.registry.deps.db;
  const own = async (/** @type {string} */ label, /** @type {string} */ person, /** @type {any} */ meta) => {
    const r = await d.registry.call("sessions.accounts.add", { provider: "codex", label, kind: "login" }, "deck", meta);
    assert.ok(!r.error, JSON.stringify(r.error));
    db.prepare("UPDATE sessions_accounts SET signed_in_at = ?, person = ? WHERE id = ?").run(Date.now(), person, r.data.id);
    return r.data.id;
  };
  const anaIn = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: ANA, path: "direct" });
  const anaTok = { token: (await firm.kernel.surfaces.open(anaIn, {})).token };
  const ownersAcct = await own("Owner's Codex", OWNER, undefined);
  const anasAcct = await own("Ana's Codex", ANA, anaTok);
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "hello", surface: "deck", provider: "claude", chat: chat.id, asker: OWNER }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  const id = r.data.id;
  await until(async () => { const row = db.prepare("SELECT status FROM threads_runs WHERE id = ?").get(id); return row && ["finished", "idle", "stopped"].includes(row.status); }, "the first turn to end", 90_000);
  const row = () => db.prepare("SELECT provider, account FROM threads_runs WHERE id = ?").get(id);
  const before = { ...row() };
  const bad = await d.registry.call("threads.switch", { thread: id, provider: "codex", account: ownersAcct }, "deck", anaTok);
  assert.ok(bad.error, "naming the owner's account is refused: " + JSON.stringify(bad));
  assert.match(String(bad.error.message), /not yours|sign-in of your own/);
  assert.deepEqual({ ...row() }, before, "and the thread row is unchanged");
  const mine = await d.registry.call("threads.switch", { thread: id, provider: "codex", account: anasAcct }, "deck", anaTok);
  assert.ok(!mine.error, "her own account is taken: " + JSON.stringify(mine.error));
  assert.equal(row().account, anasAcct, "the thread now runs on her account");
  await new Promise(x => setTimeout(x, 500));
  await until(async () => { const r2 = db.prepare("SELECT status FROM threads_runs WHERE id = ?").get(id); return r2 && ["finished", "idle", "stopped"].includes(r2.status); }, "her continuation turn to end", 90_000);
  const ours = await d.registry.call("threads.switch", { thread: id, provider: "codex", account: ownersAcct }, "deck");
  assert.ok(!ours.error, "the owner switches as before: " + JSON.stringify(ours.error));
  assert.equal(row().account, ownersAcct);
});
