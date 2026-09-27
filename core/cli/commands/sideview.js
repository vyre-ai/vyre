// @ts-check
// `vyre sideview`: a session on the left, Chrome filling the rest (local/sideview).
//
//   vyre sideview [open]  [--glass [name]] [--url U] [--ratio R] [--terminal]
//   vyre sideview close   put the windows back where they were
//   vyre sideview status  what is open, without starting vyred
//
// --json prints the tool's reply: open and status { open, left?, right?, exact? }, close
// { restored }.

import { call } from "../../daemon/client.js";
import { ensureUp } from "../daemonctl.js";
import { out, dim } from "../style.js";
import { json, emit, fail, failTool, usage } from "../kit.js";

const box = (/** @type {any} */ f) => `${f.w}x${f.h} at ${f.x},${f.y}`;

const USAGE = "vyre sideview [open|close|status] [--glass [name]] [--url U] [--ratio R] [--terminal] [--json]";

/** Every verb run() handles, for `vyre commands --json`; run() refuses any other word. */
export const VERBS = [
  { verb: "open", summary: "this session on the left, Chrome (or Glass) filling the rest (the default)", usage: "[--glass [name]] [--url <url>] [--ratio <r>] [--terminal] [--json]" },
  { verb: "close", summary: "put the windows back where they were", usage: "[--json]" },
  { verb: "status", summary: "what the side view has open", usage: "[--json]", read: true },
];

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

/** The side view as a card: each half and where it sits. @param {any} d */
export function card(d) {
  if (!d.open) return { kind: "text", lines: ["The side view is not open"] };
  return { kind: "card", title: "Side view", state: "open", fields: [
    { label: "Left", value: `${d.left.app} · ${box(d.left.frame)}` }, { label: "Right", value: `${d.right.app} · ${box(d.right.frame)}` }] };
}

export default {
  name: "sideview", order: 60, usage: USAGE, summary: "this session on the left, Chrome filling the rest",
  verbs: VERBS,
  /** @param {string[]} args */
  async run(args) {
    const words = args.filter(a => a !== "--json");
    const verb = words[0] && !words[0].startsWith("--") ? words[0] : "open";
    if (!VERBS.some(v => v.verb === verb)) return usage(`vyre sideview ${verb}: not a verb`, USAGE);
    // A read never starts vyred for itself; open and close do, since they are why it runs.
    if (verb !== "status") {
      const up = await ensureUp();
      if (!up.ok) return fail("vyred did not start", { code: "unreachable", exit: 5, next: `its output is in ${up.log}` });
    }
    const r = await call(`sideview.${verb}`, verb === "open" ? parse(words.slice(words[0] === "open" ? 1 : 0)) : {});
    if (r.error) return failTool(r.error);
    const d = r.data;
    if (json()) return emit(d, verb === "close" ? { kind: "text", lines: [`Put back ${d.restored} window${d.restored === 1 ? "" : "s"}`] } : card(d));
    if (verb === "close") { out(`  put back ${d.restored} window${d.restored === 1 ? "" : "s"}`); return 0; }
    if (!d.open) { out(dim("  the side view is not open")); return 0; }
    out(`  ${d.left.app} ${dim(box(d.left.frame))}  |  ${d.right.app} ${dim(box(d.right.frame))}`);
    if (verb === "open" && d.exact === false) out(dim("  one window kept a size of its own; the other was fitted beside it"));
    if (verb === "open") out(dim("  vyre sideview close to put them back"));
    return 0;
  },
};
