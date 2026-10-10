// @ts-check
// OpenAI's Codex as an ACP provider entry for the generic driver (drivers/acp.js), through the
// codex-acp adapter (github.com/agentclientprotocol/codex-acp, moved from zed-industries/codex-acp;
// a small binary that speaks ACP on stdio and respects Codex's own approval and sandbox settings).
//
// MEASURED on a hosted runner (scripts/provider-wire-proof.mjs, codex-cli 0.159.2 and codex-acp 2.0.1, 1 Oct 2026):
//  - initialize offers api-key and chat-gpt (and gateway when the client says it supports it); session/new answers
//    "Authentication required" (-32000) until authenticate {methodId}; the api-key method reads OPENAI_API_KEY or CODEX_API_KEY.
//  - a session starts in mode "agent" (modes read-only, workspace-write, agent, agent-full-access), which Vyre moves to "workspace-write"; `-c key=value` flags on the
//    adapter's argv change neither the mode nor the model provider, so none are passed.
//  - the gateway method (client capability auth._meta.gateway, authenticate _meta.gateway {baseUrl, headers, providerName}) does
//    point Codex at another OpenAI-compatible endpoint: a real turn ran end to end against a local stand-in (POST /v1/responses).
//  - codex-acp exits at once if CODEX_HOME does not exist.
// NOT yet proven (needs a real account): that chat-gpt authenticate uses a stored `codex login --device-auth` token.
//  - CODEX_HOME (the account's own folder) is where a `codex login --device-auth` token lives, so
//    a "login" account is signed in once and only its own uid can read the token.
// Not a bypass mode: never "never" for approval_policy, never danger-full-access.

import fs from "node:fs";
import path from "node:path";
import { acpProvider } from "./acp.js";

/** The config Vyre seeds into the account's Codex home at every start (the same text as `seed` below). */
const CONFIG = 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n';

/**
 * The CODEX_HOME a session runs with (R031-19). With no library, the account's own folder. With the Space's approved skills written for Codex (`VYRE_SKILLS_DIR`, a content-addressed folder the skills module
 * made), a home of its own beside it: the account's sign-in linked in (never copied), Vyre's config, and the skills folder linked, so sessions with the same skills share one home and a session never sees skills
 * that are not its project's or agent's. The folder is named by the skills' own content id, so nothing here needs cleaning up when they change.
 * @param {string} home the account's HOME @param {string | undefined} skillsDir
 */
export function codexHomeFor(home, skillsDir) {
  const own = path.join(home, ".codex");
  if (!skillsDir || !fs.existsSync(path.join(skillsDir, "skills"))) return own;
  const dir = path.join(home, ".codex-lib", path.basename(skillsDir));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const link = (/** @type {string} */ name, /** @type {string} */ target) => { const at = path.join(dir, name); try { if (fs.readlinkSync(at) === target) return; fs.rmSync(at, { force: true }); } catch { /* not a link yet */ } try { fs.rmSync(at, { recursive: true, force: true }); fs.symlinkSync(target, at); } catch { /* the folder is read-only or gone: the session runs without it */ } };
  if (fs.existsSync(path.join(own, "auth.json"))) link("auth.json", path.join(own, "auth.json"));
  fs.writeFileSync(path.join(dir, "config.toml"), CONFIG, { mode: 0o600 });
  link("skills", path.join(skillsDir, "skills"));
  return dir;
}

/**
 * @param {{ bin?: string, floor?: (call: any) => any, sessions?: any, custom?: { id: string, baseUrl: string, envKey: string, model: string } }} [o]
 *   custom: an OpenAI-compatible endpoint instead of OpenAI's own (the hosted-runner proof points it at
 *   OpenRouter with a capped key). Passed with -c on the command line, never a config file.
 */
