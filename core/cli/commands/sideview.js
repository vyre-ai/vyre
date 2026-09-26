// @ts-check
// `vyre sideview`: a session on the left, Chrome filling the rest (local/sideview).
//
//   vyre sideview [open]  [--glass [name]] [--url U] [--ratio R] [--terminal]
//   vyre sideview close   put the windows back where they were
//   vyre sideview status

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim, beacon } from "../style.js";

const box = (/** @type {any} */ f) => `${f.w}x${f.h} at ${f.x},${f.y}`;

/** @param {string[]} args */
function parse(args) {
  const input = /** @type {any} */ ({});
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--glass") { input.browser = "glass"; if (args[i + 1] && !args[i + 1].startsWith("--")) input.glass = args[++i]; }
    else if (a === "--url") input.url = args[++i] ?? "";
    else if (a === "--ratio") input.ratio = Number(args[++i]);
    else if (a === "--terminal") input.session = "terminal";
  }
  return input;
}

export default {
  name: "sideview", order: 60, usage: "vyre sideview [close|status]", summary: "this session on the left, Chrome filling the rest",
  /** @param {string[]} args */
  async run(args) {
    const verb = args[0] && !args[0].startsWith("--") ? args[0] : "open";
    if (!["open", "close", "status"].includes(verb)) { out("  vyre sideview [open|close|status] [--glass [name]] [--url U] [--ratio R] [--terminal]"); return 1; }
    const up = await ensureUp();
    if (!up.ok) { out(beacon("  vyred did not start") + dim(` · its output is in ${up.log}`)); return 1; }
    const r = await call(`sideview.${verb}`, verb === "open" ? parse(args.slice(args[0] === "open" ? 1 : 0)) : {});
    if (r.error) { out(beacon(`  ${r.error.code}: `) + r.error.message); return 1; }
    const d = r.data;
    if (verb === "close") { out(`  put back ${d.restored} window${d.restored === 1 ? "" : "s"}`); return 0; }
    if (!d.open) { out(dim("  the side view is not open")); return 0; }
    out(`  ${d.left.app} ${dim(box(d.left.frame))}  |  ${d.right.app} ${dim(box(d.right.frame))}`);
    if (verb === "open" && d.exact === false) out(dim("  one window kept a size of its own; the other was fitted beside it"));
    if (verb === "open") out(dim("  vyre sideview close to put them back"));
    return 0;
  },
};
