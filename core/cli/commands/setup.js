// @ts-check
// `vyre setup`: the way back into setup (#11): `sudo vyre setup` prints where setup stands, in the same ten steps the page draws, read from the list the
// box holds (onboard.setup), and the one place to continue. `--new-link` makes a fresh one-time link to carry on from if the page was closed.
// A server holds no name (spec 0.3.0 part 10): there is no `--name` here any more; a space's name is made in the app, and the app tells the server to serve it.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";
import { setupLines } from "../../../lib/setup-steps.js";

/** Where setup stands, from the box's own list, and with --new-link a fresh one-time link to carry on from. @param {boolean} newLink */
async function where(newLink) {
  const r = await call("onboard.setup", {});
  if (r.error) return failTool(r.error);
  const d = r.data;
  const link = newLink ? await call("onboard.link", {}) : null;
  if (link && link.error) return failTool(link.error);
  if (json()) return emit({ ...d, ...(link ? { link: link.data } : {}) });
  const l = link && link.data ? link.data : null;
  const notes = d.address ? { address: String(d.address).replace(/^https?:\/\//, "") } : {};
  for (const line of setupLines(d, { address: d.address || null, notes })) out(`  ${line}`);
  if (l && (l.url || l.passkeyUrl)) { out(""); out(`  New link: ${signal(l.url || l.passkeyUrl)}`); if (l.port) out(dim(`  It opens on this machine only (port ${l.port}); one use, and it expires.`)); }
  else if (newLink) out(dim("  This box has no one-time link to give any more: open its address."));
  return 0;
}

export default [
  {
    name: "setup", order: 29, usage: "vyre setup [--new-link] [--json]", summary: "where setup stands and where to continue (--new-link: a fresh link)",
    async run(args) {
      const rest = args.filter(a => a !== "--json");
      const extra = rest.filter(a => a !== "--new-link");
      if (extra.length) return usage(`vyre setup: unknown option ${extra[0]}`, "vyre setup  (or: vyre setup --new-link)");
      return where(rest.includes("--new-link"));
    },
  },
];