export function codexProvider(o = {}) {
  return acpProvider({
    id: "codex",
    bin: o.bin || "codex-acp",
    // MEASURED on codex-acp 2.0.1 (proof-wire): `-c key=value` flags do not reach Codex through the adapter (a model_provider
    // override was never used, and the start mode is "agent" with or without them), so none are passed. What keeps a session
    // asking is the adapter's own mode: it starts in "agent" (approval and sandbox preset), "agent-full-access" is filtered
    // not allowed (acp.js ALLOWED_MODES is an allowlist, narrowed here to read-only and agent), and a start mode not allowed is moved or the session does not run.
    args: () => [],
    // MEASURED on codex-cli 0.159.3 and codex-acp 2.1.0 (a real Codex against a scripted stand-in for the model, scripts/provider-tool-proof.mjs):
    //  - "workspace-write" ("ask before writing outside the workspace or accessing the network") and "read-only" ("requires approval to edit
    //    files and access the internet") send the person's client a session/request_permission for a command that must leave the
    //    sandbox, and the command runs only if the client allows it;
    //  - "agent" is now named "Auto review" ("only ask for actions detected as potentially unsafe"): a MODEL (the guardian, on the same
    //    gateway) decides, and no question reaches the client at all, so neither a person nor Vyre's floor sees the command. It is never
    //    listed or started in. (Before codex-acp 2.1.0 "agent" was the approval preset; its id stayed and its meaning did not.)
    //  - "agent-full-access" never asks.
    // Vyre's own MCP server is gated by vyred on every call, so Codex's per-call approval for it (which names no tool) is let through (acp.js).
    mcpOwn: true,
    // codex-acp answers session/new before the MCP servers it was given are up, and a prompt does not wait for them: measured live on 10 Oct, a first turn sent at once had Vyre's tools in 1 of 8 fresh
    // sessions, with 2 s in 6 of 8, with 3 s and with 6 s in 6 of 6. Held for 4 s.
    mcpSettleMs: 4000,
    allowModes: /^(read-only|workspace-write)$/i,
    // Pinned on every start: "workspace-write" (Codex's own sandbox plus a question for what leaves it), else "read-only". Codex's own config cannot choose it.
    pinMode: ["workspace-write", "read-only"],
    askMode: /^(workspace-write|read-only)$/i,
    // HOME is the account's (the spawner sets it on a box, the Switchboard on a Mac); the sign-in lives under it.
    env: run => { const home = run.env && run.env.HOME; return home ? { CODEX_HOME: codexHomeFor(String(home), run.env && run.env.VYRE_SKILLS_DIR) } : {}; },
    secretEnv: () => ["OPENAI_API_KEY", "CODEX_API_KEY", ...(o.custom ? [o.custom.envKey] : [])],
    // codex-acp answers session/new "Authentication required" until authenticate. A custom OpenAI-compatible endpoint (the
    // OpenRouter rung, a test stand-in) goes through its "gateway" method, which the client must advertise
    // (auth._meta.gateway) and which carries the base URL and headers in _meta: the only way measured to point Codex elsewhere.
    // Otherwise the API key method when a key is in the environment, else the ChatGPT method (the account's stored device login).
    ...(o.custom ? { clientCapabilities: { auth: { _meta: { gateway: true } } }, authFirst: true } : {}),
    authMethod: (methods, run) => {
      const env = (run && run.env) || {};
      const pick = id => (methods.some(m => m.id === id) ? id : null);
      if (o.custom) return pick("gateway");
      return env.OPENAI_API_KEY || env.CODEX_API_KEY ? pick("api-key") : pick("chat-gpt");
    },
    authParams: (methodId, run) => {
      if (methodId !== "gateway" || !o.custom) return {};
      const key = String((run.env || {})[o.custom.envKey] || "");
      if (!key) throw new Error(`no key for ${o.custom.id} in the environment (${o.custom.envKey})`);
      return { _meta: { gateway: { baseUrl: o.custom.baseUrl, headers: { Authorization: `Bearer ${key}` }, providerName: o.custom.id } } };
    },
    // codex-acp exits at once if CODEX_HOME does not exist, so the folder is made (as the account) with every start.
    // The account's config.toml is written from Vyre's own settings at every start (never read from what is there, which the agent
    // could have edited to loosen its next session).
    seed: { ".codex/config.toml": CONFIG },
    capabilities: { steering: false, usage: "coarse", rewind: false },
    ...(o.floor ? { floor: o.floor } : {}),
    ...(o.sessions ? { sessions: o.sessions } : {}),
  });
}
