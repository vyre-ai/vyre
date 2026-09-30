// @ts-check
// OpenAI's Codex as an ACP provider entry for the generic driver (drivers/acp.js), through the
// codex-acp adapter (github.com/agentclientprotocol/codex-acp, moved from zed-industries/codex-acp;
// a small binary that speaks ACP on stdio and respects Codex's own approval and sandbox settings).
//
// MEASURED on a hosted runner (scripts/provider-wire-proof.mjs, codex-cli 0.159.2 and codex-acp 2.0.1, 1 Oct 2026):
//  - initialize offers api-key and chat-gpt (and gateway when the client says it supports it); session/new answers
//    "Authentication required" (-32000) until authenticate {methodId}; the api-key method reads OPENAI_API_KEY or CODEX_API_KEY.
//  - a session starts in mode "agent" (modes read-only, workspace-write, agent, agent-full-access); `-c key=value` flags on the
//    adapter's argv change neither the mode nor the model provider, so none are passed.
//  - the gateway method (client capability auth._meta.gateway, authenticate _meta.gateway {baseUrl, headers, providerName}) does
//    point Codex at another OpenAI-compatible endpoint: a real turn ran end to end against a local stand-in (POST /v1/responses).
//  - codex-acp exits at once if CODEX_HOME does not exist.
// NOT yet proven (needs a real account): that chat-gpt authenticate uses a stored `codex login --device-auth` token.
//  - CODEX_HOME (the account's own folder) is where a `codex login --device-auth` token lives, so
//    a "login" account is signed in once and only its own uid can read the token.
// Not a bypass mode: never "never" for approval_policy, never danger-full-access.

import path from "node:path";
import { acpProvider } from "./acp.js";

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
    // as bypass-shaped (acp.js BYPASS_MODE), and a start mode that is one is moved or the session does not run.
    args: () => [],
    // HOME is the account's (the spawner sets it on a box, the Switchboard on a Mac); the sign-in lives under it.
    env: run => { const home = run.env && run.env.HOME; return home ? { CODEX_HOME: path.join(String(home), ".codex") } : {}; },
    secretEnv: () => ["OPENAI_API_KEY", ...(o.custom ? [o.custom.envKey] : [])],
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
    authParams: (methodId, run) => (methodId === "gateway" && o.custom
      ? { _meta: { gateway: { baseUrl: o.custom.baseUrl, headers: { Authorization: `Bearer ${String((run.env || {})[o.custom.envKey] || "")}` }, providerName: o.custom.id } } } : {}),
    // codex-acp exits at once if CODEX_HOME does not exist, so the folder is made (as the account) with every start.
    seed: { ".codex/.vyre": "" },
    capabilities: { steering: false, usage: "coarse", rewind: false },
    ...(o.floor ? { floor: o.floor } : {}),
    ...(o.sessions ? { sessions: o.sessions } : {}),
  });
}
