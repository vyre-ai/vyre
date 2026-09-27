// @ts-check
// `vyre link`: the Mac and the box as one system.
//
//   vyre link                   on the Mac: paired or not, and whether the box answers;
//                               on the box: paired Macs and waiting requests
//   vyre link pair <address>    on the Mac: start pairing, and show the code to approve in the Deck
//   vyre link approve <code>    on the box: approve the Mac showing that code. On a box this needs
//                               the owner's passkey, which only the Deck can give, so this points
//                               there when the passkey is missing (docs/adr/0004-presence.md)
//   vyre link deny <id>         on the box: refuse a request
//   vyre link unpair [id]       forget the box (on the Mac) or a Mac (on the box)

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, failTool, usage } from "../kit.js";

const fail = r => failTool(r.error);
const ago = ms => { const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };

async function status() {
  const r = await call("link.status");
  if (r.error) return fail(r);
  const s = r.data;
  if (json()) {
    if (s.role !== "box") return emit(s);
    const [p, peers] = await Promise.all([call("link.pending"), call("link.peers")]);
    return emit({ ...s, waiting: p.data || [], macs: peers.data || [] });
  }
  if (s.role === "box") {
    out(`  ${bold(String(s.peers))} paired Mac${s.peers === 1 ? "" : "s"} · ${s.pending} waiting`);
    const p = await call("link.pending");
    for (const q of (p.data || [])) out(`  ${beacon("?")} ${q.name} ${dim(`${q.login}${q.node ? " · " + q.node : ""} · id ${q.id}`)}\n    ${dim("approve it in the Deck, on that Mac or your phone, with the code it shows")}`);
    const peers = await call("link.peers");
    for (const m of (peers.data || [])) out(`  ${signal("·")} ${m.name} ${dim(`${m.node || ""} · paired ${ago(m.paired_at)}${m.last_seen ? " · seen " + ago(m.last_seen) : ""} · id ${m.id}`)}`);
    return 0;
  }
  if (s.pending) out(`  waiting for approval: ${bold(s.pending.code)} ${dim("· approve it in the Deck, on this Mac or your phone, with your passkey")}`);
  if (!s.linked) { out(`  not paired with a box${s.error ? dim(" · " + s.error) : ""} ${dim("· vyre link pair <address>")}`); return 0; }
  const where = `${s.box.name || s.box.address}${s.box.node ? dim(" · " + s.box.node) : ""}`;
  out(s.reachable ? `  ${signal("●")} linked to ${where}` : `  ${beacon("○")} linked to ${where}, not reachable now${s.error ? dim(" · " + s.error) : ""}`);
  return 0;
}

export default {
  name: "link", order: 45, usage: "vyre link [pair|approve|deny|unpair] [--json]", summary: "pair this Mac with your box, or approve a Mac on the box",
  async run(args) {
    const [sub, arg] = args.filter(a => a !== "--json");
    if (!sub) return status();
    if (sub === "pair") {
      if (!arg) return usage("vyre link pair needs your box's address", "vyre link pair <address>, e.g. vyre link pair alex.vyre.run");
      const r = await call("link.pair", { box: arg });
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out(`  approve this Mac in the Deck, on this Mac or your phone, with the code  ${bold(r.data.code)}`);
      out(dim(`  The Deck names this Mac and asks for your passkey. The code expires in ${Math.round((r.data.expires - Date.now()) / 60000)} minutes.`));
      return 0;
    }
    if (sub === "approve") {
      if (!arg) return usage("vyre link approve needs the code the Mac shows", "vyre link approve <code>, or approve it in the Deck");
      const r = await call("link.pair.approve", { code: arg });
      // A terminal is not proof the owner is here (a model can ssh in with the code), so the box
      // asks for a passkey, and only the Deck can give one.
      if (r.error && r.error.code === "presence_required") {
        out(`  approve it in the Deck, on that Mac or your phone: it names the Mac asking and asks for your passkey ${dim("(the code is " + arg + ")")}`);
        return 3;
      }
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
    return usage(`vyre link ${sub}: not a subcommand`, "vyre link [pair <address>|approve <code>|deny <id>|unpair [id]]");
  },
};
