// @ts-check
// `vyre link`: this device and its server, over Wink.
//
//   vyre link                      the server this device is paired to and how it is reached now (direct, or through the relay)
//   vyre link pair <code>          pair a server by the code it printed (a typed WINK code, or the long code); the person at the server confirms the three words
//   vyre link devices              your devices and storage: each with its kind
//   vyre link unpair <device>      take one of your devices back
//
// --json shapes: status {linked, server?, servers, network?} · pair {pairing, ack?, state} · devices {devices} · unpair {removed}.

import { call } from "../../daemon/client.js";
import { out, dim, bold, signal, beacon } from "../style.js";
import { json, emit, fail as failWith, failTool, usage } from "../kit.js";

const fail = r => failTool(r.error);
const USAGE = "vyre link [status|pair <code>|devices|unpair <device>] [--json]";

async function status() {
  const home = await call("wink.server.home");
  if (home.error) return fail(home);
  const net = await call("network.wink.status");
  const spaces = net.data && Array.isArray(net.data.spaces) ? net.data.spaces : [];
  const h = home.data;
  if (json()) {
    return emit({ ...h, ...(net.data ? { network: net.data } : {}) }, { kind: "card", title: "Link", state: h.linked ? "ok" : "wait", fields: [
      { label: "Server", value: h.linked ? String(h.server.name || h.server.id) : "not paired" },
      ...(h.linked ? [{ label: "Reached", value: spaces.map(s => `${s.name || s.id}: ${s.state}${s.path ? ` (${s.path})` : ""}`).join(", ") || "not known" }] : [])] });
  }
  if (!h.linked) { out(`  not paired with a server ${dim("· vyre link pair <code>")}`); return 0; }
  out(`  ${signal("●")} paired with ${bold(String(h.server.name || h.server.id))}`);
  for (const s of spaces) out(`  ${s.state === "connected" || s.state === "relayed" ? signal("·") : beacon("○")} ${s.name || s.id} ${dim(`${s.state}${s.path ? " · " + s.path : ""}`)}`);
  return 0;
}

export default {
  name: "link", order: 45, usage: USAGE, summary: "this device and its server: pair a server, see how it is reached, list or remove your devices",
  verbs: [
    { verb: "status", summary: "the server this device is paired to and how it is reached now", usage: "", read: true },
    { verb: "pair", summary: "pair a server by the code it printed; the person at the server confirms the three words", usage: "<code>", person: true },
    { verb: "devices", summary: "your devices and storage, each with its kind", usage: "", read: true },
    { verb: "unpair", summary: "take one of your devices back", usage: "<device>", person: true },
  ],
  async run(args) {
    const [sub, arg] = args.filter(a => a !== "--json");
    if (!sub || sub === "status") return status();
    if (sub === "pair") {
      if (!arg) return usage("vyre link pair needs the code the server printed", "vyre link pair <code>, e.g. vyre link pair WINK-1234-5678");
      const t = await call("wink.pair.targets");
      if (t.error) return fail(t);
      const target = (t.data.targets || []).find(x => x.kind === "identity");
      if (!target) return failWith("this device has no identity to pair a server to", { code: "no_identity", exit: 1, next: "open the Vyre app and make or claim your name first" });
      const typed = /^WINK-/i.test(arg);
      const r = await call("wink.pair.server", { ...(typed ? { code: arg } : { payload: arg }), target: { kind: "identity", id: target.id } });
      if (r.error) return fail(r);
      if (json()) return emit(r.data, { kind: "card", title: "Confirm at the server", state: "wait", fields: [{ label: "Pairing", value: String(r.data.pairing) }, ...(r.data.ack ? [{ label: "Type at the server", value: String(r.data.ack) }] : [])] });
      out(`  pairing started ${dim("· the person at the server confirms the three words it shows")}`);
      if (r.data.ack) out(`  type this at the server: ${bold(String(r.data.ack))}`);
      return 0;
    }
    if (sub === "devices") {
      const r = await call("wink.access");
      if (r.error) return fail(r);
      const devices = (r.data && r.data.devices) || [];
      if (json()) return emit({ devices }, { kind: "table", title: `${devices.length} device${devices.length === 1 ? "" : "s"}`, empty: "No devices yet",
        columns: [{ key: "name", label: "Name" }, { key: "kind", label: "Kind" }, { key: "id", label: "Id" }], rows: devices });
      for (const d of devices) out(`  ${signal("·")} ${d.name} ${dim(`${d.kind} · id ${d.id}`)}`);
      if (!devices.length) out("  no devices yet");
      return 0;
    }
    if (sub === "unpair") {
      if (!arg) return usage("vyre link unpair needs the device's id", "vyre link unpair <device>; vyre link devices lists them");
      const r = await call("wink.remove", { device: arg });
      if (r.error) return fail(r);
      if (json()) return emit(r.data);
      out("  removed");
      return 0;
    }
    return usage(`vyre link ${sub}: not a subcommand`, USAGE.replace(" [--json]", ""));
  },
};
