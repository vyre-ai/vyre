// @ts-check
// `vyre wink reset`: free a server that still belongs to an app that cannot let go of it (the app was lost, or the server was off when it was
// removed). It runs on the server itself, in a terminal, and is two steps (core/wink/reset.js has the why):
//
//   vyre wink reset --begin           makes a one-time code, shows it on this terminal only, and tells the daemon only its hash (5 minutes, once)
//   vyre wink reset --confirm <code>  frees the server when the code matches; five wrong codes lock it for an hour
//
// Both need a terminal (stdin and stdout): the model's own shell has none. The code is never in --json output. Exit 3 without a terminal, 1 for a refusal.

import readline from "node:readline/promises";
import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, bold } from "../style.js";
import { json, emit, fail, failTool, usage, EXIT } from "../kit.js";
import { newCode, beginInput } from "../../wink/reset.js";

const USAGE = "vyre wink reset --begin | --confirm <code> [--json]";

/** @returns {{ call: typeof call, ensureUp: typeof ensureUp, isTTY: boolean, write: (s: string) => void, ask: (q: string) => Promise<string>, newCode: () => string }} */
export const realDeps = () => ({
  call, ensureUp, isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write: s => { process.stdout.write(s); },
  ask: async q => { const rl = readline.createInterface({ input: process.stdin, output: process.stderr }); try { return await rl.question(q); } finally { rl.close(); } },
  newCode: () => newCode(),
});

/** @param {string[]} args @param {ReturnType<typeof realDeps>} [deps] */
export async function run(args, deps = realDeps()) {
  const flags = args.filter(a => a.startsWith("--") && a !== "--json");
  const pos = args.filter(a => !a.startsWith("--"));
  const begin = flags.includes("--begin"), confirm = flags.includes("--confirm");
  if (pos[0] !== "reset" || begin === confirm || pos.length > 2 || (begin && pos.length > 1) || flags.length > 1) return usage("vyre wink reset takes --begin or --confirm <code>", USAGE);
  if (!deps.isTTY) return fail("this needs a person at a terminal on the server", { code: "no_terminal", exit: EXIT.PRESENCE, next: "run it in your own terminal on the server" });
  const r0 = await deps.ensureUp();
  if (!r0.ok) return fail("vyred did not start", { code: "unreachable", exit: 5, next: `its output is in ${r0.log}` });
  if (begin) {
    const code = deps.newCode();
    const r = await deps.call("wink.server.reset.begin", beginInput(code));
    if (r.error) return failTool(r.error);
    // The code goes to this terminal and nowhere else: not to --json, not to the daemon, not to a log.
    deps.write(`\n  Reset code: ${code}\n\n`);
    if (json()) return emit({ begun: true, until: r.data.until }, { kind: "card", title: "Reset started", state: "ok", fields: [{ label: "Valid for", value: "5 minutes" }] });
    out(`  Valid for 5 minutes, once. Finish with: ${bold("vyre wink reset --confirm <code>")}`);
    out(dim("  This frees the server from its owner. Its keys stay, and so does everything stored on it (its vault and sealed values): the next owner can reach that. Reset a server you mean to hand over empty."));
    return 0;
  }
  let code = pos[1] ? String(pos[1]) : "";
  if (!code) code = await deps.ask("  Type the reset code: ");
  const r = await deps.call("wink.server.reset.confirm", { code });
  if (r.error) return failTool(r.error);
  if (json()) return emit(r.data, { kind: "card", title: "Server freed", state: "ok", fields: [{ label: "Had an owner", value: r.data.had ? "yes" : "no" }] });
  out(r.data.had ? "  This server let go of its owner. It can be added again." : "  This server had no owner. It can be added.");
  out(dim("  Add it from the app with its code."));
  return 0;
}

export default {
  name: "wink", order: 47, usage: USAGE,
  verbs: [
    { verb: "reset", summary: "free this server so it can be added again (two steps, at its own terminal)", usage: "--begin | --confirm <code>", person: true },
  ],
  summary: "free a server that still belongs to an app you no longer have",
  help: "vyre wink reset --begin: run on the server, in a terminal. It shows a one-time code (5 minutes, once) on that terminal only. Then vyre wink reset --confirm <code> frees the server: it forgets its owner and can be paired again. Its keys stay. Five wrong codes lock it for an hour.",
  /** @param {string[]} args */
  run: args => run(args),
};
