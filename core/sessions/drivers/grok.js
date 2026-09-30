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

/**
 * @param {{ bin?: string, home?: string, floor?: (call: any) => any, sessions?: any }} [o]
 *   home: the HOME of the account the session runs as (core/sessions/accounts.js), never the person's own
 */
export function grokProvider(o = {}) {
  return acpProvider({
    id: "grok",
    bin: o.bin || "grok",
    args: () => ["--no-auto-update", "agent", "stdio"],
    env: run => ({ ...(o.home || run.home ? { HOME: String(o.home || run.home) } : {}) }),
    capabilities: { steering: false, usage: "coarse", rewind: false },
    ...(o.floor ? { floor: o.floor } : {}),
    ...(o.sessions ? { sessions: o.sessions } : {}),
  });
}
