// @ts-check
// Tests and CI rule 16 (owner ruling of 16 Oct 2026): be agent-agnostic. Vault lending and
// identity checks read one set, and this test reads that set from the registry. A hand-written
// list of Claude, Grok and Codex would miss the next adapter the registry registers.
import "../scripts/mac-test-guard.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findInSource } from "./source-files.js";
import { tempHome } from "./helpers.js";
import { adapterCommands, agentNames } from "../lib/agent-adapters.js";
import { peerIdentity, insideClaude } from "../core/daemon/peer.js";
import { scrubVaultResult } from "../core/modules/needs-you-hold.js";
import { modelSuppliedSecret } from "../lib/master-secret.js";
import { readIdentity } from "../core/sessions/identity.js";
import { Registry, discover } from "../core/modules/index.js";
import { open } from "../core/store/index.js";
import { Events } from "../kernel/bus.js";
import * as config from "../core/config/index.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = path.join(ROOT, "core");
const PLANTED = "VYRE-AGENT-SECRET-7f3c1a";
const linux = process.platform === "linux";

test("Tests and CI rule 16 is recorded, and the daemon reads the adapter set from the registry", () => {
  const rules = fs.readFileSync(path.join(ROOT, "DEVELOPMENT-RULES.md"), "utf8");
  assert.match(rules, /Be agent-agnostic/);
  assert.match(rules, /16 Oct 2026/);
  assert.match(rules, /test\/agent-agnostic\.test\.js/);
  const daemon = fs.readFileSync(path.join(ROOT, "core/daemon/index.js"), "utf8");
  assert.match(daemon, /agentNames\(registry\.providers\)/, "the session check must walk the registry, not a hand-written agent list");
  assert.equal(daemon.split("\n").length, 2009, "core/daemon/index.js stays at its line cap");
  const allowed = new Map([["lib/agent-adapters.js", "the one list"]]);
  assert.deepEqual(findInSource([/AGENT_HOSTS\s*=/, /claude\|codex\|gemini\|grok/], allowed), [], "a second agent-host list");
  for (const rel of ["core/daemon/peer.js", "core/daemon/index.js"]) {
    assert.match(fs.readFileSync(path.join(ROOT, rel), "utf8"), /agent-adapters|agentNames/, `${rel} reads the shared set`);
  }
});

test("vault lending and identity checks are the same for every registered adapter", async (t) => {
  const home = tempHome(t);
  const paths = config.ensure(home);
  const db = open(paths.db);
  const events = new Events(db);
  const reg = new Registry({ db, events, config: { role: "local", name: "testbox", names: { directory: "http://127.0.0.1:1" } }, paths, log: () => {}, presence: /** @type {any} */ ({ required: () => false, verify: async () => ({ ok: false }) }) });
  t.after(async () => { try { await reg.stop(); } catch { /* a failed module has nothing to stop */ } db.close(); });
  const found = discover([CORE]).filter(f => f.manifest && f.manifest.name === "sessions");
  await reg.start(found, { role: "local" });
  const row = reg.modules.get("sessions");
  assert.equal(row && row.state, "running", row && row.error);

  const extra = {
    list() { return [...reg.providers.keys(), "echo"]; },
    get(id) {
      if (id === "echo") return { id: "echo", command: "echo-bin", capabilities: {}, run() {} };
      const got = reg.providers.get(id);
      return got ? got.driver : null;
    },
  };
  const names = adapterCommands(extra);
  assert.ok(names.has("claude"), "Claude is built in");
  assert.ok(names.has("grok") && names.has("codex") && names.has("codex-acp"), "Grok and Codex come from the registry, including the codex-acp command");
  assert.ok(names.has("echo") && names.has("echo-bin"), "a provider registered later is in the set");
  assert.equal(names.has("openrouter"), false);
  assert.equal(names.has("openai-compatible"), false);
  const live = adapterCommands(reg.providers);
  assert.equal(live.has("echo-bin"), false, "the extra command is present only because the registry reported it");
  assert.ok(agentNames().has("grok") && agentNames().has("codex-acp"), "the shipped binaries count when no registry is passed");

  const host = process.pid;
  const shell = 4_200_002;
  /** @type {any} */ let lent = null;
  /** @type {any} */ let ident = null;
  /** @type {string|null} */ let session = null;
  for (const name of names) {
    const look = (/** @type {number} */ pid) => pid === shell ? { ppid: host, args: "node mcp.js" } : pid === host ? { ppid: 1, args: `/usr/local/bin/${name} --stdio` } : null;
    const who = peerIdentity(shell, look, "linux", names);
    if (linux) {
      assert.match(String(who.session), new RegExp(`^${host}:\\d+$`), name);
      assert.ok(who.cwd, name);
      if (session === null) session = who.session;
      assert.equal(who.session, session, name);
    }
    const inside = insideClaude(shell, { look, threads: [], adapters: names, self: 99, exe: () => "/bin/sh", started: () => "t", uid: () => 1000 });
    assert.deepEqual(inside, { inside: true, by: host }, name);
    const lend = scrubVaultResult("mcp", "vault.space.use", { ok: true, recoveryKey: PLANTED, passwordWrap: PLANTED }, {}, {});
    const id = scrubVaultResult("mcp", "identity.status", { username: "alex", recoveryKey: PLANTED, passwordWrap: PLANTED }, {}, {});
    assert.equal(JSON.stringify(lend).includes(PLANTED), false, name);
    assert.equal(JSON.stringify(id).includes(PLANTED), false, name);
    assert.equal(modelSuppliedSecret("mcp", { password: PLANTED }), true, name);
    assert.equal(modelSuppliedSecret("cli", { password: PLANTED }), false, name);
    assert.equal(readIdentity(name, home), null, name);
    if (lent === null) { lent = lend; ident = id; }
    assert.deepEqual(lend, lent, name);
    assert.deepEqual(id, ident, name);
  }

  const nodeLook = (/** @type {number} */ pid) => pid === shell ? { ppid: 1, args: "node server.js" } : null;
  assert.deepEqual(peerIdentity(shell, nodeLook, "linux", names), { session: null, cwd: null });
  const secretary = (/** @type {number} */ pid) => pid === shell ? { ppid: 1, args: "/usr/bin/secretary" } : null;
  assert.deepEqual(peerIdentity(shell, secretary, "linux", names), { session: null, cwd: null });
  const echoLook = (/** @type {number} */ pid) => pid === shell ? { ppid: host, args: "node mcp.js" } : pid === host ? { ppid: 1, args: "/opt/echo-bin --stdio" } : null;
  if (linux) assert.equal(peerIdentity(shell, echoLook, "linux").session, null, "echo-bin is an agent only once the registry says so");
  if (linux) assert.match(String(peerIdentity(shell, echoLook, "linux", names).session), new RegExp(`^${host}:`));
  const bare = insideClaude(shell, { look: echoLook, threads: [], self: 99, exe: () => "/bin/sh", started: () => "t", uid: () => 1000 });
  assert.equal(bare.inside, false, "an unregistered command is not a session");
  const bound = insideClaude(shell, { look: echoLook, threads: [], adapters: names, self: 99, exe: () => "/bin/sh", started: () => "t", uid: () => 1000 });
  assert.equal(bound.inside, true);
});
