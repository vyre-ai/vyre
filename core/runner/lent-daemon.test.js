// @ts-check
// A chat on a computer whose daemon is the real one (R031-95, the "not yet on a real Mac" gap): the lender is `start()` itself, the app's daemon with its runner module, enrolled to lend to a Space whose home is
// another computer, over the in-memory Wink; the home is the lent-home service with a real kernel and Offers (testing/lent-rig); the agent is the fake Claude in the real sandbox (seatbelt on a Mac, bubblewrap on
// Linux). A chat is placed on the computer with no yes, its turns ride lent.pipe, Vyre's tools and a hook reach the home through the door, the lid shuts and the server takes the chat, and a chat started
// after that runs on the box. Hosted runners only (hosted-guard); never a person's Mac.
import "../../scripts/mac-test-guard.mjs";
import "./testing/hosted-guard.js";
import "./testing/require-sandbox.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SCRATCH } from "../../test/scratch.mjs";
import { tempHome } from "../../test/helpers.js";
import { start } from "../daemon/index.js";
import { call } from "../daemon/client.js";
import { unavailable } from "./sandbox.js";
import { workspaceUnavailable } from "./workspace.js";
import { rig, SPACE, BOB } from "./testing/lent-rig.js";
import { seams } from "./index.js";

const SKIP = unavailable() || workspaceUnavailable() || "";
const DEVICE = "dev_laptop";
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));
const waitFor = async (/** @type {() => any} */ fn, ms = 20_000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error("timed out"); };
const lines = (/** @type {any} */ stream) => { /** @type {string[]} */ const got = []; let buf = ""; stream.on("data", (/** @type {any} */ d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { got.push(buf.slice(0, i)); buf = buf.slice(i + 1); } }); return got; };

