// @ts-check
// `vyre wink reset`: free a server that still belongs to an app that cannot let go of it (the app was lost, or the server was off when it was
// removed). It runs on the server itself, as the person at its command line, and asks for the server's own short fingerprint typed back: there is
// no passkey on a headless box, so the typing is the confirmation. wink.server.reset refuses every other caller and every agent.
//
// --json shape: reset {reset, had}. A wrong fingerprint or any other refusal exits 1.

import readline from "node:readline/promises";
import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, bold } from "../style.js";
import { json, emit, fail, failTool, usage } from "../kit.js";

const USAGE = "vyre wink reset [<fingerprint>] [--json]";

export default {
  name: "wink", order: 47, usage: USAGE,
  verbs: [
    { verb: "reset", summary: "free this server so it can be added again (type its fingerprint)", usage: "[<fingerprint>]", person: true },
  ],
  summary: "free a server that still belongs to an app you no longer have",
  help: "vyre wink reset: run on the server. It shows the server's short fingerprint and asks you to type it back; then the server forgets its owner and can be paired again. Its keys stay.",
  /** @param {string[]} args */
  async run(args) {
    const pos = args.filter(a => !a.startsWith("--"));
    const [verb, given] = pos;
    if (verb !== "reset" || pos.length > 2) return usage("vyre wink reset is the only wink command here", USAGE);
    const r0 = await ensureUp();
    if (!r0.ok) return fail("vyred did not start", { code: "unreachable", exit: 5, next: `its output is in ${r0.log}` });
    const fp = await call("wink.server.fingerprint");
    if (fp.error) return failTool(fp.error);
    let typed = given ? String(given) : "";
    if (!typed) {
      if (!process.stdin.isTTY) return usage("type the server's fingerprint to confirm", `${fp.data.fingerprint} is its fingerprint: vyre wink reset ${fp.data.fingerprint}`);
      out(`  This frees the server from ${fp.data.owned ? "the app that owns it" : "its owner"}. Its keys stay and it can be added again.`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      try { typed = await rl.question(`  Type its fingerprint ${bold(fp.data.fingerprint)} to confirm: `); } finally { rl.close(); }
    }
    const r = await call("wink.server.reset", { fingerprint: typed });
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data, { kind: "card", title: "Server freed", state: "ok", fields: [{ label: "Had an owner", value: r.data.had ? "yes" : "no" }] });
    out(r.data.had ? "  This server let go of its owner. It can be added again." : "  This server had no owner. It can be added.");
    out(dim("  Add it from the app with its code."));
    return 0;
  },
};
