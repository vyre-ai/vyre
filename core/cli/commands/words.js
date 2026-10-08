// @ts-check
// `vyre words`: the four words this server shows while the Vyre app is adding it, for the person to compare with the app's four.
// The installer prints them itself; this is for when they scrolled away or did not show.

import { call } from "../../daemon/client.js";
import { out, bold, dim } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

export default {
  name: "words", order: 40, usage: "vyre words [--json]",
  summary: "the four words to compare with the Vyre app while it adds this server",
  verbs: [],
  help: [
    "While the Vyre app is adding this server, the server and the app each show four words.",
    "If they are the same, choose Same in the app. This prints the server's four.",
  ].join("\n"),
  /** @param {string[]} args */
  async run(args) {
    const extra = args.filter(a => a !== "--json");
    if (extra.length) return usage(`vyre words takes no arguments (got ${extra[0]})`, "vyre words, or vyre words --json");
    const r = await call("relay.setup.status", {});
    if (r.error) return failTool(r.error);
    const words = typeof r.data?.words === "string" ? r.data.words : "";
    if (json()) return emit({ words: words || null }, words ? `Your four words: ${words}` : "No server is being added right now.");
    if (!words) { out(dim("  No server is being added right now. In the Vyre app, choose Add a server and run the line it shows.")); return 1; }
    out(`  Your four words: ${bold(words)}`);
    out(dim("  Go back to the Vyre app. If it shows the same four, choose Same."));
    return 0;
  },
};
