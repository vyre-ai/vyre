// @ts-check
// G01 WALK with a REAL Claude and the REAL vault (the home's own lent service, the sign-in token put through onboard.claude) (never run by the suite: it needs G01_CLAUDE=<path to the claude program> and G01_TOKEN_FILE=<file holding a Claude setup token>). A chat that runs on a person's own computer, end to end (R031-95 part B; contracts/lent-spawn.md v1.3). A real daemon (kernel on, the real switchboard and stream) is the home; a lender (the runner module, in the real
// sandbox, with a fake Claude) is the person's computer. The first message of a new chat is placed on the computer at creation, the process runs there, the answer comes back into the chat, and the chat says where it runs. (A lent session reaching Vyre's tools through the home is core/runner/lent-pipe-runner.test.js, which needs the fake agent that speaks the tool protocol.) The home's book and lender are link's test world (core/runner/testing/lent-rig.js) set as the daemon's lent home.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { createRemoteKernel } from "../../kernel/remote/client.js";
import { createMemoryTransport } from "../../kernel/remote/memory-transport.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import mod, { seams } from "./index.js";
import { startSealer } from "../../kernel/seal/client.js";
import * as seal from "../../kernel/seal/testing.js";
import { createRemoteServer } from "../../kernel/remote/server.js";
import { start } from "../daemon/index.js";
import { transcriptPlace } from "../switchboard/adopt.js";
import { lentRequest } from "../daemon/threadsock.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { until, FAKE } from "../sessions/testing/boot.js";

const SKIP = unavailable() || workspaceUnavailable() || "";
const PROVIDER_ALLOW = [{ method: "POST", path: "/v1/messages" }, { method: "POST", path: "/v1/messages/count_tokens" }, { method: "GET", path: "/v1/models" }];
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
/** The walk's own words, printed only for a proof run (VYRE_PROOF=1): what a person sees at each step. */
const say = (/** @type {string} */ m) => { if (process.env.VYRE_PROOF) console.log("[walk] " + m); };

