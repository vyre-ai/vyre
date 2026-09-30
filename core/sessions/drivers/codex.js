// @ts-check
// OpenAI's Codex as an ACP provider entry for the generic driver (drivers/acp.js), through the
// codex-acp adapter (github.com/agentclientprotocol/codex-acp, moved from zed-industries/codex-acp;
// a small binary that speaks ACP on stdio and respects Codex's own approval and sandbox settings).
//
// Verified (project pages, read 30 Sep 2026): the binary is `codex-acp`, it reads OPENAI_API_KEY
// from the environment, and it honours Codex's approval policy and sandbox.
//
// ASSUMED, until a real account runs it on a hosted runner (plan step 7, spike 6.12):
//  - `-c key=value` overrides reach Codex from the adapter's argv. Approval and sandbox are passed
//    that way on every start (approval_policy=untrusted, sandbox_mode=workspace-write), never read
//    from ~/.codex/config.toml, which the agent could otherwise have edited (reviewer-2 H2).
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
    args: () => ["-c", "approval_policy=untrusted", "-c", "sandbox_mode=workspace-write",
      ...(o.custom ? ["-c", `model_provider=${JSON.stringify(o.custom.id)}`, "-c", `model=${JSON.stringify(o.custom.model)}`,
        "-c", `model_providers.${o.custom.id}.name=${JSON.stringify(o.custom.id)}`, "-c", `model_providers.${o.custom.id}.base_url=${JSON.stringify(o.custom.baseUrl)}`,
        "-c", `model_providers.${o.custom.id}.env_key=${JSON.stringify(o.custom.envKey)}`] : [])],
    // HOME is the account's (the spawner sets it on a box, the Switchboard on a Mac); the sign-in lives under it.
    env: run => { const home = run.env && run.env.HOME; return home ? { CODEX_HOME: path.join(String(home), ".codex") } : {}; },
    capabilities: { steering: false, usage: "coarse", rewind: false },
    ...(o.floor ? { floor: o.floor } : {}),
    ...(o.sessions ? { sessions: o.sessions } : {}),
  });
}
