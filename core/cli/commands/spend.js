// @ts-check
// `vyre spend`: what agents, sessions and memory spent today, and each provider's daily cap (core/spend).
//
//   vyre spend                          today's spend per provider against its cap
//   vyre spend raise <provider> <usd>   set the cap to that many dollars
//   vyre spend raise <provider> +<usd>  add to the cap
//   vyre spend raise <provider> off     no cap
//   (provider "all" is the cap over every provider together)

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, beacon } from "../style.js";
import { json, emit, failTool, UsageError } from "../kit.js";

const usd = (/** @type {number} */ n) => `$${n.toFixed(2)}`;

export default {
  name: "spend", order: 60, usage: "vyre spend [raise <provider> <usd|+usd|off>] [--json]", summary: "today's spend per provider and its daily cap",
  help: "Read it:\n  vyre spend                          today's spend (UTC) per provider against its cap\nChange a cap:\n  vyre spend raise <provider> <usd>   set the cap in dollars (provider all: every provider together)\n  vyre spend raise <provider> +<usd>  add to it\n  vyre spend raise <provider> off     no cap\nAt a cap the spending thread pauses with one line, and Vyre Memory answers from facts and search.",
  /** @param {string[]} args */
  async run(args) {
    const words = args.filter(a => !a.startsWith("--"));
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  Vyre did not start") + dim(` · its output is in ${up.log}`)); return 1; }
    if (words[0] === "raise") {
      const [, provider, amount] = words;
      if (!provider || !amount) throw new UsageError("vyre spend raise <provider> <usd|+usd|off>");
      const input = amount === "off" ? { provider, off: true }
        : /^\+\d+(\.\d+)?$/.test(amount) ? { provider, by: Number(amount.slice(1)) }
        : /^\$?\d+(\.\d+)?$/.test(amount) ? { provider, to: Number(amount.replace("$", "")) }
        : null;
      if (!input) throw new UsageError("the amount is dollars (20), +dollars (+5) or off");
      const r = await call("spend.raise", input);
      if (r.error) return failTool(r.error);
      if (json()) return emit(r.data);
      out(r.data.cap == null ? `  ${provider} has no daily cap` : `  ${provider} daily cap is ${usd(r.data.cap)} (spent ${usd(r.data.spent)} today)`);
      return 0;
    }
    const r = await call("spend.summary", {});
    if (r.error) return failTool(r.error);
    if (json()) return emit(r.data);
    if (!r.data.providers.length && r.data.all.cap == null) { out(dim(`  nothing spent yet on ${r.data.day} (UTC)`)); return 0; }
    if (r.data.all.cap != null) { const l = `  ${"all".padEnd(8)} ${usd(r.data.all.spent)} of ${usd(r.data.all.cap)}${r.data.all.capped ? "  at the cap" : ""}`; out(r.data.all.capped ? beacon(l) : l); }
    for (const p of r.data.providers) {
      const line = `  ${p.provider.padEnd(8)} ${usd(p.spent)}${p.cap == null ? dim("  no cap") : ` of ${usd(p.cap)}${p.capped ? "  at the cap" : ""}`}${p.estimated ? dim("  (estimated)") : ""}`;
      out(p.capped ? beacon(line) : line);
    }
    return 0;
  },
};
