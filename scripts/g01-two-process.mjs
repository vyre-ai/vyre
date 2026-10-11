// G01 / G02 proof with two real processes: a member's computer (the runner module in its sandbox) and the server (a real vyred: kernel on, sealer, vault, Switchboard, stream, the home's lent service),
// joined over the Wink peer wire (ed25519 device proof, core/wink/node/peer-wire.js) on a loopback socket. Run it on a Linux test box, never on a person's Mac.
//   node scripts/g01-two-process.mjs run <proof-dir>    starts both, drives the walk, writes <proof-dir>/{server,mac}.log
// The agent is a parameter: G01_AGENT=<path to a program> (default: the stand-in, core/runner/testing/g01-standin.js). With a real Claude set G01_AGENT=<claude> G01_TOKEN_FILE=<file>; the
// asserts that need the stand-in's "recall" word (prompt = recall) then use the real Claude's own answer to a question instead (G01_REAL=1).
import "./mac-test-guard.mjs";
import "../core/runner/testing/hosted-guard.js";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const [role, arg1] = process.argv.slice(2);
const AGENT = path.resolve(process.env.G01_AGENT || path.join(REPO, "core/runner/testing/g01-standin.js"));
const REAL = process.env.G01_REAL === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (m) => console.log(`${String(Math.round((Date.now() - t0) / 100) / 10).padStart(7)}s [${role}] ${m}`);
const NK = "nodekey:" + "55".repeat(32), DEVICE = "dev_laptop";
const seedOf = (d) => crypto.createHash("sha256").update("vyre-g01-two:" + d).digest();
const privOf = (d) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seedOf(d)]), format: "der", type: "pkcs8" });
const pubOf = (d) => crypto.createPublicKey(privOf(d)).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
const until = async (fn, what, ms = 60_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); } };

if (role === "run") {
  // the launcher: two processes, two private homes, one proof folder
  const proof = path.resolve(arg1 || "g01-proof"); fs.mkdirSync(proof, { recursive: true });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "g01-two-"));
  const env = { ...process.env, G01_BASE: base, G01_AGENT: AGENT };
  const out = (n) => fs.openSync(path.join(proof, `${n}.log`), "a");
  const sfd = out("server"), mfd = out("mac");
  const server = spawn(process.execPath, [fileURLToPath(import.meta.url), "server"], { env, stdio: ["ignore", sfd, sfd] });
  await until(() => fs.existsSync(path.join(base, "ready.json")), "the server to be ready", 120_000);
  const mac = spawn(process.execPath, [fileURLToPath(import.meta.url), "mac"], { env, stdio: ["ignore", mfd, mfd] });
  fs.writeFileSync(path.join(proof, "pids.txt"), `server pid ${server.pid}\nmac pid ${mac.pid}\n`);
  const code = await new Promise((res) => server.on("exit", res));
  try { process.kill(mac.pid, "SIGTERM"); } catch { /* gone */ }
  await sleep(500);
  fs.rmSync(base, { recursive: true, force: true });
  console.log(code === 0 ? "PASS" : `FAIL (server exit ${code})`);
  process.exit(code === 0 ? 0 : 1);
}

