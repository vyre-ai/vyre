// A chat thread with nobody's turn in flight has no authority: the hop back after a member's one-turn account must not leave the group chat's thread under the OWNER's session (a member's lingering process would then be
// stamped as the owner and walk through every per-person check, the vault gate included). A real vyred with the real kernel; the fake Claude is the provider. A test box, never a Mac.
import "../../scripts/mac-test-guard.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { start } from "../daemon/index.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { SCRATCH } from "../../test/scratch.mjs";
import { until, FAKE } from "../sessions/testing/boot.js";

process.env.VYRE_SEAL_DEV = "1";
process.env.VYRE_KERNEL_PATH_RULE = "1";
process.env.VYRE_SESSION_SANDBOX_OFF = "1";
const BOB = "per_" + "b".repeat(26);

test("the hop back after a member's one-turn account leaves the chat thread with no session; the next real turn opens its own asker's; a plain send never rides a turn's session", { timeout: 180_000 }, async t => {
  const root = tempHome(t);
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS };
  const transcripts = path.join(root, "transcripts");
  Object.assign(process.env, { VYRE_CLAUDE_BIN: FAKE, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" }, vault: { keystore: "file" } }));
  const d = asOwner(await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null } }), root);
  t.after(() => d.stop());
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "vyre-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const owner = d.kernel.id.owner;
  const chainOf = (/** @type {string} */ person) => d.kernel.chains.fromFacts({ kind: "device", device_key_id: "dev-" + person.slice(4, 10), person, path: "direct", session: "s1" });
  await d.kernel.gateway.grants.setRole(chainOf(owner), { person: BOB, role: "member" }, { presence: { method: "stand-in" } });
  const chat = await d.kernel.gateway.grants.chats.create(chainOf(owner), { people: [BOB] });
  const db = d.registry.deps.db;
  const turnOf = (/** @type {string} */ id) => { const r = db.prepare("SELECT body FROM kernel_turns WHERE thread = ?").get(id); return r ? JSON.parse(r.body) : null; };
  const fin = async (/** @type {string} */ id, /** @type {number} */ n) => until(async () => (await d.registry.call("threads.get", { thread: id, limit: 500 }, "cli")).data.events.filter((/** @type {any} */ e) => e.type === "thread.finished").length >= n, `turn ${n}`);
  // bob's own sign-in (an account belongs to a person), so his turn is a one-turn hop onto it and back
  const bobTok = (await d.kernel.surfaces.open(chainOf(BOB), {})).token;
  const added = await d.registry.call("sessions.accounts.add", { provider: "claude", label: "bob's Claude", kind: "login" }, "deck", { token: bobTok });
  assert.ok(!added.error, JSON.stringify(added.error));
  db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);

  const r = await d.registry.call("threads.start", { cwd: work, prompt: "first", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(r.data, JSON.stringify(r.error));
  const id = r.data.id;
  await fin(id, 1);
  console.log("DBG|", JSON.stringify(db.prepare("SELECT thread, body FROM kernel_turns").all()).slice(0, 400), "|", id);
  assert.equal(turnOf(id)?.person, owner, "the owner's turn is under the owner's session");

  const sent = await d.registry.call("threads.send", { thread: id, text: "bob asks", surface: "deck", chat: chat.id, asker: BOB }, "module:stream");
  assert.ok(sent.data && !sent.error, JSON.stringify(sent.error));
  await fin(id, 2);
  assert.equal(turnOf(id)?.person, BOB, "bob's turn was under bob's session");
  // the one-turn hop is over and the thread went back to its own provider (a launch with no chat turn): nobody's turn is in flight
  await until(async () => { const th = (await d.registry.call("threads.get", { thread: id }, "cli")).data.thread; return th && th.status !== "working" && !(th.once); }, "the hop back to finish");
  await new Promise(r2 => setTimeout(r2, 1500));
  const open = turnOf(id);
  assert.ok(!open || open.person !== owner, `no session of the OWNER's is held for the chat thread while nobody's turn is in flight: ${JSON.stringify(open)}`);
  const asked = await d.registry.deps.kernelSession({ thread: id, agent: null, rec: { chat: chat.id } });
  assert.equal(asked, null, "the daemon opens no session for a chat thread with no verified asker");
  const mine = await d.registry.deps.kernelSession({ thread: "own-thread", agent: null, rec: {} });
  assert.ok(mine && typeof mine.token === "function", "the owner's own thread, in no chat, keeps its session");
  await mine.end();

  // the next real turn (the owner's) opens its own asker's session
  const next = await d.registry.call("threads.send", { thread: id, text: "owner again", surface: "deck", chat: chat.id, asker: owner }, "module:stream");
  assert.ok(next.data && !next.error, JSON.stringify(next.error));
  await fin(id, 3);
  assert.equal(turnOf(id)?.person, owner, "and the next turn opens its own asker's session");
});
