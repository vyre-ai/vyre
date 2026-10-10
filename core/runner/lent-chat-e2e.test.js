// @ts-check
// A chat that runs on a person's own computer, end to end (R031-95 part B; contracts/lent-spawn.md v1.3). A real daemon (kernel on, the real switchboard and stream) is the home; a lender (the runner module, in the real
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
import { rig, SPACE, BOB } from "./testing/lent-rig.js";
import { start } from "../daemon/index.js";
import { lentRequest } from "../daemon/threadsock.js";
import { asOwner, tempHome, present } from "../../test/helpers.js";
import { until, FAKE } from "../sessions/testing/boot.js";

const SKIP = unavailable() || workspaceUnavailable() || "";
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

test("a new chat is placed on the person's computer, runs there, answers in the chat, and says where it runs", { skip: SKIP || false, timeout: 240_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  // the fake Claude, run where it is, is what both the lender and the box run; the lender's sandbox reads the repo so the fake can reach Vyre's client the way Claude's own tools do
  const agent = FAKE;
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
  const saved = { VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN, VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER, FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS, VYRE_SEAL_DEV: process.env.VYRE_SEAL_DEV, VYRE_KERNEL_PATH_RULE: process.env.VYRE_KERNEL_PATH_RULE, VYRE_SESSION_SANDBOX_OFF: process.env.VYRE_SESSION_SANDBOX_OFF };
  const root = tempHome(t);
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts);
  Object.assign(process.env, { VYRE_CLAUDE_BIN: agent, VYRE_SESSIONS_DRIVER: "cli", FAKE_CLAUDE_TRANSCRIPTS: transcripts, VYRE_SEAL_DEV: "1", VYRE_KERNEL_PATH_RULE: "1", VYRE_SESSION_SANDBOX_OFF: "1" });
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  /** @type {string[]} the tool requests that came down the lender's door, with the thread each was for */ const doorCalls = [];
  // the home: link's lent world, whose tool requests go to the daemon's own session socket for the thread
  const r = await rig(t, { keyIsDevice: true, lapseMs: 20_000, http: (/** @type {string} */ thread, /** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ headers, /** @type {string} */ body) => { doorCalls.push(`${thread} ${p}`); return lentRequest(thread, method, p, headers, body); },
    specFor: async () => ({ command: "claude", args: [], env: {}, routes: [], readOnly: [REPO], labels: {}, network: "provider", credentialRoutes: [] }) });

  // the daemon: kernel on, the stream and the switchboard real; the lent home is the rig's, and a loader exists so the server could carry a session on (the loader itself is agent-core's)
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", role: "box", transcripts: [transcripts], sessions: { install: false, thread_socket: "on" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: { check: async () => null }, resumeLent: async () => ({}) });
  asOwner(d, root);
  t.after(() => d.stop());
  const deps = /** @type {any} */ (d.registry.deps);
  // only the computer's person is placed (BOB in the rig); the daemon's owner stands in for him
  const home = new Proxy(r.home, { get: (target, prop) => (prop === "placeNew" ? (/** @type {any} */ i) => target.placeNew({ ...i, person: BOB }) : prop === "spawn" ? (/** @type {any} */ i) => target.spawn({ ...i, person: BOB }) : /** @type {any} */ (target)[prop]) });
  deps.lentHome = () => home;
  deps.lentSpaces = () => [SPACE];

  // the computer: the runner module, in the sandbox, enrolled for the Space
  const lenderRoot = fs.mkdtempSync(path.join(SCRATCH, "lce-lender-"));
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  /** @type {Map<string, any>} */ const tools = new Map();
  const handlers = new Map();
  const ctx = {
    paths: { root: lenderRoot }, config: { role: "local", name: "Office Mac" },
    events: { emit: (/** @type {string} */ type) => { for (const f of handlers.get(type) || []) f({ type }); }, on: (/** @type {string} */ type, /** @type {any} */ f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter((/** @type {any} */ x) => x !== f)); } },
    tool: (/** @type {string} */ n, /** @type {any} */ def) => tools.set(n, def),
    call: async (/** @type {string} */ name, /** @type {any} */ input) => (name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: { devices: [] } }),
    kernel: { owner: BOB, chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }), for: () => ({ call: (/** @type {string} */ name, /** @type {any[]} */ args) => remote.call(name, args) }), runnerHost: () => ({ identity: async () => ({ deviceId: "eid_mac", deviceKey: "dev_laptop" }) }) },
  };
  seams.set(lenderRoot, { heartbeatMs: 150, beatTimeoutMs: 400, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  const lender = await mod.start(ctx);
  t.after(async () => { seams.delete(lenderRoot); await lender.stop(); });
  const run = (/** @type {string} */ tool, /** @type {any} */ input) => tools.get(tool).run(input, { caller: "cli" });
  await run("runner.start", { space: SPACE, session: "s0" }); // the computer becomes a lender of the Space and says it is well every moment
  await sleep(800);

  const call = (/** @type {string} */ tool, /** @type {any} */ input) => d.registry.call(tool, input, "cli");
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input) => { const x = await call(tool, input); assert.ok(!x.error, `${tool}: ${JSON.stringify(x)}`); return x.data; };
  const placing = /** @type {any[]} */ ([]);
  d.events.on("thread.placing", (/** @type {any} */ e) => placing.push(e.payload || e));

  const work = fs.realpathSync(fs.mkdtempSync(path.join(SCRATCH, "lce-work-")));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const th = await ok("threads.start", { cwd: work, prompt: "hello from the phone", surface: "cli" });
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 100 })).events.some((/** @type {any} */ e) => e.type === "thread.finished"), "the first turn", 60_000);
  const events = (await ok("threads.get", { thread: th.id, limit: 100 })).events;
  const said = events.filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => e.payload.text).at(-1);
  assert.match(said, /echo: hello from the phone/, "the answer came back into the chat");

  // it was placed on the computer when the chat was made, and ran there
  const row = r.home.book.find(th.id) || r.home.book.find((await ok("threads.get", { thread: th.id, limit: 1 })).thread.chat);
  assert.ok(row && row.where === "mac", "the home's book says the chat runs on the computer: " + JSON.stringify(row));
  assert.deepEqual(placing.map(p => p.state).slice(0, 2), ["starting", "up"], "the chat said it was starting on the computer, then up: " + JSON.stringify(placing));
  assert.ok(!placing.some(p => p.state === "fallback"), "it did not fall back to the box");
  const here = await run("runner.here", {});
  assert.ok(here.sessions.length >= 1 && here.sessions.some((/** @type {any} */ s) => s.computer === "Office Mac"), "the computer lists the session it runs: " + JSON.stringify(here));

  // a second message goes to the same process
  await ok("threads.send", { thread: th.id, text: "and again" });
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 200 })).events.filter((/** @type {any} */ e) => e.type === "thread.finished").length >= 2, "the second turn", 60_000);
  const again = (await ok("threads.get", { thread: th.id, limit: 200 })).events.filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => e.payload.text).at(-1);
  assert.match(again, /echo: and again/);

  // a Vyre tool call from inside the lent session is answered by the home as that session: the fake Claude calls the tool the way the MCP server does, down the lender's door
  await ok("threads.send", { thread: th.id, text: "vyre threads.list {}" });
  await until(async () => (await ok("threads.get", { thread: th.id, limit: 300 })).events.filter((/** @type {any} */ e) => e.type === "thread.finished").length >= 3, "the tool turn", 60_000);
  const tool = String((await ok("threads.get", { thread: th.id, limit: 300 })).events.filter((/** @type {any} */ e) => e.type === "thread.text" && e.payload.done && !e.payload.notice).map((/** @type {any} */ e) => e.payload.text).at(-1));
  const answer = JSON.parse(tool);
  assert.ok(doorCalls.some(c => c.startsWith(th.id) && c.includes("/v1/tools/threads.list")), "the call came down the lender's door for this chat's thread: " + JSON.stringify(doorCalls));
  assert.ok(!answer.error && Array.isArray(answer.data ? answer.data : answer.threads || answer), "the home answered the tool call from the lent session: " + tool.slice(0, 300));
});
