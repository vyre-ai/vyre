// @ts-check
// xAI's Grok Build CLI as an ACP provider entry for the generic driver (drivers/acp.js).
//
// Verified (xAI docs, docs.x.ai/build/cli/reference, and the VS Code extension and third-party
// clients that use it, read 30 Sep 2026): `grok agent stdio` runs Grok as an ACP agent, JSON-RPC
// on stdin/stdout. `--no-auto-update` skips the background update check, so a session never waits
// on one or has its binary swapped mid-run. Permission modes are Ask (the default), Auto and
// Always-approve; `--always-approve` is the flag that turns approval off.
//
// ASSUMED, not verified, until a real account runs it on a hosted runner (plan step 0 and 5):
//  - Where Grok keeps its sign-in: the entry only sets HOME (the account's own directory), on the
//    assumption the CLI's token store lives under it. If it honours another variable, add it here.
//  - That Ask mode routes every write and command through session/request_permission. The driver
//    also serves fs/* and terminal/* through the floor, so an agent that honours the client
//    capabilities is covered either way; spike 6.12 lists what bypasses both.
//  - Which flag, if any, pins the mode on the command line. None is passed: Ask is the default and
//    `--always-approve` is deliberately never passed, whatever the config file says is checked by
//    that spike, not trusted.
// Not registered by default: the caller wires it once accounts resolve (sessions.accounts).

import { acpProvider } from "./acp.js";

/** A double-quoted TOML string. @param {string} v */
const q = v => JSON.stringify(String(v));

/**
 * The account's ~/.grok/config.toml for an OpenAI-compatible endpoint (Grok Build's own format,
 * from the Orq and OpenRouter setup guides): a [model.<id>] table with the provider's model id
 * (provider/model form), base_url and the NAME of the environment variable holding the key.
 * The key itself is never in the file.
 * @param {{ id?: string, model: string, baseUrl: string, envKey: string }} c
 */
export function grokConfigToml(c) {
  const id = c.id || "custom";
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) throw new Error("the model key is a short lowercase name");
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(c.envKey)) throw new Error("envKey names an environment variable");
  if (!/^https:\/\//.test(c.baseUrl)) throw new Error("baseUrl is an https URL");
  return `[models]\ndefault = ${q(id)}\n\n[model.${id}]\nmodel = ${q(c.model)}\nbase_url = ${q(c.baseUrl)}\nenv_key = ${q(c.envKey)}\nname = ${q(id)}\n`;
}

/**
 * @param {{ bin?: string, home?: string, floor?: (call: any) => any, sessions?: any, custom?: { id?: string, model: string, baseUrl: string, envKey: string } }} [o]
 *   home: the HOME of the account the session runs as (core/sessions/accounts.js), never the person's own
 *   custom: run Grok Build on another OpenAI-compatible endpoint (the hosted-runner proof: OpenRouter
 *   with a capped key). Its config file is written into the account's HOME at every start, 0600,
 *   as the account's uid, so the agent's own edits to it never carry over. UNVERIFIED until the
 *   proof runs: that `-m <id>` is accepted with `agent stdio`, and that the model list it needs
 *   is only what config.toml gives.
 */
export function grokProvider(o = {}) {
  return acpProvider({
    id: "grok",
    bin: o.bin || "grok",
    // The Space's approved skills (R031-19), written by the skills module as a plugin folder (`VYRE_SKILLS_DIR`): Grok loads it with `agent --plugin-dir` (the flag sits between `agent` and `stdio`;
    // after `stdio` it is refused). Measured live 10 Oct: with it a skill only the library holds answers, without it the session never sees it.
    args: run => ["--no-auto-update", ...(o.custom ? ["-m", o.custom.id || "custom"] : []), "agent", ...(run && run.env && run.env.VYRE_SKILLS_DIR ? ["--plugin-dir", String(run.env.VYRE_SKILLS_DIR)] : []), "stdio"],
    ...(o.custom ? { seed: { ".grok/config.toml": grokConfigToml(o.custom) } } : {}),
    secretEnv: () => ["XAI_API_KEY", ...(o.custom ? [o.custom.envKey] : [])],
    // Grok imports MCP servers from ~/.claude.json and ~/.cursor/mcp.json by default (measured with `grok inspect`, 1.0.46: the person's Claude
    // servers, claude.ai-style connectors included, appeared under "MCP Servers"). A Vyre session gets Vyre's own server and nothing imported.
    // Still loaded, and not switchable from here: servers of Claude plugins under ~/.claude/plugins and a project's own .mcp.json.
    env: run => ({ ...(o.home || run.home ? { HOME: String(o.home || run.home) } : {}), GROK_CLAUDE_MCPS_ENABLED: "0", GROK_CURSOR_MCPS_ENABLED: "0" }),
    // MEASURED on Grok Build 1.0.44 (scripts/provider-wire-proof.mjs): with no login session/new answers "Authentication required"
    // (-32000) and initialize offers grok.com (the stored browser login: authenticate waits for a browser when there is none, which
    // the driver reports as "sign this account in first"). With a config.toml that names a model's base_url and env_key, session/new
    // works with no login at all, xai.api_key is offered too, and a real turn ran end to end against a local stand-in.
    authMethod: (methods, run) => {
      const has = id => methods.some(m => m.id === id);
      const env = (run && run.env) || {};
      if (has("xai.api_key") && (env.XAI_API_KEY || o.custom)) return "xai.api_key";
      return has("grok.com") ? "grok.com" : null;
    },
    // Grok Build 1.0.50 says promptCapabilities.image is false in initialize, yet answers an ACP image block (and a resource blob) correctly: a 4729 picture read back as 4729 (10 Oct, live,
    // team/0.3.1/LIVE-PROVIDERS.md). Without this, the driver withheld every picture from it.
    takesImages: true,
    capabilities: { steering: false, usage: "coarse", rewind: false },
    ...(o.floor ? { floor: o.floor } : {}),
    ...(o.sessions ? { sessions: o.sessions } : {}),
  });
}