test("G01 with a real Claude and the real vault: a chat on a member's own computer, to the server and back with its context, and a teammate's turn runs on the server", { skip: SKIP || (process.env.G01_CLAUDE && process.env.G01_TOKEN_FILE ? false : "set G01_CLAUDE and G01_TOKEN_FILE"), timeout: 1_200_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const agent = String(process.env.G01_CLAUDE);
  const TOKEN = fs.readFileSync(String(process.env.G01_TOKEN_FILE), "utf8").trim();   // never printed
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, HOME: process.env.HOME, VYRE_LENT_AGENT_DEV: process.env.VYRE_LENT_AGENT_DEV, VYRE_LENT_AGENT: process.env.VYRE_LENT_AGENT, VYRE_SEAL_DEV: process.env.VYRE_SEAL_DEV, VYRE_KERNEL_PATH_RULE: process.env.VYRE_KERNEL_PATH_RULE, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF, CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;   // the token comes from the vault, as it does for a person; no environment hands it to anything
  const root = tempHome(t);
  const walkHome = path.join(root, "walk-home");
  const transcripts = path.join(walkHome, ".claude", "projects");
  fs.mkdirSync(transcripts, { recursive: true });
  Object.assign(process.env, { VYRE_LENT_AGENT_DEV: "1", VYRE_LENT_AGENT: agent, VYRE_CLAUDE_BIN: agent, VYRE_SESSIONS_DRIVER: "cli", HOME: walkHome, VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  // the home: a real vyred, kernel on, with a development sealing process (the lease's sealer), the real vault and the real lent service of the home
  const sealer = startSealer({ dir: path.join(root, "seal"), timeoutMs: 8000, dev: true, unattested: true });
  t.after(() => sealer.close().catch(() => {}));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, kernelSealer: sealer,
    lentKeyOf: () => Buffer.alloc(32, 7) });   // a walk home has no storage pool yet: the lent store key is the one stand-in here (credentials, accounts and the vault are the real ones)
  asOwner(d, root);
  t.after(() => d.stop());
  const call = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => { const x = await call(tool, input); assert.ok(!x.error, `${tool}: ${JSON.stringify(x.error)}`); return x.data; };
  const ownerId = String(d.kernel.id.owner), SPACE = String(d.kernel.id.space);

  // the sign-in goes into the vault the way a person puts it there; the model route of a lent session and the box's own sessions both read it from there
  const stored = await d.registry.call("vault.put", { name: "claude-setup-token", kind: "secret", description: "Claude subscription token from `claude setup-token`, for headless sessions", value: TOKEN }, "cli");   // what onboard.claude writes once the server is paired; a walk home is not paired
  say(`0. the owner's Claude sign-in is put in the vault (vault.put, the item onboard.claude writes): ${stored.error ? "REFUSED " + JSON.stringify(stored.error) : "stored, signed in"}`);
  assert.ok(!stored.error, JSON.stringify(stored.error));
  const added = await d.registry.call("sessions.accounts.add", { provider: "claude", label: "walk subscription", kind: "setup-token", vault_item: "claude-setup-token", is_default: true }, "cli");
  say(`   the account is added the normal way (sessions.accounts.add, a setup-token account on the vault item): ${added.error ? "REFUSED " + JSON.stringify(added.error) : "added"}`);
  assert.ok(!added.error, JSON.stringify(added.error));
  const acct = /** @type {any} */ ((await d.registry.call("sessions.accounts.resolve", { provider: "claude" }, "module:vyred")).data);
  say(`   the account the lent session will use: kind ${acct && acct.kind}, vault item ${acct && acct.vault_item}`);

  /** @type {string[]} */ const doorCalls = [];
  const home = /** @type {any} */ (d.registry.deps).lentHome(SPACE);
  assert.ok(home, "the home's own lent service exists");
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: ownerId, path: "direct", session: "s1" });
  // the owner lends their own computer: the Space's side and their own, in one act (an owner is an admin)
  await d.kernel.gateway.grants.offers.lend(ownerChain, { member: ownerId, device: "dev_laptop", device_key: "dev_laptop" }, { presence: { method: "test" } });

  // the computer: the runner module, in the sandbox, connected to the home's own remote server
  const server = createRemoteServer({ space: SPACE, home: SPACE, kernel: d.kernel, log: () => {}, services: { lent: home } });
  const lenderRoot = fs.mkdtempSync(path.join(SCRATCH, "lce-lender-"));
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: server }, peer: { device_key_id: "dev_laptop", person: ownerId, path: "wink" } }) });
  /** @type {Map<string, any>} */ const tools = new Map();
  const handlers = new Map();
  const ctx = {
    paths: { root: lenderRoot }, config: { role: "local", name: "Office Mac" },
    events: { emit: (/** @type {string} */ type, /** @type {any} */ payload) => { if (/checkpoint|runner\./.test(type)) say(`   [computer] ${type} ${JSON.stringify(payload || {}).slice(0, 220)}`); for (const f of handlers.get(type) || []) f({ type }); }, on: (/** @type {string} */ type, /** @type {any} */ f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter((/** @type {any} */ x) => x !== f)); } },
    tool: (/** @type {string} */ n, /** @type {any} */ def) => tools.set(n, def),
    call: async (/** @type {string} */ name, /** @type {any} */ input) => (name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: null }),
    kernel: { owner: ownerId, chain: async () => ({ hops: [{ actor: { kind: "person", id: ownerId } }] }), for: () => ({ call: (/** @type {string} */ name, /** @type {any[]} */ args) => remote.call(name, args) }), runnerHost: () => ({ identity: async () => ({ deviceId: "eid_mac", deviceKey: "dev_laptop" }) }) },
    log: () => {}, space: SPACE,
  };
  seams.set(lenderRoot, { heartbeatMs: 150, beatTimeoutMs: 400, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  const lender = await mod.start(/** @type {any} */ (ctx));
  t.after(async () => { seams.delete(lenderRoot); await lender.stop(); });
  const run = (/** @type {string} */ tool, /** @type {any} */ input) => tools.get(tool).run(input, { caller: "cli" });
  await run("runner.start", { space: SPACE, session: "s0" });
  await sleep(1500);
  void doorCalls; void REPO;

  const placing = /** @type {any[]} */ ([]);
  /** @type {any[]} */ const resumed = [];
  d.events.on("runner.resumed", (/** @type {any} */ e) => resumed.push(e.payload || e));
  d.events.on("thread.placing", (/** @type {any} */ e) => placing.push(e.payload || e));
  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "lce-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const CAROL_ID = "per_" + "c".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: CAROL_ID, role: "member" }, { presence: { method: "test" } });
  const chatRow = await d.kernel.gateway.grants.chats.create(ownerChain, { people: [CAROL_ID] });
  const asPerson = (/** @type {string} */ who, /** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, { ...input, surface: "deck", chat: chatRow.id, asker: who }, "module:stream").then((/** @type {any} */ x) => { assert.ok(!x.error, `${tool}: ${JSON.stringify(x)}`); return x.data; });
  const asChat = (/** @type {string} */ tool, /** @type {any} */ input) => asPerson(ownerId, tool, input);
  /** @type {any} */ let th = null;
  const events = async () => (await ok("threads.get", { thread: th.id, limit: 600 })).events;
  const finishedN = async () => (await events()).filter((/** @type {any} */ e) => e.type === "thread.finished").length;
  const lastSaid = async () => String((await events()).filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => e.payload.text).at(-1));
  const turn = async (/** @type {string} */ label, /** @type {() => Promise<any>} */ send) => { const n = th ? await finishedN() : 0; const first = await send(); if (!th) th = first; try { await until(async () => (await finishedN()) > n, label, 240_000); } catch (e) { const ev = await events(); say(`   TIMED OUT; the last events: ${JSON.stringify(ev.slice(-14).map((/** @type {any} */ x) => ({ t: x.type, p: JSON.stringify(x.payload).slice(0, 240) })))}`); throw e; } const said = await lastSaid(); say(`   Claude said: ${JSON.stringify(said.slice(0, 200))}`); return said; };
  const where = () => home.book.get(th.id)?.where;
  const chatId = String(chatRow.id);

  say("1. the owner starts a chat from the phone; the chat is placed on the owner's own computer (a real Claude runs in the computer's sandbox)");
  let said = await turn("the first turn", () => asChat("threads.start", { cwd: work, prompt: "Remember two facts for later. Fact one: the word is PINEAPPLE. Reply with only the word: noted." }));
  assert.match(said, /noted/i, "a real Claude answered on the computer");
  say(`   where it runs: ${where()} (placing: ${JSON.stringify(placing.map(p => p.state))})`);
  assert.equal(where(), "mac");
  { const cp0 = await home.view(th.id).checkpoint(); say(`   the home holds the computer's checkpoint: ${cp0 ? JSON.stringify({ seq: cp0.seq, turn: cp0.turn, files: Object.keys(cp0.manifest || {}).length }) : "NONE"}`); }
  assert.ok(placing.some(p => p.state === "up"), "the chat said it is up on the computer");
  say("2. the person moves the chat to the server; the server carries on from the computer's last whole turn, and a new fact is told there");
  { const tt = await d.registry.call("threads.transcript-target", { thread: th.id }, "module:vyred", { door: true }); const rec = (await ok("threads.get", { thread: th.id, limit: 1 })).thread; say(`   (diagnostic) transcriptPlace by hand: ${JSON.stringify(transcriptPlace([transcripts], String(rec.cwd), th.id))}; folders ${transcripts}; files there: ${JSON.stringify(fs.existsSync(transcripts) ? fs.readdirSync(transcripts) : "none")}`);
  say(`   (diagnostic) transcript target before the move: ${JSON.stringify(tt.data)}; the thread: cwd=${rec.cwd} native=${rec.native || rec.session || "?"} provider=${rec.provider}`); }
  await ok("runner.move", { thread: chatId, to: "server" });
  await until(async () => where() === "server", "the chat is the server's", 120_000);
  say(`   where it runs: ${where()}; the server carried on from turn ${resumed[0] && resumed[0].turn} with ${resumed[0] && resumed[0].lines} lines of the computer's transcript`);
  said = await turn("a turn on the server", () => asChat("threads.send", { thread: th.id, text: "Fact two: the colour is TEAL. Reply with only the word: noted." }));
  assert.match(said, /noted/i);
  said = await turn("a recall on the server", () => asChat("threads.send", { thread: th.id, text: "What were the word and the colour I told you? Reply exactly as: word=<word> colour=<colour>" }));
  say(`   recall on the server: ${JSON.stringify(said)}`);
  assert.match(said, /pineapple/i, "the server's Claude knew the fact told on the computer");
  assert.match(said, /teal/i);

  say("3. the person moves the chat back to the computer; a real Claude there resumes with both facts");
  await ok("runner.move", { thread: chatId, to: "mac" });
  await until(async () => where() === "mac", "the chat is on the computer again", 120_000);
  said = await turn("a recall back on the computer", () => asChat("threads.send", { thread: th.id, text: "What were the word and the colour I told you? Reply exactly as: word=<word> colour=<colour>" }));
  say(`   recall on the computer, after the round trip: ${JSON.stringify(said)}`);
  assert.equal(where(), "mac");
  assert.match(said, /pineapple/i, "the computer's Claude knows the fact told before the trip");
  assert.match(said, /teal/i, "and the one told on the server");

  say("4. a teammate writes in the same chat: her turn never runs on the owner's computer; the server takes the chat back and answers");
  const other = await turn("the teammate's turn", () => asPerson(CAROL_ID, "threads.send", { thread: th.id, text: "I am a teammate. What word did the owner ask you to remember? Reply with only the word." }));
  say(`   where it runs now: ${where()}; the teammate's answer: ${JSON.stringify(other)}`);
  assert.equal(where(), "server", "the chat is the server's: the owner's computer ran nothing of the teammate's");
  assert.match(other, /pineapple/i);
  say(`   the chat's own words: ${JSON.stringify((await events()).filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.notice).map((/** @type {any} */ e) => e.payload.text).slice(-3))}`);
});
