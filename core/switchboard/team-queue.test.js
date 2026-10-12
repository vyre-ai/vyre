// @ts-check
// A chat in a TEAM Space on the real daemon (a second session engine, as core/daemon/index.js spaceOfThread routes it): the owner's turn is running, a member's message queues behind it and is delivered as her own
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
/** @type {string[]} */ const LOGS = [];
const ANA = "per_" + "bcdefghijklmnopqrstuvwxyza";
const proof = () => ({ op: "stand-in", fields: {}, n: Math.random() });

test("a member's message queued behind the owner's Codex turn in a TEAM Space chat hops onto her own account and is answered in that Space", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, PATH: process.env.PATH };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  // the stand-in codex-acp first on PATH: the fake ACP agent, signed in as a login account (core/stream/person-turns-live.test.js withCodex)
  const shim = path.join(root, "shim"); fs.mkdirSync(shim, { recursive: true });
  fs.symlinkSync(path.resolve(CORE, "sessions", "testing", "fake-acp.js"), path.join(shim, "codex-acp"));
  const store = path.join(root, "acp-store"); fs.mkdirSync(store, { recursive: true });
  Object.assign(process.env, { PATH: `${shim}:${process.env.PATH}`, FAKE_ACP_STORE: store, FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } for (const k of ["FAKE_ACP_STORE", "FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE"]) delete process.env[k]; });
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = asOwner(await start({ root, presence: present, log: m => LOGS.push(String(m)), kernel: true }), root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const OWNER = d.kernel.id.owner;
  const firm = await d.kernel.spaces.host({ owner: OWNER, name: "Harlow Legal" });
  const ownerIn = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-owner", person: OWNER, path: "direct", session: "s" });
  await firm.gateway.grants.setRole(ownerIn, { person: ANA, role: "member" }, { presence: proof() });
  const chat = await firm.gateway.grants.chats.create(ownerIn, { people: [ANA] });
  const db = d.registry.deps.db;
  const events = async (/** @type {string} */ id) => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "module:stream")).data.events;
  const own = async (/** @type {string} */ label, /** @type {string} */ person, /** @type {any} */ meta) => {
    const r = await d.registry.call("sessions.accounts.add", { provider: "codex", label, kind: "login" }, "deck", meta);
    assert.ok(!r.error, JSON.stringify(r.error));
    db.prepare("UPDATE sessions_accounts SET signed_in_at = ?, person = ? WHERE id = ?").run(Date.now(), person, r.data.id);
    return r.data.id;
  };
  const anaIn = firm.kernel.chains.fromFacts({ kind: "device", device_key_id: "vyred", person: ANA, path: "direct" });
  const ownersAcct = await own("Owner's Codex", OWNER, undefined);
  const anasAcct = await own("Ana's Codex", ANA, { token: (await firm.kernel.surfaces.open(anaIn, {})).token });
  // the owner's slow Codex turn in the team's chat, then Ana's message queued behind it: it must hop onto Ana's own account, in the team's Space
  const r = await d.registry.call("threads.start", { cwd: work, prompt: "walk-term:sleep 5; echo slow-done", surface: "deck", provider: "codex", account: ownersAcct, chat: chat.id, asker: OWNER, space: firm.space }, "module:stream");
  assert.ok(r.data, JSON.stringify(r));
  const id = r.data.id;
  await new Promise(x => setTimeout(x, 1500));
  const q = await d.registry.call("threads.send", { thread: id, text: "whoami anaQ1", surface: "deck", chat: chat.id, asker: ANA, space: firm.space }, "module:stream");
  assert.ok(q.data && !q.error, JSON.stringify(q));
  const diag = async () => { const ev = await events(id); return `events: ${ev.filter((/** @type {any} */ e) => /^thread\.(sent|queued|provider|stopped|finished|started)$/.test(e.type)).map((/** @type {any} */ e) => e.type.replace("thread.", "") + ":" + String(e.payload && (e.payload.text || e.payload.reason || e.payload.error || "")).slice(0, 80)).join(" | ")}; log: ${LOGS.slice(-14).map(l => l.slice(0, 160)).join(" / ")}`; };
  await until(async () => { const ev = await events(id); return ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "once" && e.payload.account === anasAcct) || ev.some((/** @type {any} */ e) => e.type === "thread.sent" && e.payload.text === "whoami anaQ1" && /could not|dropped/.test(JSON.stringify(e))); }, "Ana's message to hop onto her own account", 60_000).catch(async e => { throw new Error(e.message + "; " + await diag()); });
  const ev = await events(id);
  assert.ok(ev.some((/** @type {any} */ e) => e.type === "thread.provider" && e.payload.reason === "once" && e.payload.account === anasAcct), "her turn ran on her own account, hopped in the team's Space: " + JSON.stringify(ev.filter((/** @type {any} */ e) => /thread\.(sent|provider|stopped|finished)/.test(e.type)).map((/** @type {any} */ e) => e.type + ":" + String(e.payload && (e.payload.text || e.payload.reason || "")).slice(0, 60))));
  await until(async () => (await events(id)).filter((/** @type {any} */ e) => e.type === "thread.finished").length >= 2, "both turns to end", 90_000);
  assert.ok(!LOGS.some(l => /no kernel session/.test(l)), "her hopped turn found its kernel session in the team's Space: " + LOGS.filter(l => /no kernel session/.test(l)).join(" / "));
  assert.ok(!(await events(id)).some((/** @type {any} */ e) => /reply was dropped|no session came back|could not be started/.test(JSON.stringify(e))), "no reply was dropped");
});
