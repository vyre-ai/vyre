// @ts-check
// B8 (sec53 review): `unnamed` is set by the MCP hub only. Through the REAL registry on a real vyred, a model or a session
// caller that sends `unnamed` is refused as an undeclared key, so no caller can unblock a send by forging it, and no caller
// can make a named call look unnamed to the Gate. The hub (module:mcp) is the only one that sets it, and it can only add a hold.
import "../../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "../daemon/index.js";
import { tempHome, present, writeModule } from "../../test/helpers.js";
import { canonical } from "../../kernel/core/canonical.js";

const FAKE = fileURLToPath(new URL("../mcp/testing/fake-mcp.js", import.meta.url));
const calls = f => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(l => l.startsWith("call ")).length : 0);
const tick = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { if (await fn()) return; if (Date.now() > end) throw new Error("timed out waiting"); await tick(20); } }

process.env.VYRE_KERNEL ??= "1"; process.env.VYRE_KERNEL_PATH_RULE ??= "1"; process.env.VYRE_SEAL_DEV ??= "1";
const stubPresence = () => { const used = new Set(); return { check: async (/** @type {any} */ q) => (q.chain && q.proof && q.proof.op === q.op && canonical(q.proof.fields) === canonical(q.fields) && !used.has(q.proof.n) && (used.add(q.proof.n), true) ? null : "wrong_proof") }; };

test("B8: gate.request refuses an `unnamed` key from a model, a session or the CLI, so only the hub can set it", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  // a sender of the box's own, so the plain request below is an ordinary held send (the mail module offers mail:<account> only once an account exists)
  writeModule(join(root, "modules"), "courier", { requires: ["gate"], does: { tools: ["courier.release"] } }, `export default { async start(ctx) {
  ctx.tool("courier.release", { internal: true, run: () => ({ posted: true }) });
  const r = await ctx.call("gate.offer", { name: "courier:board", tool: "courier.release", content: { text: "string" } });
  if (r.error) throw new Error(r.error.message);
  return {};
} };`);
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence(), firstPartyRoots: [join(root, "modules")] });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const tokenOf = async (/** @type {any} */ c) => ({ token: (await K.surfaces.open(c, {})).token });
  const body = { kind: "send", via: "courier:board", to: "#client", content: { summary: "Re: fixture", text: "Hi." } };
  for (const caller of ["cli", "mcp", "mcp:agent:juno"]) {
    const r = await d.registry.call("gate.request", { ...body, unnamed: true }, caller, await tokenOf(dev(OWNER)));
    assert.ok(r.error, `${caller} sent unnamed and was not refused`);
    assert.equal(r.error.code, "bad_input", `${caller}: ${JSON.stringify(r.error)}`);
  }
  // Without the key the same request is an ordinary held send, so the refusal is about the key, not the call.
  const plain = await d.registry.call("gate.request", body, "cli", await tokenOf(dev(OWNER)));
  assert.ok(!plain.error, JSON.stringify(plain.error));
  assert.equal(plain.data.state, "held");
  void crypto; void canonical;
});

test("B8 real vyred: a standing permission for an agent on a hub server does not cover an unnamed send; the named one it covers goes out", { timeout: 240_000 }, async t => {
  const root = tempHome(t);
  const logFile = path.join(root, "fake-web.log");
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ name: "test-box", vault: { keystore: "file" } }));
  const d = await start({ root, presence: present, log: () => {}, kernel: true, kernelPresence: stubPresence() });
  t.after(() => d.stop());
  const K = d.kernel, OWNER = K.id.owner;
  const dev = (/** @type {string} */ p) => K.chains.fromFacts({ kind: "device", device_key_id: `d-${p.slice(4, 8)}`, person: p, path: "direct", session: "s" });
  const ownerTok = async () => ({ token: (await K.surfaces.open(dev(OWNER), {})).token });
  const ok = async (/** @type {string} */ tool, /** @type {any} */ input = {}) => { const r = await d.registry.call(tool, input, "cli", await ownerTok()); assert.ok(!r.error, `${tool}: ${JSON.stringify(r.error)}`); return r.data; };
  const uid = (await ok("agents.create", { name: "juno", kind: "agent" })).uid;
  const agentTok = async () => ({ token: (await K.surfaces.open(dev(OWNER), { agent: uid, session: "s-juno", thread: "t-juno" })).token });
  const callAs = async (/** @type {any} */ args) => d.registry.call("mcp.call", { server: "web", tool: "send_message", arguments: args }, "mcp:agent:juno", await agentTok());

  // A hub server with one outward tool, on a real vyred (stdio child, its calls logged to a file).
  await ok("mcp.add", { name: "web", transport: "stdio", command: process.execPath, args: [FAKE, "--stdio"],
    vars: { FAKE_MCP_LOG: logFile, FAKE_MCP_TOOLS: JSON.stringify([{ name: "send_message", inputSchema: { type: "object" } }]) } });
  // The person gives juno a standing permission to send to example.com addresses through this server.
  await ok("gate.standing.add", { agent: "juno", kind: "send", via: "mcp:web", to: { patterns: ["*@example.com"] }, daily_cap: 5 });

  // Unnamed: no recipient argument, so the destination would only be the server's name. Held, and the server never sees it.
  const unnamed = await callAs({ text: "hi" });
  assert.ok(!unnamed.error, JSON.stringify(unnamed.error));
  assert.ok(unnamed.data && typeof unnamed.data.held === "string", "an unnamed send is held even with a standing permission");
  assert.equal(calls(logFile), 0, "the server was not called for the unnamed send");

  // Named, inside the scope: the same standing permission covers it, so it goes out with no question (the positive control).
  const named = await callAs({ to: "client@example.com", text: "hi" });
  assert.ok(!named.error, JSON.stringify(named.error));
  await until(() => calls(logFile) === 1);
});
