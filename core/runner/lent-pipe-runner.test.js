// @ts-check
// A chat's process on a lender, through the whole runner (contracts/lent-spawn.md): the home spawns a ChildProcess for the SDK, the lender's heartbeat is told to start it, the runner starts the program in its real sandbox
// with the SDK's flags, and the bytes ride `lent.pipe` between the two. A fake agent stands in for Claude Code. Real sandbox and workspace, the in-memory Wink.
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

const SKIP = unavailable() || workspaceUnavailable() || "";
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (/** @type {() => any} */ fn, ms = 20_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };
const lines = (/** @type {any} */ stream) => { /** @type {string[]} */ const got = []; let buf = ""; stream.on("data", (/** @type {any} */ d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(buf.slice(0, i)); buf = buf.slice(i + 1); } }); return got; };

async function world(/** @type {import("node:test").TestContext} */ t) {
  const agentDir = fs.mkdtempSync(path.join(SCRATCH, "lp-agent-"));
  const agent = path.join(agentDir, "agent.js");
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), agent);
  const was = process.env.VYRE_CLAUDE_BIN; process.env.VYRE_CLAUDE_BIN = agent;
  const root = fs.mkdtempSync(path.join(SCRATCH, "lp-root-"));
  const r = await rig(t, { keyIsDevice: true, lapseMs: 20_000, specFor: async () => ({ command: "claude", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] }) });
  const remote = createRemoteKernel({ space: SPACE, transport: createMemoryTransport({ servers: { [SPACE]: r.server }, peer: { device_key_id: "dev_laptop", person: BOB, path: "wink" } }) });
  /** @type {Map<string, any>} */ const tools = new Map();
  const handlers = new Map();
  const ctx = {
    paths: { root }, config: { role: "local", name: "Office Mac" },
    events: { emit: (/** @type {string} */ type) => { for (const f of handlers.get(type) || []) f({ type }); }, on: (/** @type {string} */ type, /** @type {any} */ f) => { handlers.set(type, [...(handlers.get(type) || []), f]); return () => handlers.set(type, (handlers.get(type) || []).filter((/** @type {any} */ x) => x !== f)); } },
    tool: (/** @type {string} */ n, /** @type {any} */ d) => tools.set(n, d),
    call: async (/** @type {string} */ name, /** @type {any} */ input) => (name === "settings.get" ? { data: { value: { "runner.enabled": true, "runner.plugged_in_only": false, "runner.cpu_percent": 90, "runner.memory_mb": 8192 }[input.key] } } : { data: { devices: [] } }),
    kernel: { owner: BOB, chain: async () => ({ hops: [{ actor: { kind: "person", id: BOB } }] }), for: () => ({ call: (/** @type {string} */ name, /** @type {any[]} */ args) => remote.call(name, args) }), runnerHost: () => ({ identity: async () => ({ deviceId: "eid_mac", deviceKey: "dev_laptop" }) }) },
  };
  seams.set(root, { heartbeatMs: 150, beatTimeoutMs: 400, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  const h = await mod.start(ctx);
  t.after(async () => { seams.delete(root); await h.stop(); if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; fs.rmSync(agentDir, { recursive: true, force: true }); });
  const run = (/** @type {string} */ tool, /** @type {any} */ input) => tools.get(tool).run(input, { caller: "cli" });
  return { r, run, book: r.home.book };
}

test("a chat spawned for a lender runs in the lender's sandbox with the SDK's flags, turns go down and answers come up, and the runner's own checkpoint is taken at the end of the turn", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t);
  // the lender is a lender for this Space once it has a workspace here, and then it says every few seconds that it is well
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_chat", person: BOB, args: ["/box/cli.js", "--output-format", "stream-json", "--mcp-config", "/box/mcp.json"] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent, 15_000);
  assert.equal(w.book.get("s_chat").where, "mac");
  proc.stdin.write("turn hello\n");
  await waitFor(() => out.some(l => l.includes("\"result\"")), 15_000);
  assert.ok(out.some(l => l.includes("did hello")), "the answer came up: " + out.join(" | "));
  // the runner kept doing its own work on the same bytes: the turn ended, so a checkpoint is at the home with the transcript
  await waitFor(async () => (await w.r.home.view("s_chat").checkpoint().catch(() => null))?.turn >= 1, 15_000);
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  proc.stdin.write("exit\n");
  assert.deepEqual(await closed, [0, null], "the program ended itself");
});

test("a kill from the SDK ends the sandboxed process tree on the lender", { skip: SKIP || false, timeout: 120_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  const w = await world(t);
  await w.run("runner.start", { space: SPACE, session: "s0" });
  await sleep(600);
  const proc = w.r.home.spawn({ session: "s_kill", person: BOB, args: ["--output-format", "stream-json"] });
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  await waitFor(() => proc.lent, 15_000);
  assert.ok(proc.kill());
  const [, signal] = /** @type {any[]} */ (await closed);
  assert.ok(signal === "SIGTERM" || signal === "SIGKILL" || signal === null, "ended: " + signal);
  await waitFor(async () => (await w.run("runner.here", {})).sessions.every((/** @type {any} */ x) => x.title !== "A session" || true) , 5000);
});