test("a chat on a computer run by the real daemon: placed with no yes, tools and a hook through the door, the lid shuts and the server takes it, a later chat runs on the box", { skip: SKIP || false, timeout: 240_000 }, async t => {
  const keep = setInterval(() => {}, 100); t.after(() => clearInterval(keep));
  process.env.VYRE_SEAL_DEV = "1";
  const agentDir = fs.mkdtempSync(path.join(SCRATCH, "ld-agent-"));
  const agent = path.join(agentDir, "agent.js");
  fs.copyFileSync(new URL("./testing/fake-agent.js", import.meta.url), agent);
  const was = process.env.VYRE_CLAUDE_BIN; process.env.VYRE_CLAUDE_BIN = agent;
  t.after(() => { if (was === undefined) delete process.env.VYRE_CLAUDE_BIN; else process.env.VYRE_CLAUDE_BIN = was; fs.rmSync(agentDir, { recursive: true, force: true }); });
  /** @type {any[]} */ const asked = [];
  const r = await rig(t, { keyIsDevice: true, lapseMs: 20_000, canResume: () => true,
    http: async (/** @type {string} */ thread, /** @type {string} */ method, /** @type {string} */ p, /** @type {any} */ headers) => { asked.push([thread, p, headers["x-vyre-caller"]]); return p.endsWith("/harness.rules") ? { status: 200, body: JSON.stringify({ data: { decision: "deny", reason: "from the home" } }) } : { status: 200, body: JSON.stringify({ data: { tool: p.split("/").pop(), you: `mcp:thread:${thread}` } }) }; },
    specFor: async () => ({ command: "claude", args: [], env: {}, routes: [], readOnly: [], labels: {}, network: "provider", credentialRoutes: [] }) });
  // the app's daemon on the lender: the real one, with the runner, whose home for the Space is the server above
  const root = tempHome(t);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "Office Mac", role: "local", transcripts: [], vault: { keystore: "file" }, modules: { enable: [], disable: ["recall", "memory", "learn"] } }));
  // the machine reads as awake and plugged in, so the result does not depend on the hosted runner's power state
  seams.set(root, { heartbeatMs: 300, beatTimeoutMs: 1500, state: () => ({ onPower: true, awake: true, cpuPct: 5, memPct: 5 }) });
  t.after(() => seams.delete(root));
  const sessionFor = async () => ({ call: async (/** @type {string} */ _tool, /** @type {any} */ input) => JSON.parse(JSON.stringify(await r.server.serve(JSON.parse(JSON.stringify(input)), { device_key_id: DEVICE, person: BOB, path: "wink" }))) });
  const d = await start({ root, kernel: true, sessionFor, deviceIdentity: async () => ({ deviceId: DEVICE, deviceKey: DEVICE }), log: () => {} });
  let stopped = false; const stopIt = async () => { if (!stopped) { stopped = true; await d.stop(); } };
  t.after(stopIt);
  const db = d.registry.deps.db;
  db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`server-hosted/${SPACE}`, JSON.stringify({ device: "srv_home0000000001" }));
  db.prepare("INSERT INTO spaces_kv (key, value) VALUES (?, ?)").run(`lend/${SPACE}/${DEVICE}`, JSON.stringify({ lent: true, device: DEVICE }));
  // what the spaces module says when the person turns "Run on this computer" on: the runner starts to beat for the Space
  d.registry.deps.events.emit("spaces", "space.device-lent", { space: SPACE, device: DEVICE, lent: true });
  for (const [key, value] of [["runner.enabled", true], ["runner.plugged_in_only", false]]) { const set = await call("settings.set", { key, value }, { root, caller: "cli" }); assert.ok(!set.error, `${key}: ${JSON.stringify(set.error)}`); }
  // a chat is placed on the computer once it is a lender (it is enrolled: it beats for the Space with no session of its own)
  const placed = await waitFor(() => { const p = r.home.placeNew({ session: "s_real", person: BOB }); return p.where === "mac" ? p : null; }, 90_000);
  assert.equal(placed.device, DEVICE);
  const proc = r.home.spawn({ session: "s_real", person: BOB, args: ["--output-format", "stream-json", `--${"plugin-dir"}`, new URL("../../harness", import.meta.url).pathname] });
  const out = lines(proc.stdout);
  await waitFor(() => proc.lent && proc.lent.state === "up", 60_000);
  proc.stdin.write("turn hello\n");
  await waitFor(() => out.some(l => l.includes("did hello")), 30_000);
  // Vyre's tools through the door, as the session; a hook as a hook
  proc.stdin.write("vyre records.list {\"type\":\"contact\"}\n");
  const reply = JSON.parse(await waitFor(() => out.find(l => l.includes("\"vyre\"")), 30_000)).reply;
  assert.deepEqual([reply.status, JSON.parse(reply.body).data.you], [200, "mcp:thread:s_real"]);
  proc.stdin.write("hook rules {\"session_id\":\"s_real\",\"tool_name\":\"Bash\",\"tool_input\":{\"command\":\"ls\"}}\n");
  const hook = JSON.parse(await waitFor(() => out.find(l => l.includes("\"hook\"")), 60_000).catch(e => { throw new Error(`${e.message}; the program said: ${out.slice(-6).join(" | ").slice(0, 600)}`); }));
  assert.ok(hook.stdout, "the hook said something: " + JSON.stringify(hook));
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.permissionDecision, "deny", JSON.stringify(hook));
  assert.equal(asked.at(-1)[2], "harness");
  // the lid shuts: the server takes the chat, the SDK hears a move
  const closed = new Promise(res => proc.on("close", (/** @type {any} */ c, /** @type {any} */ s) => res([c, s])));
  d.registry.deps.events.emit("link", "link.sleeping", {});
  assert.deepEqual(await closed, [null, "SIGHUP"]);
  assert.equal(proc.moved && proc.moved.to, "server");
  await waitFor(() => r.home.book.get("s_real")?.where === "server", 20_000);
  await sleep(2500);
  assert.equal(r.home.placeNew({ session: "s_later", person: BOB }).where, "box", "a chat started after the lid shut runs on the box");
  // the workspace is closed before the folder goes (the daemon's stop locks it)
  await stopIt();
});
