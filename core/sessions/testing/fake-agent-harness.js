// @ts-check
// Shared fake session adapters for live daemon tests (person relay, slash isolation, sessions).
// Standing rule (owner): agent-agnostic — the same harness wires Claude, Grok, Codex, and any
// future built-in provider that has a test double; do not branch tests on Claude-only env vars.
//
// Coverage: FAKE_SESSION_PROVIDERS (claude, grok, codex) matches the built-ins that run on fakes
// in CI. OpenRouter and openai-compatible use HTTP mocks elsewhere (sessions.test.js).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE } from "./boot.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = path.resolve(HERE, "fake-acp.js");

/** Built-in session providers exercised by live tests with local fakes (see core/sessions/index.js PROVIDERS). */
export const FAKE_SESSION_PROVIDERS = Object.freeze(["claude", "grok", "codex"]);

/**
 * Env keys this harness may set; restored in t.after.
 * @param {import("node:test").TestContext} t
 * @param {string} root temp home root (shim + store live here)
 * @param {"claude"|"grok"|"codex"} provider
 */
export function applyFakeSessionProvider(t, root, provider) {
  if (!FAKE_SESSION_PROVIDERS.includes(provider)) {
    throw new Error(`no fake harness for provider ${provider}; extend fake-agent-harness.js`);
  }
  const transcripts = path.join(root, "transcripts");
  fs.mkdirSync(transcripts, { recursive: true });
  const saved = {
    VYRE_CLAUDE_BIN: process.env.VYRE_CLAUDE_BIN,
    VYRE_SESSIONS_DRIVER: process.env.VYRE_SESSIONS_DRIVER,
    FAKE_CLAUDE_TRANSCRIPTS: process.env.FAKE_CLAUDE_TRANSCRIPTS,
    PATH: process.env.PATH,
    FAKE_ACP_STORE: process.env.FAKE_ACP_STORE,
    FAKE_ACP_LOG: process.env.FAKE_ACP_LOG,
    FAKE_ACP_EXTRA_MODE: process.env.FAKE_ACP_EXTRA_MODE,
    FAKE_ACP_START_MODE: process.env.FAKE_ACP_START_MODE,
  };
  Object.assign(process.env, {
    VYRE_SESSIONS_DRIVER: "cli",
    FAKE_CLAUDE_TRANSCRIPTS: transcripts,
    VYRE_CLAUDE_BIN: FAKE,
  });
  if (provider === "grok" || provider === "codex") {
    const bin = path.join(root, "shim");
    fs.mkdirSync(bin, { recursive: true });
    fs.chmodSync(FAKE_ACP, 0o755);
    fs.symlinkSync(FAKE_ACP, path.join(bin, "grok"));
    fs.symlinkSync(FAKE_ACP, path.join(bin, "codex-acp"));
    process.env.PATH = `${bin}:${saved.PATH || ""}`;
    process.env.FAKE_ACP_STORE = path.join(root, "acp-store");
    fs.mkdirSync(process.env.FAKE_ACP_STORE, { recursive: true });
    process.env.FAKE_ACP_LOG = path.join(root, "acp.log");
    Object.assign(process.env, { FAKE_ACP_EXTRA_MODE: "workspace-write", FAKE_ACP_START_MODE: "agent" });
  }
  t.after(() => {
    for (const k of ["FAKE_ACP_EXTRA_MODE", "FAKE_ACP_START_MODE", "FAKE_ACP_LOG"]) delete process.env[k];
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  return { transcripts };
}

/**
 * Login account for an ACP provider so threads.start { provider } can run on the fake agent.
 * @param {any} d daemon
 * @param {"grok"|"codex"} provider
 */
export async function ensureFakeAcpAccount(d, provider) {
  const r = await d.registry.call("sessions.accounts.add", { provider, label: "Relay test", kind: "login" }, "cli");
  if (r.error) throw new Error(`sessions.accounts.add ${provider}: ${JSON.stringify(r.error)}`);
}

/**
 * @param {any} d
 * @param {"claude"|"grok"|"codex"} provider
 */
export async function ensureFakeSessionProvider(d, provider) {
  if (provider === "grok" || provider === "codex") await ensureFakeAcpAccount(d, provider);
}

/**
 * Members need their own provider login so threads.start runs on their account (memberAccount), not the owner's ambient credential.
 * @param {any} d daemon
 * @param {Array<[string, any]>} people label and session meta pairs
 * @param {"claude"|"grok"|"codex"} [provider]
 */
export async function ensureMemberLoginAccounts(d, people, provider = "claude") {
  for (const [label, meta] of people) {
    const have = await d.registry.call("sessions.accounts.list", { provider }, "cli", meta);
    if (!have.error && (have.data || []).some((/** @type {any} */ a) => !a.synthetic)) continue;
    if (provider === "grok" || provider === "codex") {
      const r = await d.registry.call("sessions.accounts.add", { provider, label, kind: "login" }, "cli", meta);
      if (r.error) throw new Error(`sessions.accounts.add ${label}: ${JSON.stringify(r.error)}`);
      continue;
    }
    const added = await d.registry.call("sessions.accounts.add", { provider: "claude", label, kind: "login" }, "cli", meta);
    if (added.error) throw new Error(`sessions.accounts.add ${label}: ${JSON.stringify(added.error)}`);
    const db = d.registry.deps.db;
    db.prepare("UPDATE sessions_accounts SET signed_in_at = ? WHERE id = ?").run(Date.now(), added.data.id);
  }
}

/** threads.start fields for the active fake provider. */
export function threadStartProviderFields(provider) {
  return provider === "claude" ? {} : { provider };
}
