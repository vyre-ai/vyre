// @ts-check
// `vyre tips`: the tips Vyre's modules ship (core/tips), read in the terminal.
//
//   vyre tips [module]   every tip, or one module's, with what was shown or dismissed
//   vyre tips new        what came with the last update
//   vyre tips reset      bring every tip back

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, beacon } from "../style.js";
import { json, emit, failTool } from "../kit.js";

/** "Run `vyre agenda` ..." with the backticks dropped for a terminal line. @param {string} s */
const plain = s => s.replace(/`([^`]*)`/g, "$1");

export default {
  name: "tips", order: 85, usage: "vyre tips [module | new | reset] [--json]", summary: "short tips on using each part of Vyre",
  /** @param {string[]} args */
  async run(args) {
    const words = args.filter(a => !a.startsWith("--"));
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  vyred did not start") + dim(` · its output is in ${up.log}`)); return 1; }
    if (words[0] === "reset") {
      const r = await call("tips.reset", {});
      if (r.error) return failTool(r.error);
      if (json()) return emit(r.data);
      out("  every tip is back");
      return 0;
    }
    if (words[0] === "new") {
      const r = await call("tips.whatsnew", { surface: "cli", ack: true });
      if (r.error) return failTool(r.error);
      if (json()) return emit(r.data);
      if (!r.data.tips.length) { out(dim(`  nothing new since ${r.data.from || r.data.version}`)); return 0; }
      out(`  New in ${r.data.version}`);
      for (const t of r.data.tips) out(`  ${plain(t.text)}`);
      return 0;
    }
    const r = await call("tips.list", words[0] ? { module: words[0] } : {});
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    if (!r.data.tips.length) { out(dim(words[0] ? `  no tips about ${words[0]}` : "  no tips yet")); return 0; }
    let last = "";
    for (const t of r.data.tips) {
      if (t.about !== last) { out(`\n  ${t.about}`); last = t.about; }
      const line = `    ${plain(t.text)}`;
      out(t.dismissed ? dim(line + "  (done)") : line);
    }
    return 0;
  },
};
