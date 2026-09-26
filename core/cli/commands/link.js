// @ts-check
// `vyre link`: the Mac and the box as one system.
//
//   vyre link                   on the Mac: paired or not, and whether the box answers;
//                               on the box: paired Macs and waiting requests
//   vyre link pair <address>    on the Mac: start pairing, and show the code to approve on the box
//   vyre link approve <code>    on the box: approve the Mac showing that code
//   vyre link deny <id>         on the box: refuse a request
//   vyre link unpair [id]       forget the box (on the Mac) or a Mac (on the box)

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";

const unreachable = r => r.error && ["unreachable", "timeout"].includes(r.error.code);
const fail = r => { out(unreachable(r) ? `  vyred is not running ${dim("· vyre up to start it")}` : beacon(`  ${r.error.code}: `) + r.error.message); return 1; };
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

async function status() {
  const r = await call("link.status");
  if (r.error) return fail(r);
  const s = r.data;
  if (s.role === "box") {
    out(`  ${bold(String(s.peers))} paired Mac${s.peers === 1 ? "" : "s"} · ${s.pending} waiting`);
    const p = await call("link.pending");
    for (const q of (p.data || [])) out(`  ${beacon("?")} ${q.name} ${dim(`${q.login}${q.node ? " · " + q.node : ""} · id ${q.id}`)}\n    ${dim("vyre link approve <the code on that Mac>")}`);
    const peers = await call("link.peers");
    for (const m of (peers.data || [])) out(`  ${signal("·")} ${m.name} ${dim(`${m.node || ""} · paired ${ago(m.paired_at)}${m.last_seen ? " · seen " + ago(m.last_seen) : ""} · id ${m.id}`)}`);
    return 0;
  }
  if (s.pending) out(`  waiting for approval on the box: ${bold(s.pending.code)} ${dim("· on the box, vyre link approve " + s.pending.code)}`);
  if (!s.linked) { out(`  not paired with a box${s.error ? dim(" · " + s.error) : ""} ${dim("· vyre link pair <address>")}`); return 0; }
  const where = `${s.box.name || s.box.address}${s.box.node ? dim(" · " + s.box.node) : ""}`;
  out(s.reachable ? `  ${signal("●")} linked to ${where}` : `  ${beacon("○")} linked to ${where}, not reachable now${s.error ? dim(" · " + s.error) : ""}`);
  return 0;
}

export default {
  name: "link", order: 45, usage: "vyre link [pair|approve|deny|unpair]", summary: "pair this Mac with your box, or approve a Mac on the box",
  async run(args) {
    const [sub, arg] = args;
    if (!sub) return status();
    if (sub === "pair") {
      if (!arg) { out("  vyre link pair <your box's address>"); return 1; }
      const r = await call("link.pair", { box: arg });
      if (r.error) return fail(r);
      out(`  on the box, approve with:  ${bold("vyre link approve " + r.data.code)}`);
      out(dim(`  or approve it in the Deck from another device. The code expires in ${Math.round((r.data.expires - Date.now()) / 60000)} minutes.`));
      return 0;
    }
    if (sub === "approve") {
      if (!arg) { out("  vyre link approve <the code the Mac shows>"); return 1; }
      const r = await call("link.pair.approve", { code: arg });
      if (r.error) return fail(r);
      out(`  ${signal("●")} paired with ${bold(r.data.name)}`);
      return 0;
    }
    if (sub === "deny") {
      const r = await call("link.pair.deny", { id: String(arg || "") });
      if (r.error) return fail(r);
      out("  refused");
      return 0;
    }
    if (sub === "unpair") {
      const r = await call("link.unpair", arg ? { id: arg } : {});
      if (r.error) return fail(r);
      out(r.data.unpaired ? "  unpaired" : "  was not paired");
      return 0;
    }
    out("  vyre link [pair <address>|approve <code>|deny <id>|unpair [id]]");
    return 1;
  },
};