const BASE = String(process.env.G01_BASE);
const HOME = path.join(BASE, role + "-home"); fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME;
Object.assign(process.env, { VYRE_ALLOW_REAL_TRANSCRIPTS: "1", VYRE_LENT_AGENT_DEV: "1", VYRE_LENT_AGENT: AGENT, VYRE_CLAUDE_BIN: AGENT, VYRE_SESSIONS_DRIVER: "cli", VYRE_SEAL_DEV: "1", G01_SIDE: role === "server" ? "server" : "mac", VYRE_TEST: "1", ...(role === "server" ? { VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1" } : {}) });   // the server runs its stand-in unconfined, as the lent chat e2e does; the computer's is in the runner sandbox
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
const { createRemoteKernel } = await import("../kernel/remote/client.js");
const { withKernelCall, winkTransport } = await import("../kernel/remote/wink.js");
const { admitPeer, joinPeer, socketPipe } = await import("../core/wink/node/peer-wire.js");

if (role === "server") {
  const { start } = await import("../core/daemon/index.js");
  const { startSealer } = await import("../kernel/seal/client.js");
  const { createRemoteServer } = await import("../kernel/remote/server.js");
  const { asOwner, present, tempHome } = await import("../test/helpers.js");
  const root = tempHome({ name: "g01-two-process", after() {} });
  const transcripts = path.join(HOME, ".claude", "projects"); fs.mkdirSync(transcripts, { recursive: true });
  const sealer = startSealer({ dir: path.join(root, "seal"), timeoutMs: 8000, dev: true, unattested: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "g01-server", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, kernelSealer: sealer, lentKeyOf: () => Buffer.alloc(32, 7) });
  asOwner(d, root);
  const call = (tool, input) => d.registry.call(tool, input, "cli");
  const ok = async (tool, input) => { const x = await call(tool, input); assert.ok(!x.error, `${tool}: ${JSON.stringify(x.error)}`); return x.data; };
  const ownerId = String(d.kernel.id.owner), SPACE = String(d.kernel.id.space);
  say(`server pid ${process.pid}; agent ${AGENT}; space ${SPACE}`);

  // the vault and the account, the way a person adds them (a placeholder secret for the stand-in; the real token for a real Claude)
  const token = process.env.G01_TOKEN_FILE ? fs.readFileSync(process.env.G01_TOKEN_FILE, "utf8").trim() : "stand-in-token";
  assert.ok(!(await call("vault.put", { name: "claude-setup-token", kind: "secret", description: "Claude subscription token for headless sessions", value: token })).error);
  assert.ok(!(await call("sessions.accounts.add", { provider: "claude", label: "g01 subscription", kind: "setup-token", vault_item: "claude-setup-token", is_default: true })).error);
  say("0. the owner's sign-in is in the vault (vault.put) and the account is added (sessions.accounts.add)");

  const home = d.registry.deps.lentHome(SPACE); assert.ok(home, "the home's own lent service");
  const ownerChain = d.kernel.chains.fromFacts({ kind: "device", device_key_id: "d-o", person: ownerId, path: "direct", session: "s1" });
  await d.kernel.gateway.grants.offers.lend(ownerChain, { member: ownerId, device: DEVICE, device_key: DEVICE }, { presence: { method: "test" } });
  // the Wink door: the member's computer proves its device key, and its kernel calls are served as that member
  const rk = createRemoteServer({ space: SPACE, home: SPACE, kernel: d.kernel, log: () => {}, services: { lent: home } });
  const dispatch = withKernelCall(async () => { throw Object.assign(new Error("no such tool"), { code: "no_such_tool" }); }, { serverFor: (s) => (s === SPACE ? rk : null), personOf: (dv) => (dv === DEVICE ? ownerId : null), pathOf: () => "wink" });
  const door = net.createServer((sock) => { admitPeer(socketPipe(sock), { id: { nodeKey: NK }, box: "home", entry: (eid) => (eid === DEVICE ? { eid, kind: "device", pub: pubOf(eid) } : null), serve: (c, tool, input) => dispatch(c, tool, input) }).catch(() => {}); sock.on("error", () => {}); });
  await new Promise((r) => door.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(BASE, "ready.json"), JSON.stringify({ port: door.address().port, space: SPACE, owner: ownerId }));
  say(`the Wink door listens on ${door.address().port}`);
  await until(() => fs.existsSync(path.join(BASE, "mac-up")), "the member's computer to join", 120_000);
  await sleep(1500);
  say("the member's computer has joined (its pid is in mac.log)");

  const CAROL = "per_" + "c".repeat(26);
  await d.kernel.gateway.grants.setRole(ownerChain, { person: CAROL, role: "member" }, { presence: { method: "test" } });
  const chat = await d.kernel.gateway.grants.chats.create(ownerChain, { people: [CAROL] });
  const as = (who, tool, input) => d.registry.call(tool, { ...input, surface: "deck", chat: chat.id, asker: who }, "module:stream").then((x) => { assert.ok(!x.error, `${tool}: ${JSON.stringify(x)}`); return x.data; });
  const work = fs.realpathSync(fs.mkdtempSync(path.join(BASE, "work-")));
  let th = null;
  const events = async () => (await ok("threads.get", { thread: th.id, limit: 800 })).events;
  const finishedN = async () => (await events()).filter((e) => e.type === "thread.finished").length;
  const lastSaid = async () => String((await events()).filter((e) => e.type === "thread.text" && e.payload.done && !e.payload.notice).map((e) => e.payload.text).at(-1));
  const turn = async (label, send) => { const n = th ? await finishedN() : 0; const first = await send(); if (!th) th = first; try { await until(async () => (await finishedN()) > n, label, Number(process.env.G01_TURN_MS || 240_000)); } catch (e) { const ev = await events(); say(`TIMED OUT; last events ${JSON.stringify(ev.slice(-10).map((x) => ({ t: x.type, p: JSON.stringify(x.payload).slice(0, 260) })))}`); const tt = await d.registry.call("threads.transcript-target", { thread: th.id }, "module:vyred", { door: true }); say(`transcript-target ${JSON.stringify(tt)}; resumed ${JSON.stringify(resumed)}; folders ${fs.existsSync(path.join(HOME, ".claude", "projects")) ? JSON.stringify(fs.readdirSync(path.join(HOME, ".claude", "projects"), { recursive: true })) : "none"}`); throw e; } const s = await lastSaid(); say(`   "${label}" answered: ${JSON.stringify(s)}`); return s; };
  const where = () => home.book.get(th.id)?.where;
  const chatId = String(chat.id);
  const placing = []; const resumed = [];
  d.events.on("thread.placing", (e) => placing.push(e.payload || e));
  d.events.on("runner.resumed", (e) => resumed.push(e.payload || e));
  const FACT1 = "the word is PINEAPPLE", FACT2 = "the colour is TEAL";

  say("1. the owner starts a chat; it is placed on the owner's own computer");
  let s = await turn("first turn", () => as(ownerId, "threads.start", { cwd: work, prompt: FACT1 }));
  assert.equal(where(), "mac", "the home's book says the chat runs on the computer");
  if (!REAL) assert.match(await turn("recall on the computer", () => as(ownerId, "threads.send", { thread: th.id, text: "recall" })), /side=mac /, "the turn ran in the computer's process");
  const macPid1 = (/pid=(\d+)/.exec(await lastSaid()) || [])[1] || "";

  say("2. the owner hands the chat to the server; the transcript follows and the next turn sees the earlier ones");
  await ok("runner.move", { thread: chatId, to: "server" });
  await until(async () => where() === "server", "the chat is the server's", 120_000);
  s = await turn("fact two on the server", () => as(ownerId, "threads.send", { thread: th.id, text: FACT2 }));
  const serverFiles = fs.readdirSync(path.join(HOME, ".claude", "projects"), { recursive: true }).filter((f) => String(f).endsWith(".jsonl"));
  say(`   the transcript on the server side: ${JSON.stringify(serverFiles)}`);
  assert.ok(serverFiles.length >= 1, "the transcript file exists on the server");
  { const f = path.join(HOME, ".claude", "projects", String(serverFiles[0])); const rows = fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { try { const m = JSON.parse(l); return `${m.type}:${typeof m.message?.content === "string" ? m.message.content.slice(0, 40) : "-"}`; } catch { return "?"; } }); say(`   its lines (${rows.length}): ${JSON.stringify(rows)}`); }
  s = await turn("recall on the server", () => as(ownerId, "threads.send", { thread: th.id, text: REAL ? "What were the word and the colour I told you? Reply exactly as: word=<word> colour=<colour>" : "recall" }));
  if (REAL) { assert.match(s, /pineapple/i); assert.match(s, /teal/i); } else {
    assert.match(s, /side=server /, "the turn ran in the server's process"); assert.ok(s.includes("PINEAPPLE") && s.includes("TEAL"), "the server's agent sees the turns told on the computer and on the server: " + s);
    assert.ok(!s.includes(`pid=${macPid1} `) || macPid1 === "", "not the computer's process");
  }

  say("3. the owner takes the chat back to the computer; the context is still there");
  await ok("runner.move", { thread: chatId, to: "mac" });
  await until(async () => where() === "mac", "the chat is on the computer again", 120_000);
  s = await turn("recall back on the computer", () => as(ownerId, "threads.send", { thread: th.id, text: REAL ? "What were the word and the colour I told you? Reply exactly as: word=<word> colour=<colour>" : "recall" }));
  if (REAL) { assert.match(s, /pineapple/i); assert.match(s, /teal/i); } else { assert.match(s, /side=mac /); assert.ok(s.includes("PINEAPPLE") && s.includes("TEAL"), "the computer's agent sees both facts after the round trip: " + s); }

  { const row = home.book.get(th.id); say(`   the book after the take-back and a turn there: ${JSON.stringify({ where: row && row.where, device: row && row.device, epoch: row && row.epoch })}`); assert.ok(row && row.where === "mac" && row.device === DEVICE, "the server's book says the chat runs on the computer"); }
  // 4. A teammate writes in the owner's chat, twice over: her turn runs on the server with the owner's last turn in its history, and the owner's NEXT turn is back on their own computer by itself.
  const ASK = REAL ? "What were the word and the colour I told you, and what number did the owner give for each round so far? Reply exactly as: word=<word> colour=<colour> numbers=<n,n>" : "recall";
  const known = (/** @type {string} */ r, /** @type {number[]} */ ns) => { if (REAL) { assert.match(r, /pineapple/i); assert.match(r, /teal/i); for (const n of ns) assert.ok(r.includes(String(n)), `the number ${n} is in the history: ${r}`); } else { assert.ok(r.includes("PINEAPPLE") && r.includes("TEAL"), r); for (const n of ns) assert.ok(r.includes(`owner round ${n}`), `the owner's round ${n} is in the history: ${r}`); } };
  for (const round of [1, 2]) {
    say(`4.${round} round ${round}: the owner speaks on the computer, the teammate asks on the server, the owner's next turn is back on the computer with no move by hand`);
    s = await turn(`the owner's round ${round}`, () => as(ownerId, "threads.send", { thread: th.id, text: REAL ? `Round ${round}: the owner's number is ${round * 111}. Reply with only the word: ok.` : `owner round ${round}` }));
    assert.equal(where(), "mac", "the owner's turn ran on the owner's computer");
    s = await turn(`the teammate's round ${round}`, () => as(CAROL, "threads.send", { thread: th.id, text: ASK }));
    assert.equal(where(), "server", "the chat is the server's after the teammate's turn");
    if (!REAL) assert.match(s, /side=server /, "the teammate's turn ran in the server's process: " + s);
    known(s, Array.from({ length: round }, (_, k) => (REAL ? (k + 1) * 111 : k + 1)));   // the owner's last finished turn is in the history the server answered from
    s = await turn(`the owner's next turn after round ${round}`, () => as(ownerId, "threads.send", { thread: th.id, text: ASK }));
    assert.equal(where(), "mac", "the owner's next turn is back on their own computer, no hand needed");
    if (!REAL) assert.match(s, /side=mac /, "and ran there: " + s);
    known(s, Array.from({ length: round }, (_, k) => (REAL ? (k + 1) * 111 : k + 1)));
  }
  // 5. A hand-over the owner made themself stays where they put it, through a teammate's turn, until they take it back.
  say("5. the owner hands the chat to the server themself: a teammate's turn and the owner's next turn both stay on the server until the owner takes it back");
  await ok("runner.move", { thread: chatId, to: "server" });
  await until(async () => where() === "server", "the chat is the server's", 120_000);
  s = await turn("the teammate's turn after the hand-over", () => as(CAROL, "threads.send", { thread: th.id, text: ASK }));
  s = await turn("the owner's turn after their own hand-over", () => as(ownerId, "threads.send", { thread: th.id, text: ASK }));
  assert.equal(where(), "server", "their own hand-over stays until they take it back");
  if (!REAL) assert.match(s, /side=server /);
  await ok("runner.move", { thread: chatId, to: "mac" });
  await until(async () => where() === "mac", "the chat is on the computer again", 120_000);
  s = await turn("the owner's turn back on the computer", () => as(ownerId, "threads.send", { thread: th.id, text: ASK }));
  assert.equal(where(), "mac");
  if (!REAL) assert.match(s, /side=mac /);
  known(s, [1, 2]);
  fs.writeFileSync(path.join(BASE, "done"), "1");
  say("PASS: the walk is complete");
  await d.stop().catch(() => {});
  process.exit(0);
} else {
  // the member's computer: its own process, its own HOME and workspace, the runner module in the sandbox, joined to the server over the Wink wire
  const ready = JSON.parse(fs.readFileSync(path.join(BASE, "ready.json"), "utf8"));
  const { default: mod, seams } = await import("../core/runner/index.js");
  const { workTranscript } = await import("../core/switchboard/adopt.js");   // a computer's own daemon answers threads.work-transcript with this
  const sock = net.connect(ready.port, "127.0.0.1"); await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
  const wink = await joinPeer(socketPipe(sock), { device: DEVICE, nodeKey: NK, sign: (m) => crypto.sign(null, m, privOf(DEVICE)).toString("base64url") });
  const remote = createRemoteKernel({ space: ready.space, transport: winkTransport({ sessionFor: () => wink }) });
  const tools = new Map(); const handlers = new Map();
  const lenderRoot = path.join(BASE, "mac-root"); fs.mkdirSync(lenderRoot, { recursive: true });
  const ctx = {
    paths: { root: lenderRoot }, config: { role: "local", name: "Office Mac" },
    events: { emit: (type, payload) => { if (/checkpoint|runner\./.test(type)) say(`[computer] ${type} ${JSON.stringify(payload || {}).slice(0, 220)}`); for (const f of handlers.get(type) || []) f({ type }); }, on: (type, f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter((x) => x !== f)); } },
    tool: (n, def) => tools.set(n, def),
    call: async (name, input) => (name === "threads.work-transcript" ? { data: { file: workTranscript(input.work, input.cwd, input.session) } } : name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: null }),
    kernel: { owner: ready.owner, chain: async () => ({ hops: [{ actor: { kind: "person", id: ready.owner } }] }), for: () => ({ call: (name, args) => Promise.resolve(remote.call(name, args)).catch((e) => { say(`[wire] ${name} refused: ${e && e.code} ${String(e && e.message).slice(0, 160)} ${JSON.stringify(args).slice(0, 160)}`); throw e; }) }), runnerHost: () => ({ identity: async () => ({ deviceId: "eid_mac", deviceKey: DEVICE }) }) },
    log: () => {}, space: ready.space,
  };
  seams.set(lenderRoot, { heartbeatMs: 150, beatTimeoutMs: 400, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  const lender = await mod.start(ctx);
  await tools.get("runner.start").run({ space: ready.space, session: "s0" }, { caller: "cli" });
  say(`the member's computer is up: pid ${process.pid}, joined the server over the Wink wire`);
  fs.writeFileSync(path.join(BASE, "mac-up"), String(process.pid));
  await until(() => fs.existsSync(path.join(BASE, "done")), "the walk to finish", 900_000).catch(() => {});
  await lender.stop().catch(() => {});
  process.exit(0);
}
